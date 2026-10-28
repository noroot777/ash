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
import { markStopped, takeStartFreeze } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";

export type TurnFreeze = { reason: string } & (
  | { source: "stop"; settle: "canceled"; overrideRestorable: true }
  | { source: "group-pause"; settle: "paused"; overrideRestorable: false }
  | { source: "archive" | "delete"; settle: "canceled"; overrideRestorable: false }
);

export class FrozenTurn extends Error {
  constructor(reason: string) {
    super(`回合在启动前被撤回：${reason}`);
    this.name = "FrozenTurn";
  }
}

/**
 * 冻结判据里**要查库**的那一半：分组暂停 / 任务被删或归档。**不碰内存标记** —— 那个必须
 * 留到同步段的 `takeFreeze`，见它的注释。
 *
 * @param checkFacts 是否查库。只给「入口预检查与 spawn 之间隔了很多 await」的启动路径开
 *   （重试按钮、自由审查重跑）。普通续聊不查：在一个 queued/暂停分组的任务上发消息本来
 *   就允许，那不是被冻结的启动。
 */
export async function freezeFacts(taskId: string, checkFacts = false): Promise<TurnFreeze | null> {
  if (!checkFacts) return null;
  const task = (await db
    .select({ archived: tasks.archived, groupId: tasks.groupId })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  if (!task) return { reason: "任务已删除", source: "delete", settle: "canceled", overrideRestorable: false };
  if (task.archived) return { reason: "任务已归档", source: "archive", settle: "canceled", overrideRestorable: false };
  if (task.groupId) {
    const group = (await db
      .select({ paused: groups.paused })
      .from(groups)
      .where(eq(groups.id, task.groupId))).at(0);
    if (group?.paused) return { reason: "所在分组已暂停", source: "group-pause", settle: "paused", overrideRestorable: false };
  }
  return null;
}

/**
 * 定论,**同步**。先消费内存标记(它只可能是这一回合的暂停/停止请求),再回落到上面查来
 * 的事实。
 *
 * 拆成「异步取事实 + 同步定论」两段,是为了让启动末段还能和别的异步活儿并行而不开窗口:
 * 典型的是浏览器授权 —— 它必须读在**最后一个 await 里**(读早了,这段查库的工夫里用户收回
 * 授权就拦不住),而停止标记必须消费在**最后一个同步点**(消费早了,之后收到的停止就会既杀
 * 不到也拦不住)。两条约束只有「并行取、同步定」能同时满足(第 6 链第 1 轮审查 P1)。
 */
export function takeFreeze(taskId: string, facts: TurnFreeze | null = null): TurnFreeze | null {
  const marked = takeStartFreeze(taskId);
  if (marked) {
    return marked === "canceled"
      ? { reason: "这一轮已被停止", source: "stop", settle: marked, overrideRestorable: true }
      : { reason: "所在分组已暂停", source: "group-pause", settle: marked, overrideRestorable: false };
  }
  return facts;
}

/**
 * 起跑前撤回这一轮：命中就写一条时间线，然后抛错交给调用方原有的 catch 收尾
 * （runTask / continueTask 的 catch 都会对账基线、结算状态、释放回合锁）。
 *
 * @param restorable 这一轮有原终态可回（续聊的 `followUpFrom`）。两条 catch 都是
 *   `takeStopped() ?? followUpFrom ?? "failed"`，takeStopped 优先 —— 所以有原终态时
 *   分组暂停不标停止落位，避免把原终态改成 paused；没有原终态时标记，避免落成 failed。
 *   显式取消则覆盖原状态，防止已取消的待启动活动被旁路收尾恢复成 paused。
 */
export async function abortFrozen(
  taskId: string,
  freeze: TurnFreeze,
  opts: { restorable?: boolean } = {},
): Promise<never> {
  await appendTaskTimeline(taskId, `这一轮在启动前被撤回：${freeze.reason}。`).catch(() => false);
  if (!opts.restorable || freeze.overrideRestorable) markStopped(taskId, freeze.settle);
  throw new FrozenTurn(freeze.reason);
}

/** 取事实 + 定论(不撤回)。给只要一个「现在该不该跑」答案的调用方。 */
export async function turnFreezeReason(taskId: string, checkFacts = false): Promise<TurnFreeze | null> {
  return takeFreeze(taskId, await freezeFacts(taskId, checkFacts));
}

/** 取事实 → 定论 → 撤回,一条龙。启动末段要和读授权并行的那两条路自己展开写(见上)。 */
export async function abortIfFrozen(
  taskId: string,
  opts: { checkFacts?: boolean; restorable?: boolean } = {},
): Promise<void> {
  const freeze = takeFreeze(taskId, await freezeFacts(taskId, opts.checkFacts));
  if (freeze) await abortFrozen(taskId, freeze, opts);
}
