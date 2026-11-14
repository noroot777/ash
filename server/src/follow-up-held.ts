// 被哨兵隔开的续聊:**后半段仍然是同一次续聊**。
//
// 现场(2026-11-14,R8M9Tsn2q0aj):done 的任务上审查打回、执行者修完给自己改的测试挂回归哨兵并
// `pause_task`。续聊回合名下有没了结的哨兵就不能回原终态(回去 = 终态连坐把哨兵停掉),于是落成
// paused(settle-status.ts 续聊分支的 `hold`)。那一笔原先把续聊身份和「续聊前是哪个状态」一起
// 清掉了 —— 哨兵叫醒的那一回合就成了普通执行回合,执行者照规矩 `dispute_review`、不调
// `complete_task`,结算按严格完成协议记 failed + 「本回合没有交卷」。全库 46 次,10 月 26 日
// 「自己改的测试必须挂哨兵登记」以后,这成了驳回的常态结局。
//
// 解法:`hold` 那一笔把原状态记进 `follow_up_held_from`(跟 paused 同一条 UPDATE)。暂停期间
// `follow_up_from` 照旧是空的 —— 队列眼里它就是一个在等哨兵的 paused(queue-monitor-hold.ts),
// 口径不动。下一回合起跑时,**不是旁路的回合**(哨兵叫醒、点继续、再发话、答复、队列续跑)把它
// 原样接回 `follow_up_from`、同一笔清掉这一列,于是这一回合从起跑、重启对账、起跑失败到结算,走的
// 都是续聊那一套;又被哨兵隔开就再记一次,隔几次都一样。旁路回合(压缩、审查、就地验证、计划)
// 不碰它:它们回到的是 paused 本身,这次续聊还没收口。
//
// 什么时候作废:落终态或 backlog(用户手改状态、停止、归档…)、fresh 起跑(`runTask` 从来不是续聊)。
// 规则住在 status.ts 的那一笔写入里(`heldFollowUpPatch`),不靠每个入口记得清。
import type { TaskStatus } from "@ash/shared";

const TERMINAL = ["done", "failed", "canceled"];

/** 这一回合起跑时的续聊身份(`tasks.follow_up_from`),由 orchestrator 的 continueTask 落库。 */
export function turnFollowUpFrom(
  task: { status: string; followUpHeldFrom?: string | null },
  turn: {
    /** 执行 `/goal` 一类持续目标:有自己的一套。 */
    goalExecution: boolean;
    goalPriorStatus: string;
    inputExecution: boolean;
    system: boolean;
    sideTurn: boolean;
    /** 这一回合是任务的执行(后端代写的续跑、让位交接)。 */
    execution: boolean;
    /** checkpoint-paused 上的真人追问(用 paused 护住检查点)。 */
    checkpointFollowUp: boolean;
  },
): string | null {
  if (turn.goalExecution) {
    return !turn.inputExecution && !turn.system && TERMINAL.includes(turn.goalPriorStatus) ? turn.goalPriorStatus : null;
  }
  if (turn.sideTurn) return task.status === "running" || task.status === "queued" ? null : task.status;
  // 被哨兵隔开的那次续聊还没收口:不管这一回合是谁叫起来的,它都是那次续聊的后半段。
  if (task.followUpHeldFrom) return task.followUpHeldFrom;
  return !turn.execution && (TERMINAL.includes(task.status) || turn.checkpointFollowUp) ? task.status : null;
}

/** 起跑那一笔要不要顺手清掉这一列:接回去了才清,旁路回合原样留着。 */
export function heldFollowUpTaken(task: { followUpHeldFrom?: string | null }, followUpFrom: string | null): boolean {
  return !!task.followUpHeldFrom && followUpFrom === task.followUpHeldFrom;
}

/**
 * 跟状态同一笔落下的 `follow_up_held_from`。`hold` = 续聊分支被哨兵闸拦下、要记住的那个原状态。
 * 空对象 = 不动它(paused/running/queued:旁路回合进出、暂停期间的其它写入都不该抹掉它)。
 */
export function heldFollowUpPatch(status: TaskStatus, hold: TaskStatus | undefined): { followUpHeldFrom?: string | null } {
  if (hold) return { followUpHeldFrom: hold };
  if (TERMINAL.includes(status) || status === "backlog") return { followUpHeldFrom: null };
  return {};
}

/**
 * 撤回一轮还没起来的回合、把任务放回起跑前的状态时,把起跑那一笔接走的标记还回去。起跑前是
 * paused、起跑时 `follow_up_from` 却是终态 ⇒ 只可能是从这一列接过来的(旁路回合记的是 paused
 * 本身,真人追问记的也是 paused)。
 */
export function heldFollowUpRestore(priorStatus: string, followUpFrom: string | null | undefined): { followUpHeldFrom?: string } {
  return priorStatus === "paused" && followUpFrom && TERMINAL.includes(followUpFrom) ? { followUpHeldFrom: followUpFrom } : {};
}
