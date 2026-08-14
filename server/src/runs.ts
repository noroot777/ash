// Registry of in-flight agent subprocesses, keyed by task, so a running task can
// be killed on demand (manual stop / group pause) — the orchestrator/duet
// register each live run here and the /stop API calls stopTask. A `stopping` map
// lets the run loops distinguish a requested kill from a crash (→ failed), AND
// carries how the kill should settle: a manual stop settles `canceled`(可跳过),
// a group pause settles `paused`(恢复分组时从原会话续跑,而不是被队列跳过)。

export interface Killable {
  kill(): void;
}

// 被杀回合的结算落位:手动停 → canceled(队列把它当离队);分组暂停 → paused
// (队列 head 停在它身上,恢复分组时先续跑它,再轮到后面的)。
export type StopSettle = "canceled" | "paused";

const handles = new Map<string, Set<Killable>>();
const stopping = new Map<string, StopSettle>();
// 「回合已占位、进程还没起来」时收到的冻结请求。这一段窗口里 `handles` 是空的、
// `tasks.status` 也可能还停在上一轮的终态 —— 只有回合锁看得见它，所以分组暂停既杀不到
// 也拦不住（第 1 轮审查 finding 1：pause 已经 200 返回，重试仍把 CLI 拉起来了）。
// 记在这里，由起跑前的最后一道闸在 spawn 之前消费（turn-freeze.ts）。
const startFreeze = new Map<string, StopSettle>();

export function trackRun(taskId: string, h: Killable): void {
  let set = handles.get(taskId);
  if (!set) handles.set(taskId, (set = new Set()));
  set.add(h);
}

export function untrackRun(taskId: string, h: Killable): void {
  const set = handles.get(taskId);
  if (!set) return;
  set.delete(h);
  if (!set.size) handles.delete(taskId);
}

// True if the task has at least one live subprocess (i.e. it can be stopped).
export function isRunning(taskId: string): boolean {
  return (handles.get(taskId)?.size ?? 0) > 0;
}

// Request a stop: flag how the kill should settle and kill the live
// subprocess(es). Returns false if nothing was running (nothing to stop).
export function stopTask(taskId: string, settle: StopSettle = "canceled"): boolean {
  const set = handles.get(taskId);
  if (!set || !set.size) return false;
  stopping.set(taskId, settle);
  for (const h of set) {
    try {
      h.kill();
    } catch {
      /* best effort */
    }
  }
  return true;
}

export function isCanceling(taskId: string): boolean {
  return stopping.has(taskId);
}

/**
 * 冻结一个**正在起跑**的回合：已 claim、还没 spawn，所以没有 handle 可杀。
 * 返回 false = 这个任务根本没有回合在起跑（调用方无事可做）。
 *
 * 标记只对当前这一回合有效：回合退出时由 releaseTurn 清掉，绝不留给下一轮
 * （留下来就是「下一次运行刚起跑就被上一次的暂停冻掉」）。
 */
export function freezeStartingTurn(taskId: string, settle: StopSettle = "paused"): boolean {
  if (!turns.has(taskId)) return false;
  startFreeze.set(taskId, settle);
  return true;
}

/** 起跑前的最后一道闸消费它：非 null = 这一轮必须在 spawn 之前撤回，并按这个落位结算。 */
export function takeStartFreeze(taskId: string): StopSettle | null {
  const s = startFreeze.get(taskId) ?? null;
  startFreeze.delete(taskId);
  return s;
}

/** 把「这一轮是被停的」记下来，供本回合的结算读取（撤回起跑用；杀进程走 stopTask）。 */
export function markStopped(taskId: string, settle: StopSettle): void {
  stopping.set(taskId, settle);
}

// Check-and-clear: the run loop calls this after a kill to decide how to settle
// (canceled / paused / not-stopped), consuming the flag so a later run isn't
// wrongly settled.
export function takeStopped(taskId: string): StopSettle | null {
  const s = stopping.get(taskId) ?? null;
  stopping.delete(taskId);
  return s;
}

// 兼容旧语义(duet 用):是否被主动停止,不区分落位。消费标记,同 takeStopped。
export function takeCanceled(taskId: string): boolean {
  return takeStopped(taskId) !== null;
}

// ── 完成确认(严格 done 协议)────────────────────────────────────────────────
// exit 0 只说明 CLI 进程正常退出,不代表任务目标达成(agent 报错后正常退出照样
// exit 0)。done 必须由 agent 亲口确认:回合内调 complete_task(MCP → POST
// /tasks/:id/complete)置标记,settle 时 take 消费。
// 这里是**同进程的快路**;权威那份落在 tasks.complete_confirmed_at(DB),因为
// 确认走 HTTP 打到监听进程、而跑这个回合的未必是同一个进程 —— 只有内存标记时,
// 跨进程的确认会静默丢掉(见 schema.completeConfirmedAt 的注释)。settle 两边
// 任一命中即算确认。
const confirmed = new Set<string>();

export function confirmDone(taskId: string): void {
  confirmed.add(taskId);
}

// Check-and-clear(对称 takeCanceled):settle 消费,失败重试的下一回合不残留。
export function takeConfirmed(taskId: string): boolean {
  return confirmed.delete(taskId);
}

// Thrown by a run step when a stop was requested mid-flight, so the duet
// pipeline unwinds to its top-level catch and settles as `canceled`.
export class CanceledRun extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledRun";
  }
}

// ── 单飞锁与「这一轮跑完之后」────────────────────────────────────────────────
// 一个任务同一时刻只跑一个回合。锁本身原来住在 orchestrator 里，挪到这个中立模块
// 是因为「等这个任务当前这一轮退干净了再给它起下一轮」需要跟锁同一份真相：
// **结算钩子是在 run loop 的 try 里调的**（afterSettlement → handleTaskSettlement），
// 那一刻锁还锁着，此时对同一个任务调 continueTask 会被直接挡回、什么都不发生 ——
// 就地验证轮正是这种情况。于是由 run loop 释放锁的同一处把队列排空，不靠
// setTimeout 赌事件循环的先后。
const turns = new Map<string, string>();
const afterTurn = new Map<string, Array<() => void>>();

/**
 * 抢占这个任务的回合；已经有人在跑就返回 false（调用方直接放弃这一次）。
 * role 是这一回合的身份（"single" / "reviewer"…）——它是**运行时事实**，审查结论的
 * 归属检查（report_stage）读它，而不是查 sessions 表猜（session 行的 endedAt 语义
 * 既不代表进程活着、也不代表回合归属，审查实测两个方向都错过）。
 */
export function claimTurn(taskId: string, role = "single"): boolean {
  if (turns.has(taskId)) return false;
  turns.set(taskId, role);
  return true;
}

/**
 * 只读探测：这个任务的回合是否已被占用。
 *
 * 给「验收 / 派审 / 修复 / 预览」这类守卫用：`tasks.status` 要到 continueTask 深处才写成
 * running，claim 到落库之间有真实窗口——只看 DB status 会把一个已经开跑的任务当成空闲，
 * 进而合并、删 worktree 或往它身上派审（审查报告实测复现过）。守卫必须两个都看。
 */
export function isTurnClaimed(taskId: string): boolean {
  return turns.has(taskId);
}

/** 当前回合的身份；没有回合在跑返回 null。 */
export function turnRole(taskId: string): string | null {
  return turns.get(taskId) ?? null;
}

/**
 * 占位转正：入口在最后一个 await 检查之后原子占住 turn（turnHeld 传递给启动函数），
 * 启动函数到位后用真实身份接管这把锁。只允许在**已持有**时调用——没占就转正是编程错。
 */
export function reclaimTurn(taskId: string, role: string): void {
  if (!turns.has(taskId)) throw new Error(`reclaimTurn(${taskId}) without holding the turn`);
  turns.set(taskId, role);
}

/** 回合结束：先放锁，再跑「等这一轮跑完」的回调（它们多半要立刻起下一轮）。 */
export function releaseTurn(taskId: string): void {
  turns.delete(taskId);
  // 起跑冻结标记只属于刚结束的这一回合（没被消费 = 那一轮已经自己结束了）。留着它，
  // 下一次运行会在起跑前被上一次的暂停莫名冻掉。
  startFreeze.delete(taskId);
  const waiting = afterTurn.get(taskId);
  if (!waiting) return;
  afterTurn.delete(taskId);
  for (const fn of waiting) {
    try {
      fn();
    } catch (error) {
      console.error(`[harness] after-turn hook failed for ${taskId}:`, error);
    }
  }
}

/** 任务空着就立刻执行，正在跑就排到它这一轮退出之后。 */
export function whenTurnIdle(taskId: string, fn: () => void): void {
  if (!turns.has(taskId)) {
    fn();
    return;
  }
  const waiting = afterTurn.get(taskId);
  if (waiting) waiting.push(fn);
  else afterTurn.set(taskId, [fn]);
}

/**
 * 结算钩子里给同一个任务续跑的**唯一安全写法**：等它这一轮退干净再送消息。
 *
 * 直接 `continueTask` 会被单飞锁静默挡回（结算钩子跑在 run loop 的 try 里，锁还锁着），
 * 表现是「什么都没发生」——就地验证轮起不来、打回重做的提示没人收。动态 import 是为了
 * 不让这个中立模块回头依赖 orchestrator（类型是纯类型引用，不构成运行时环）。
 */
type ContinueOpts = Parameters<(typeof import("./orchestrator.js"))["continueTask"]>[2];

export function continueWhenIdle(
  taskId: string,
  text: string,
  opts: ContinueOpts = {},
  onError?: (message: string) => void | Promise<unknown>,
): void {
  whenTurnIdle(taskId, () => {
    // 排到队头的一瞬间**同步**锁定所有权（turnHeld 传递给 continueTask 接管）：不占的
    // 话，异步 import 的间隙里同一释放点的后续 waiter 能同步抢锁——投递「not delivered」
    // 而调用方可能已提前写下状态（审查实测 3/3：dispatch 释放点被竞争 waiter 抢先，
    // 任务留在 stage=verifying 而验证从未启动）。
    const role = (opts.sessionRole as string | undefined) ?? "single";
    if (!claimTurn(taskId, role)) {
      console.error(`[harness] continueWhenIdle(${taskId}) not delivered: turn re-claimed`);
      void onError?.("回合被其它执行抢占，消息未能投递");
      return;
    }
    void import("./orchestrator.js")
      .then(({ continueTask }) => continueTask(taskId, text, { ...opts, turnHeld: true }))
      .then(
        async (delivered) => {
          // continueTask 返回 false = 一个字都没送出去（验收互斥退避等）。吞掉它，
          // 调用方的时间线就会停在「意见已发回会话」而消息实际没了——必须当失败上报。
          if (delivered === false) {
            console.error(`[harness] continueWhenIdle(${taskId}) not delivered`);
            try { await onError?.("回合被其它执行抢占，消息未能投递"); } catch { /* 上报失败不再连锁 */ }
          }
        },
        async (error) => {
          // 只有 import 失败或 continueTask 进入自己的 try/finally 之前抛错才会到这——
          // 那两种情况下锁还是这里占的那把，必须还回去（continueTask 一旦接管，正常与
          // 失败路径都由它自己释放，不会落到这个分支）。
          releaseTurn(taskId);
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[harness] continueWhenIdle(${taskId}) failed:`, error);
          try { await onError?.(message); } catch { /* 上报失败不再连锁 */ }
        },
      );
  });
}
