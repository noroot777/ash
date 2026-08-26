import type { AgentType } from "@ash/shared";

// Registry of in-flight agent subprocesses, keyed by task, so a running task can
// be killed on demand (manual stop / group pause) — the orchestrator/duet
// register each live run here and the /stop API calls stopTask. A `stopping` map
// lets the run loops distinguish a requested kill from a crash (→ failed), AND
// carries how the kill should settle: a manual stop settles `canceled`(可跳过),
// a group pause settles `paused`(恢复分组时从原会话续跑,而不是被队列跳过)。

export interface Killable {
  kill(): void;
  steer?(text: string): Promise<void>;
}

// 被杀回合的结算落位:手动停 → canceled(队列把它当离队);分组暂停 → paused
// (队列 head 停在它身上,恢复分组时先续跑它,再轮到后面的)。
export type StopSettle = "canceled" | "paused";

const handles = new Map<string, Set<Killable>>();
const stopping = new Map<string, StopSettle>();
type NativeSteerTarget = {
  handle: Killable & { steer(text: string): Promise<void> };
  agentType: AgentType;
  record(text: string, at: string): void;
};
const nativeSteerTargets = new Map<string, NativeSteerTarget>();
const nativeSteering = new Map<string, symbol>();
// 「引导会话」是两阶段操作：先预约，让旧回合即使自然结束也等数据库清理结果；清理成功
// 才提交并 kill，失败则撤销并按普通回合结算。这样 handle 在 await 窗口里消失也不会漏结算。
type SteeringReservation = {
  state: "pending" | "committed" | "canceled";
  stopSettle: StopSettle | null;
  decision: Promise<boolean>;
  decide(value: boolean): void;
};
const steering = new Map<string, SteeringReservation>();
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
  if (nativeSteerTargets.get(taskId)?.handle === h) nativeSteerTargets.delete(taskId);
  const set = handles.get(taskId);
  if (!set) return;
  set.delete(h);
  if (!set.size) handles.delete(taskId);
}

/**
 * 把执行器的原生 steer 管子与当前 transcript 绑定。trackRun 仍然先发生，让停止按钮在
 * session 落库期间也能工作；绑定完成前若用户恰好点引导，只返回「正在启动」，绝不误降级
 * 成 kill + resume。
 */
export function bindNativeSteer(
  taskId: string,
  handle: Killable,
  input: { agentType: AgentType; record(text: string, at: string): void },
): void {
  if (!handle.steer || !handles.get(taskId)?.has(handle)) return;
  nativeSteerTargets.set(taskId, {
    handle: handle as Killable & { steer(text: string): Promise<void> },
    agentType: input.agentType,
    record: input.record,
  });
}

export type NativeSteerReservation = {
  kind: "native";
  agentType: AgentType;
  deliver(text: string, at: string): Promise<void>;
  cancel(): void;
} | { kind: "busy" } | { kind: "unsupported" };

/** 原生引导只串行占用当前 RunHandle；它不结束 turn，也不碰旧的硬切 steering 状态机。 */
export function reserveNativeSteerTask(taskId: string): NativeSteerReservation {
  const set = handles.get(taskId);
  const hasSteerable = [...(set ?? [])].some((handle) => !!handle.steer);
  if (!hasSteerable) return { kind: "unsupported" };
  const target = nativeSteerTargets.get(taskId);
  if (!target || !set?.has(target.handle) || nativeSteering.has(taskId) || stopping.has(taskId)) {
    return { kind: "busy" };
  }
  const token = Symbol(taskId);
  nativeSteering.set(taskId, token);
  let consumed = false;
  const release = () => {
    if (nativeSteering.get(taskId) === token) nativeSteering.delete(taskId);
  };
  return {
    kind: "native",
    agentType: target.agentType,
    async deliver(text, at) {
      if (consumed) throw new Error("本次引导预约已经使用");
      consumed = true;
      try {
        if (stopping.has(taskId)) throw new Error("任务正在停止或暂停");
        if (nativeSteerTargets.get(taskId) !== target || !handles.get(taskId)?.has(target.handle)) {
          throw new Error("当前活动回合已经结束");
        }
        await target.handle.steer(text);
        // provider 已确认收到以后，消息就已经是真实投递；实时广播失败不能把它退回队列
        // 再投一次，否则同一句会进入模型两遍。
        try { target.record(text, at); } catch (error) {
          console.warn(`[ash] 原生引导已送达，但会话记录失败 ${taskId}:`, error);
        }
      } finally {
        release();
      }
    },
    cancel() {
      if (consumed) return;
      consumed = true;
      release();
    },
  };
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
  // 停止优先于已经预约/提交的引导：pending 要唤醒正在等决定的旧回合，committed 要
  // 阻止 releaseTurn 后续送。预约回调会判断停止是否已由旧回合结算，漏掉才补结算。
  const reservation = steering.get(taskId);
  if (reservation) {
    const wasPending = reservation.state === "pending";
    reservation.state = "canceled";
    reservation.stopSettle = settle;
    if (wasPending) reservation.decide(false);
  }
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
 *
 * **SCM 占位不是回合**，所以一律不接：`claimWorkspaceTurn` 能占住就说明此刻没有 agent
 * 在起跑（真回合占着锁时它压根占不到），冻它没有对象；而它释放时刻意不清起跑冻结（那是
 * 真回合的东西），标记会活到下一次真启动，把一次正常的「运行」莫名撤回成 paused，时间线
 * 还写成「所在分组已暂停」——分组其实早恢复了（第 3 轮审查稳定复现）。
 */
export function freezeStartingTurn(taskId: string, settle: StopSettle = "paused"): boolean {
  const role = turns.get(taskId);
  if (role === undefined || role === WORKSPACE_TURN_ROLE) return false;
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

/** 预约受控结束；调用方完成 DB 清理后 commit，失败时 cancel。 */
export function reserveSteerTask(
  taskId: string,
  whenIdle: (outcome: { stopped: StopSettle | null; needsSettlement: boolean }) => void,
): { commit(): "committed" | "stopping" | "lost"; cancel(): void } | null {
  const set = handles.get(taskId);
  if (!set?.size || steering.has(taskId) || stopping.has(taskId)) return null;
  let decide!: (value: boolean) => void;
  const reservation: SteeringReservation = {
    state: "pending",
    stopSettle: null,
    decision: new Promise<boolean>((resolve) => { decide = resolve; }),
    decide: (value) => decide(value),
  };
  steering.set(taskId, reservation);
  whenTurnIdle(taskId, () => {
    if (steering.get(taskId) === reservation) steering.delete(taskId);
    if (reservation.stopSettle) {
      // 旧回合正常停止路径会先 takeStopped；还留着说明停止晚到、旧回合已按 steered
      // 收尾，必须由引导回调补结算，不能让 running 和停止标记一起漏给下一轮。
      const lateStop = takeStopped(taskId);
      whenIdle({ stopped: lateStop ?? reservation.stopSettle, needsSettlement: !!lateStop });
    } else if (reservation.state === "committed") {
      whenIdle({ stopped: null, needsSettlement: false });
    }
  });
  return {
    commit() {
      if (reservation.state !== "pending") return reservation.stopSettle ? "stopping" : "lost";
      const stopped = stopping.get(taskId);
      if (stopped) {
        reservation.state = "canceled";
        reservation.stopSettle = stopped;
        reservation.decide(false);
        return "stopping";
      }
      // turn 在数据库 await 期间已经释放，whenTurnIdle 那次机会也已经烧掉；此时不能
      // 假提交后无界等待 delivery，交给调用方恢复状态并归还消息租约。
      if (steering.get(taskId) !== reservation) {
        reservation.state = "canceled";
        reservation.decide(false);
        return "lost";
      }
      reservation.state = "committed";
      reservation.decide(true);
      for (const h of handles.get(taskId) ?? []) {
        try {
          h.kill();
        } catch {
          /* best effort；事件流若仍活着，消息继续持有投递租约，不会被误标 sent */
        }
      }
      return "committed";
    },
    cancel() {
      if (reservation.state !== "pending") return;
      reservation.state = "canceled";
      reservation.decide(false);
      if (steering.get(taskId) === reservation) steering.delete(taskId);
    },
  };
}

/**
 * 当前回合结束时读取引导决定。预约尚在 DB await 中就等待：commit 跳过旧结算，cancel
 * 继续普通结算。异步是关闭“自然结束恰好撞上清理窗口”竞态的关键。
 */
export async function takeSteered(taskId: string): Promise<boolean> {
  const reservation = steering.get(taskId);
  if (!reservation) return false;
  const committed = await reservation.decision;
  if ((!committed || reservation.state !== "committed") && steering.get(taskId) === reservation) {
    // 回调已经闭包持有 reservation；从 map 摘掉不会丢停止后的清理通知。
    steering.delete(taskId);
  }
  return committed && reservation.state === "committed";
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
 * SCM 面板占住工作区时写进 `turns` 的身份。它**不是一个回合**：没有 agent、没有 spawn、
 * 不进结算。凡是「对正在起跑的回合做点什么」的逻辑都得按这个身份把它排除掉
 * （目前是 `freezeStartingTurn`）。
 */
const WORKSPACE_TURN_ROLE = "scm";

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
  // 起跑冻结标记只属于刚结束的这一回合（没被消费 = 那一轮已经自己结束了）。留着它，
  // 下一次运行会在起跑前被上一次的暂停莫名冻掉。
  startFreeze.delete(taskId);
  endTurn(taskId);
}

/**
 * SCM 面板要动这个工作目录：**用同一把回合锁原子预占**，占不到返回 null。
 *
 * 为什么不是「再查一次在不在飞」：查是观察式的，`claimTurn` 不需要仓库锁，查完到真正
 * 动手之间另一次启动完全可以合法插进来（第 2 轮审查确定性复现过：guard 观察到空闲，
 * 其后的微任务里 claim 成功，git 命令仍照跑）。多查几次关不掉这个窗口——启动与工作区
 * 写入必须争同一个原子对象。占住之后 `claimTurn` 会挡下新的启动，`isTurnClaimed` 也会
 * 让归档/验收/派审这些既有守卫一并退避，不必在每个调用点再加一道。
 *
 * **要占的是这个目录的全部共用者，不是一个 task id**（`workspaceParticipants`）：团队
 * 调度台和它那些跟随的执行者跑在同一个 worktree 里，只占自己那把锁，兄弟执行者照样能在
 * 我们跑 git 的同一时刻起跑（第 4 轮审查复现）。所以这里是**全有或全无**：中途占不到就
 * 把已占的全部还回去，让调用方按 `needsForce` 那一档处理；用户确认过的 force 走
 * `claimIdleWorkspaceTurns`。
 *
 * 和真回合的唯一差别是**不碰起跑冻结**：这不是一个回合，清掉它会把上一次真回合留下的
 * 暂停意图吃掉；反过来，占住期间也不许有人往它身上写冻结（见 `freezeStartingTurn`），
 * 否则标记会漏给下一次真启动。
 */
export function claimWorkspaceTurn(taskIds: string[]): (() => void) | null {
  const claimed: string[] = [];
  for (const taskId of new Set(taskIds)) {
    if (claimTurn(taskId, WORKSPACE_TURN_ROLE)) {
      claimed.push(taskId);
      continue;
    }
    for (const held of claimed) endTurn(held);
    return null;
  }
  return releaserFor(claimed);
}

/**
 * 同上，但**能占到几把就占几把**——只跳过此刻真有回合在跑的那些。带 `force` 的写操作走
 * 这一条。
 *
 * force 的本意是覆盖「已经在写这个目录的那一位」，用户为此点过一次确认。全有或全无在这
 * 里是反的：一位共用者在跑，整组锁就都还回去了，于是**还没起跑的闲置同伴照样能在这次
 * git 期间起跑**（第 1 轮审查函数级复现：`claimWorkspaceTurn([running, idle]) === null`
 * 之后 `claimTurn(idle)` 立刻成功）。用户放行的是一个明确的对象，不是整组。
 *
 * 占不到的那些不必回给调用方：force 路径本来就不再据此拒绝，知道也无事可做。
 */
export function claimIdleWorkspaceTurns(taskIds: string[]): () => void {
  const claimed: string[] = [];
  for (const taskId of new Set(taskIds)) {
    if (claimTurn(taskId, WORKSPACE_TURN_ROLE)) claimed.push(taskId);
  }
  return releaserFor(claimed);
}

/** 释放函数可重复调用（写操作的 finally 与错误路径可能都走到）。 */
function releaserFor(claimed: readonly string[]): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const taskId of claimed) endTurn(taskId);
  };
}

/** 放锁 + 跑「等这一轮跑完」的回调。回合与 SCM 预占共用（前者另外还要清起跑冻结）。 */
function endTurn(taskId: string): void {
  turns.delete(taskId);
  const waiting = afterTurn.get(taskId);
  if (!waiting) return;
  afterTurn.delete(taskId);
  for (const fn of waiting) {
    try {
      fn();
    } catch (error) {
      console.error(`[ash] after-turn hook failed for ${taskId}:`, error);
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
      console.error(`[ash] continueWhenIdle(${taskId}) not delivered: turn re-claimed`);
      void onError?.("回合被其它执行抢占，消息未能投递");
      return;
    }
    void import("./turn-freeze.js")
      .then(async ({ turnFreezeReason }) => {
        // 这条路上的启动**全是系统发起的**（就地验证、自由派审、修复、验收冲突叫醒），
        // 而且都是「先占位登记、释放点之后才真起跑」的交接：从调用方那次预检查到这里，
        // 中间隔着上一整轮，用户完全可能已经把分组暂停、把任务删了或归档了。
        //
        // 内存里的起跑冻结标记在这条路上**指望不上**：`pauseGroup` 冻的是占位那一个
        // 回合（dispatch），占位方的 finally `releaseTurn` 会连着标记一起清掉——接棒的
        // 真实回合什么都看不到，于是「暂停已经 200 返回，reviewer 照样被拉起来」
        //（第 4 轮审查确定性复现）。所以这里按事实查库权威复查一次。
        const freeze = await turnFreezeReason(taskId, true);
        if (!freeze) {
          return (await import("./orchestrator.js")).continueTask(taskId, text, { ...opts, turnHeld: true });
        }
        // 撤回，且**不标停止落位**：这一轮一个字都没送出去，任务状态还停在上一轮的终态，
        // 标了就会被下一次真启动误读成「上一轮是被停的」。当作投递失败上报，调用方那套
        // 回滚（清 verifyRound、复位 stage、写时间线）才跑得到——不然任务会永久卡在
        // 「正在验证」而验证从未开始。
        releaseTurn(taskId);
        console.error(`[ash] continueWhenIdle(${taskId}) withdrawn: ${freeze.reason}`);
        try { await onError?.(`${freeze.reason}，这一轮在启动前被撤回`); } catch { /* 上报失败不再连锁 */ }
        return true;
      })
      .then(
        async (delivered) => {
          // continueTask 返回 false = 一个字都没送出去（验收互斥退避等）。吞掉它，
          // 调用方的时间线就会停在「意见已发回会话」而消息实际没了——必须当失败上报。
          if (delivered === false) {
            console.error(`[ash] continueWhenIdle(${taskId}) not delivered`);
            try { await onError?.("回合被其它执行抢占，消息未能投递"); } catch { /* 上报失败不再连锁 */ }
          }
        },
        async (error) => {
          // 只有 import 失败或 continueTask 进入自己的 try/finally 之前抛错才会到这——
          // 那两种情况下锁还是这里占的那把，必须还回去（continueTask 一旦接管，正常与
          // 失败路径都由它自己释放，不会落到这个分支）。
          releaseTurn(taskId);
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[ash] continueWhenIdle(${taskId}) failed:`, error);
          try { await onError?.(message); } catch { /* 上报失败不再连锁 */ }
        },
      );
  });
}
