import type { AgentType } from "@ash/shared";
import type { SteerText } from "./executors/types.js";
import type { CliCommand, CliGoal } from "@ash/shared/cli-commands";
import { RECONCILE_TURN_ROLE, claimNonTurn, whenTurnIdle } from "./turn-lock.js";

// 回合占位锁那一半(单飞锁、几种不是回合的预占、起跑冻结、等这一轮跑完再续跑)住在
// turn-lock.ts —— 两摊各自的使用方几乎不重叠,挤在一个文件里已经过了 700 行上限
// (第 3 轮审查 F3)。八十多个文件照旧从这里 import,所以原样转出去。
export {
  bindTurnToken, claimIdleWorkspaceTurns, claimTurn, claimWakeTurn, claimWorkspaceTurn,
  continueWhenIdle, freezeStartingTurn, isTurnClaimed, reclaimTurn, releaseTurn,
  takeStartFreeze, turnIdentity, turnRole, turnSourceReview, turnSourceRole, whenTurnIdle,
} from "./turn-lock.js";
export type { TurnIdentity, TurnReview, TurnSource } from "./turn-lock.js";

// Registry of in-flight agent subprocesses, keyed by task, so a running task can
// be killed on demand (manual stop / group pause) — the orchestrator/duet
// register each live run here and the /stop API calls stopTask. A `stopping` map
// lets the run loops distinguish a requested kill from a crash (→ failed), AND
// carries how the kill should settle: a manual stop settles `canceled`(可跳过),
// a group pause settles `paused`(恢复分组时从原会话续跑,而不是被队列跳过)。

export interface Killable {
  kill(): void;
  steer?(text: SteerText, beforeSend?: () => void | Promise<void>): Promise<void>;
  command?(command: CliCommand): Promise<string>;
  goal?(): CliGoal | null;
  /** 事件流结束后回收 CLI 甩出去的后台后代（RunHandle / ResidentHandle 上的同名方法）。 */
  cleanup?(): Promise<void>;
}

// 被杀回合的结算落位:手动停 → canceled(队列把它当离队);分组暂停 → paused
// (队列 head 停在它身上,恢复分组时先续跑它,再轮到后面的)。
export type StopSettle = "canceled" | "paused";

const handles = new Map<string, Set<Killable>>();
const stopping = new Map<string, StopSettle>();
type NativeSteerTarget = {
  handle: Killable & { steer(text: SteerText, beforeSend?: () => void | Promise<void>): Promise<void> };
  agentType: AgentType;
  prepare(text: string): string | Promise<string>;
  beforeDeliver?(at: string): void | Promise<void>;
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

export function trackRun(taskId: string, h: Killable): void {
  let set = handles.get(taskId);
  if (!set) handles.set(taskId, (set = new Set()));
  set.add(h);
}

export function nativeCommandRun(taskId: string): Killable | null {
  const current = [...(handles.get(taskId) ?? [])];
  return current.length === 1 ? current[0]! : null;
}

export function untrackRun(taskId: string, h: Killable): void {
  if (nativeSteerTargets.get(taskId)?.handle === h) nativeSteerTargets.delete(taskId);
  const set = handles.get(taskId);
  if (!set) return;
  set.delete(h);
  if (!set.size) handles.delete(taskId);
}

// ── 一个「已经起来的 CLI 进程」有三种归属 ──────────────────────────────────────
//
// 进程由**起跑方** spawn（`executor.run` / `openResident` 都是当场起,不是惰性）,却由
// **消费循环的 finally** 回收。中间夹着一整段初始化:落库、建日志目录、开写流、组装调度
// 台、重启后接管。这段里任何一条出口没接上,进程就变成无主的 —— 没人读它的输出,停止按钮
// 也动不了它,它继续在用户的工作目录里跑、烧真额度。这件事以前只在各处 finally 里口头约
// 定,所以四个起跑入口各漏了一处(第 1 轮审查 F1)。写成显式的三态:
//
//   ① **起跑方持有**(trackRun 之后、adoptRun 之前):它的每一条失败出口都落在
//      discardStartingRun 上 —— 注销 + 杀 + 回收后代。`void` 出去的异步接管也算这一档。
//   ② **消费方持有**(adoptRun 之后):回收转给消费循环的 finally,起跑方此后**只注销不杀**。
//   ③ **所有者活得比这次调用长**(常驻调度台 attachLead 之后):句柄挂在 lead 上,由
//      haltTeam / endTurn 收口,起跑方不再过问。
//
// 判据是「有没有被 adoptRun 认领过」,**不是「还在不在 handles 集合里」**:在不在集合里只
// 决定 isRunning 的真假,跟进程死没死是两件事。拿「注销过没有」当「可以安全开刀」用,会在
// 正常跑完(登记仍在册)的路径上对着一个已经退出的号发信号 —— 那个号此时可能已经属于用
// 户的别的程序(第 1 轮审查 F2,进程层判据见 executors/spawn.ts `childStillOurs`)。
const adoptedRuns = new WeakSet<Killable>();
const discardedRuns = new WeakSet<Killable>();

/** ②:消费循环已经真正接手这个 handle,之后的回收由它的 finally 负责。 */
export function adoptRun(h: Killable): void {
  adoptedRuns.add(h);
}

/**
 * 起跑途中(或接管途中)失败时的收口,可以无脑挂在任何一条出口上:
 *   · 一律注销登记 —— 否则进程走了而 handle 还在册,`isRunning` 永远判真,界面上停止按钮
 *     亮着、`stopTask` 返回 true 却什么都没停(第 8 轮审查 N1);
 *   · **只有尚未被 adoptRun 认领的**才杀 + 回收后代 —— 那种才是真·无主:CLI 已经起来了,
 *     而这一轮的消费循环永远不会开始,没有任何 finally 会来收它。认领过的交给消费方,这里
 *     多事只会制造 F2 的误杀窗口。
 * 重复调用无副作用(幂等),所以 try/catch/finally 里重复挂也不怕。
 */
export function discardStartingRun(taskId: string, h: Killable): void {
  untrackRun(taskId, h);
  if (adoptedRuns.has(h) || discardedRuns.has(h)) return;
  discardedRuns.add(h);
  void finalizeAbandonedRun(h).catch(() => { /* finalizeAbandonedRun 自己已经兜住了 */ });
}

/**
 * 真·无主回合的进程收尾:杀根进程 + 回收它甩出去的后台后代,两件事都做完才 resolve。
 * `cleanup` 是执行器句柄对「我这一轮起过的所有后代」的幂等 finalizer —— 平时由消费循环
 * 的 finally 调用(见 single-run.ts),这条路上没有那道 finally,所以必须在这里补上;少
 * 了它,被杀掉的只是 CLI 本体,它 nohup 出去的那些还在(第 1 轮审查 F1)。
 */
export async function finalizeAbandonedRun(h: Killable): Promise<void> {
  try {
    h.kill();
  } catch {
    /* best effort */
  }
  try {
    await h.cleanup?.();
  } catch (error) {
    console.warn("[ash] 回收无主回合的 CLI 后代失败:", error);
  }
}

/**
 * 把执行器的原生 steer 管子与当前 transcript 绑定。trackRun 仍然先发生，让停止按钮在
 * session 落库期间也能工作；绑定完成前若用户恰好点引导，只返回「正在启动」，绝不误降级
 * 成 kill + resume。
 */
export function bindNativeSteer(
  taskId: string,
  handle: Killable,
  input: {
    agentType: AgentType;
    prepare?(text: string): string | Promise<string>;
    beforeDeliver?(at: string): void | Promise<void>;
    record(text: string, at: string): void;
  },
): void {
  if (!handle.steer || !handles.get(taskId)?.has(handle)) return;
  nativeSteerTargets.set(taskId, {
    handle: handle as Killable & { steer(text: SteerText, beforeSend?: () => void | Promise<void>): Promise<void> },
    agentType: input.agentType,
    prepare: input.prepare ?? ((text) => text),
    beforeDeliver: input.beforeDeliver,
    record: input.record,
  });
}

export type NativeSteerReservation = {
  kind: "native";
  agentType: AgentType;
  deliver(text: string, at: string, opts?: {
    beforeSend?: () => void | Promise<void>;
    promptText?: string;
  }): Promise<void>;
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
    async deliver(text, at, opts) {
      if (consumed) throw new Error("本次引导预约已经使用");
      consumed = true;
      try {
        if (stopping.has(taskId)) throw new Error("任务正在停止或暂停");
        if (nativeSteerTargets.get(taskId) !== target || !handles.get(taskId)?.has(target.handle)) {
          throw new Error("当前活动回合已经结束");
        }
        await target.beforeDeliver?.(at);
        // prepare **惰性传进去**:它要现读浏览器授权,而 steer 还要等一个最多 2 秒的打断
        // 回执。在这里就把正文拼死的话,用户在那几秒里收回授权(PATCH 都 200 了)也拦不住,
        // 这条还没写进 stdin 的消息照样宣布「已预先授权」(第 8 链第 1 轮审查 P1)。
        // 执行器保证它在 ACK 与发送前清理都跑完之后、写 stdin 之前才调用。
        await target.handle.steer(() => target.prepare(opts?.promptText ?? text), opts?.beforeSend);
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

/**
 * **撤掉一次还没结算的确认**。返回它本来在不在。
 *
 * 用在「确认之后又挂了哨兵」那一刻(task-complete.ts):那一次确认已经不成立了,而只清
 * `tasks.complete_confirmed_at` 不够 —— settle 是两条道任一命中即算确认,内存这条快路留着
 * 的话任务照旧落 done(第 1 轮审查 F1 的原话:不能只清 DB 而保留内存快路)。
 */
export function revokeConfirmed(taskId: string): boolean {
  return confirmed.delete(taskId);
}

/**
 * 内存这条快路上现在有确认吗？**不消费它**（对称 `takeConfirmed` 的只读版）。
 *
 * 用在「刚挂上哨兵,要不要撤确认」那一步:没有确认可撤就该原样返回,而不是顺手写一段等待。
 * 借 `takeConfirmed` 一问一还的话,中间任何一个 await 都会让另一路读到一个假的「没确认」。
 */
export function hasConfirmed(taskId: string): boolean {
  return confirmed.has(taskId);
}

// Thrown by a run step when a stop was requested mid-flight, so the duet
// pipeline unwinds to its top-level catch and settles as `canceled`.
export class CanceledRun extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledRun";
  }
}

/**
 * 「结算一个被打断的任务」要占的那把锁:同一把回合锁,占不到返回 null。
 *
 * 为什么必须是原子预占、而不是结算前再查一次 `isRunning`:**claim 发生在 trackRun 之前**,
 * 所以「手上有没有句柄」答不了「有没有人正在起跑」;而查是观察式的 —— 从查完到写状态之间
 * 隔着几个 await,新回合完全可以合法插进来,结果一个正在干活的任务被写成 failed:界面显示
 * 失败、后台还在跑,队列也跟着错推一格(第 1 轮审查给出两种交错,都能复现)。占住之后新回合
 * 起不来,「读状态 → 写状态」这段就是真临界区;占不到 = 已经有人在跑或正在起跑,这条任务归
 * 他结算,我们一个字都不改。
 *
 * `isRunning` 仍要查:团队调度台这类任务平时不占这把锁(它只在 beginTurn/endTurn 之间占),
 * 句柄却实实在在挂着。**这一条因此住在这里而不是 turn-lock.ts** —— 它要同时问两边,而依赖
 * 只许单向。
 */
export function claimReconcileTurn(taskId: string): (() => void) | null {
  if (isRunning(taskId)) return null;
  return claimNonTurn(taskId, RECONCILE_TURN_ROLE);
}
