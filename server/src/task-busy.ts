// 「这条任务现在动不得」—— 处置整条任务(删掉它的行、抽掉它的 worktree/分支)之前的
// 统一判据。
//
// 有三个入口要问同一句话,所以判据只能有一份:
//   · `DELETE /tasks/:id` —— 删行,顺带按勾选清 git
//   · `DELETE /projects/:id` —— 连项目带任务一起删
//   · `POST /projects/:id/workspaces/discard` —— 行通常已经删了,只清 git 残留
// 第三个是后加的,它按请求体里的 taskId 直接 `git worktree remove --force` +
// `git branch -D`;不共用这份判据的话,它就是前两个所有防护的一条绕行路 —— agent 还在
// 那个目录里跑,目录先被抽走,后续的文件写入、git 命令、结算、验收全落到不一致状态
// (第 4 轮审查 P1)。
//
// 判据按「谁还指望这一行 / 这个目录还在」列:
//   · 在跑 / 占着 turn —— 进程还活着,回合结算还要写这一行(status 落库前 turn 就已占,
//     所以光看 status 会漏)
//   · 在验收 —— 尾段发布命令还在跑,结算还要写这一行
//   · 任何 child 在飞 —— 执行者跟着 lead 活,还可能正用着共享工作区
// 常驻调度台(team lead)idle 时不受影响:status 不匹配、turn 也没占。
// 任务行**不存在**不算忙 —— 那正是残留清理入口的正常场景(行已删,只剩 git 里的垃圾)。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { isTurnClaimed } from "./runs.js";
import { isAcceptingTask } from "./acceptance-lock.js";

/** 409 的响应体,原样回给 UI。 */
export interface TaskBusyRejection {
  error: string;
  status?: string;
  childId?: string;
}

/** 这一行现在有人指望着吗。已经查出来的任务行直接用它,别再各自拼一遍这四个条件。 */
export function isTaskBusy(row: { id: string; status: string }): boolean {
  return row.status === "running" || row.status === "queued" || isTurnClaimed(row.id) || isAcceptingTask(row.id);
}

/**
 * 现在能不能处置这条任务。null = 可以动。
 *
 * `verb` 只拼进文案(「删除」/「清理」),判据对每个入口完全一致。
 */
export async function taskBusyRejection(taskId: string, verb: string): Promise<TaskBusyRejection | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) return null;
  // 「在执行」和「在验收」要分开报 —— 用户要做的事不一样(一个去停,一个等它跑完);
  // 两句之和正好是 isTaskBusy。
  if (row.status === "running" || row.status === "queued" || isTurnClaimed(taskId)) {
    return { error: `任务正在执行，请先停止再${verb}`, status: row.status };
  }
  if (isAcceptingTask(taskId)) return { error: `任务正在验收中，结束后再${verb}` };
  const busyChild = (await db.select().from(tasks).where(eq(tasks.parentId, taskId))).find(isTaskBusy);
  if (busyChild) {
    return {
      error: `执行者「${busyChild.title}」正在执行，请先停止团队再${verb}`,
      childId: busyChild.id,
      status: busyChild.status,
    };
  }
  return null;
}
