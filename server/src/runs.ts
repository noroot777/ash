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

/** 回合结束：先放锁，再跑「等这一轮跑完」的回调（它们多半要立刻起下一轮）。 */
export function releaseTurn(taskId: string): void {
  turns.delete(taskId);
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
    void import("./orchestrator.js")
      .then(async ({ continueTask }) => {
        // continueTask 返回 false = 一个字都没送出去（回合又被别人抢了）。吞掉它，
        // 调用方的时间线就会停在「意见已发回会话」而消息实际没了——必须当失败上报。
        const delivered = await continueTask(taskId, text, opts);
        if (delivered === false) {
          console.error(`[harness] continueWhenIdle(${taskId}) not delivered: turn re-claimed`);
          await onError?.("回合被其它执行抢占，消息未能投递");
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[harness] continueWhenIdle(${taskId}) failed:`, error);
        return onError?.(message);
      });
  });
}
