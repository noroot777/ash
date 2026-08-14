// 起跑前的最后一道闸：回合已经占位、CLI 还没 spawn 的那一小段窗口里，「这一轮还该不该
// 跑」是可能被推翻的 —— 用户在这期间点了暂停分组、删了任务、把它归档。
//
// 为什么非得再查一遍：入口路由（重试按钮、派审）的预检查跟真正 spawn 之间隔着好几个
// await（权威重读、执行器解析、worktree 准备、上一条输入的读取）。`pauseGroup` 是
// **先写 groups.paused、再扫 tasks.status**，所以只要这道闸是 spawn 之前的最后一个
// await，两种交错都被覆盖：
//   ① 暂停先落库 → 这里读到 paused=true，撤回；
//   ② 暂停扫描时这一轮已经 running/有 handle → 它自己杀得掉；
//   ③ 暂停扫描时回合只 claim 了、既没 running 也没 handle（既杀不到也拦不住）→
//      pauseGroup 留下内存标记 freezeStartingTurn，这里消费掉，撤回。
// 第 ③ 种正是第 1 轮审查复现到的那条：pause 已经 200 返回，重试仍稳定把 CLI 拉起来
// （20 轮里 14 轮的 turn_started_at 晚于暂停响应完成）。
//
// 撤回的动作在调用方（continueTask）：抛错走它原有的 catch —— 那条路已经会对账基线、
// 清 followUpFrom、按 takeStopped/followUpFrom 结算状态、释放回合锁，不需要第二套。

import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, tasks } from "./db/schema.js";
import { markStopped, takeStartFreeze, type StopSettle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";

export type TurnFreeze = { reason: string; settle: StopSettle };

export class FrozenTurn extends Error {
  constructor(reason: string) {
    super(`回合在启动前被撤回：${reason}`);
    this.name = "FrozenTurn";
  }
}

/**
 * @param checkFacts 是否额外查库核对冻结事实（分组暂停 / 任务被删或归档）。
 *   内存标记无条件消费（它只可能是**这一回合**的暂停请求）；查库是给「入口预检查与
 *   spawn 之间隔了很多 await」的启动路径开的（重试按钮、自由审查重跑）。普通续聊不查：
 *   在一个 queued/暂停分组的任务上发消息本来就允许，那不是被冻结的启动。
 */
export async function turnFreezeReason(taskId: string, checkFacts = false): Promise<TurnFreeze | null> {
  const marked = takeStartFreeze(taskId);
  if (marked) {
    return { reason: marked === "paused" ? "所在分组已暂停" : "这一轮已被停止", settle: marked };
  }
  if (!checkFacts) return null;
  const task = (await db
    .select({ archived: tasks.archived, groupId: tasks.groupId })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  if (!task) return { reason: "任务已删除", settle: "canceled" };
  if (task.archived) return { reason: "任务已归档", settle: "canceled" };
  if (task.groupId) {
    const group = (await db
      .select({ paused: groups.paused })
      .from(groups)
      .where(eq(groups.id, task.groupId))).at(0);
    if (group?.paused) return { reason: "所在分组已暂停", settle: "paused" };
  }
  return null;
}

/**
 * 起跑前撤回这一轮：命中就写一条时间线，然后抛错交给调用方原有的 catch 收尾
 * （runTask / continueTask 的 catch 都会对账基线、结算状态、释放回合锁）。
 *
 * @param restorable 这一轮有原终态可回（续聊的 `followUpFrom`）。两条 catch 都是
 *   `takeStopped() ?? followUpFrom ?? "failed"`，takeStopped 优先 —— 所以有原终态时
 *   **不能**标停止落位（标了就把一个 done 的任务写成 paused），没有原终态时必须标
 *   （不标就落成 failed，一次暂停看着像崩了）。
 */
export async function abortIfFrozen(
  taskId: string,
  opts: { checkFacts?: boolean; restorable?: boolean } = {},
): Promise<void> {
  const freeze = await turnFreezeReason(taskId, opts.checkFacts);
  if (!freeze) return;
  await appendTaskTimeline(taskId, `这一轮在启动前被撤回：${freeze.reason}。`).catch(() => false);
  if (!opts.restorable) markStopped(taskId, freeze.settle);
  throw new FrozenTurn(freeze.reason);
}
