// 任务通知与「放开回合占位」那条救援路 —— 从 `api.ts` 拆出来的一小族端点。
//
// 为什么单独一个文件:`api.ts` 是这个前端的端点总清单,它贴着 700 行的硬上限(本轮审查
// F4:697 + 11 = 708 行就越了线)。拆分的口径与 `handoffApi` / `monitorApi` / `fileApi`
// 一样 —— 调用点仍然只认 `api.xxx`,`api.ts` 把这里展开进去,契约一个字都不变。
import { id, json, request } from "./apiClient.ts";

/**
 * 一条任务通知。`outcome` 是两件不同的事,前端据它选措辞而不是去猜 reason 的字面:
 *   · `rejected`   点了,系统没执行;
 *   · `incomplete` 执行了,但没达到用户要的那个效果(放开了锁、任务却还点不动)。
 */
export type TaskNotice = {
  id: string;
  action: string;
  outcome: "rejected" | "incomplete";
  reason: string;
  occurredAt: string;
};

export type TaskNoticesResult = {
  notices: TaskNotice[];
  /** 非空 = 此刻这个任务的回合占位可疑,界面该给出「放开回合占位」那个开关。 */
  remedy: "reclaim-turn" | null;
};

export type ReclaimTurnResult = {
  reclaimed: boolean;
  role: string;
  heldMs: number;
  /**
   * **锁放开了,任务现在点得动吗。** 两件事:放开只撤内存里那把锁,库里的状态归另一个人
   * 负责,而这条路要救的正是「没有人会来负责」的遗留。false 时 `nextStep` 写着接着该做
   * 什么,同一句话也已经作为 `incomplete` 通知落进了任务历史(服务端,见
   * server/src/turn-lock-reclaim.ts)。
   */
  runnable: boolean;
  status: string | null;
  nextStep: string | null;
  note: string;
};

export const taskNoticeApi = {
  // 这个任务被挡回/没做到位的那些操作。**无条件调**:它是任务历史的一部分,不按「对话流
  // 有没有正文」取舍(server/src/user-action-rejection.ts)。
  taskNotices: (taskId: string): Promise<TaskNoticesResult> =>
    request(`/tasks/${id(taskId)}/notices`),
  // 放开一把占着不动的回合占位。**判据在服务端,不因为是人点的就放宽**;而且只有账号
  // 本人按得动 —— agent 的回合凭证会被 403 挡掉(server/src/auth/personal-gate.ts)。
  reclaimTurn: (taskId: string): Promise<ReclaimTurnResult> =>
    request(`/tasks/${id(taskId)}/reclaim-turn`, json("POST", {})),
};
