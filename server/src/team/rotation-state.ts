// 常驻调度台的「恢复会话轮换」状态机。
//
// 抽成纯函数不是为了好看:这里的坑从来不是写错一行,而是**标志位忘了复位**。
// `announced` 的含义是「『这条会话作废了』已经说出去、而且那句话属实」—— 它只在恢复
// 字段真的清掉的那一刻为真,一旦 CLI 报上新的 thread id 就必须连同 fault 一起归零。
// 漏掉这一步,下一条会话再出事且写库失败时,收尾会挑一句报喜的短话盖掉真相
// (2026-08-25 第 1 轮审查现场)。这种漏法 grep 不出来,只有状态序列测得到,所以三个
// 标志一起住在这个对象里,别再散成「两个局部变量 + 一个挂在 Lead 上活得比会话还长的
// 字段」。
import { mergeSessionResumeFault, type SessionResumeFault } from "../executors/session-lost.js";

export interface RotationState {
  /** 当前判定:这条恢复会话坏没坏(见 executors/session-lost.ts)。 */
  fault: SessionResumeFault | null;
  /** 已经中途作废,正等 CLI 报上一个新 thread id。 */
  awaitingFresh: boolean;
  /** 「这条会话作废了」已经说出去**且属实**;收尾据此不重复整段说明。 */
  announced: boolean;
}

export const idleRotation = (): RotationState => ({ fault: null, awaitingFresh: false, announced: false });

/** 收到一条 error:poisoned 不会被更晚的普通 lost 覆盖(合并规则在 session-lost.ts)。 */
export function onRotationError(state: RotationState, message: string): RotationState {
  return { ...state, fault: mergeSessionResumeFault(state.fault, message) };
}

/** 恢复字段清成功:这句「已作废」可以说,而且属实。 */
export function onRotationPersisted(state: RotationState): RotationState {
  return { ...state, awaitingFresh: true, announced: true };
}

/**
 * 恢复字段没能清掉 —— 写库失败,或这条会话行已被新进程接管(superseded)。内存里的 id
 * 作废了,库里那份还在,所以**不算说过**:收尾必须把完整那句再说一遍,而不是留一句短话。
 */
export function onRotationNotPersisted(state: RotationState): RotationState {
  return { ...state, awaitingFresh: true, announced: false };
}

/** CLI 报上新的 thread id:上一条会话的轮换事宜就此翻篇,三个标志一起归零。 */
export function onFreshSession(state: RotationState): RotationState {
  return state.awaitingFresh ? idleRotation() : state;
}
