// 「这条任务现在被按住了吗」—— 自动起跑、续跑、投递之前都问这一句，答案只有这一份。
//
// 两种按住，哪个成立都算：
//   · 分组暂停（groups.paused）：整组停，团队的「停止全组」也是它；
//   · 名下全部停下：上面某一条派活的任务（顺着 dispatched_by 往上，整条链）在「派出的任务」格头
//     按了「全部停下」（tasks.dispatch_hold_at）。分组是好几条任务共用的，所以这一种不能借分组暂停
//     来表达 —— 它只按住那一条名下的，同组里别处来的任务照常跑。
// 两样互不相干：哪个都没按住，任务才跑。
//
// 认这个判定的入口（任何会让一条任务**自己**起跑或续跑的地方）：
//   · 队列推进挑人、推进请求落库与重放（scheduler.ts advanceQueueAttempt、queue-advance-retry.ts）；
//   · 分组运行拉起成员（scheduler.ts runParallel）；
//   · 起跑前最后一道闸（turn-freeze.ts freezeFacts）：查多少由起跑来源定（StartOrigin，起跑入口必填），
//     无人值守的一律全查；
//   · 待发送消息投递（pending-delivery-facts.ts → pending-verdict.ts）、托盘与滞留告警的说法；
//   · 哨兵了结后的队列补推（queue-monitor-hold.ts）；
//   · 定时触发（schedules.ts：入口一次、占位后再认一次，拦下不消费班次）、重跑上一回合（task-retry-turn.ts）、智能体调 run_task（task-run-routes.ts）。
// 用户自己点「运行 / 重试」不认（分组暂停一直如此：那是用户显式要它跑）。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, tasks } from "./db/schema.js";

/** 读得动 `select` 的都行：事务里与事务外同一份判定。 */
export type HoldReader = Pick<typeof db, "select">;

export type DispatchHold = { byTaskId: string; byTitle: string };
export type TaskHold = { kind: "group"; groupId: string } | ({ kind: "dispatch" } & DispatchHold);

/**
 * 顺着 dispatched_by 往上，第一条按了「全部停下」的（不含自己）。一直走到头，不设层数上限 —— 前端
 * （web/src/lib/dispatchHold.ts）和清点名下（dispatch-hold.ts dispatchTree）都走到头，这里截断就会
 * 出现「界面说停着、服务端放行」。成环时每条只走一次。
 */
export async function dispatchHoldOf(taskId: string, reader: HoldReader = db): Promise<DispatchHold | null> {
  const seen = new Set([taskId]);
  let next = (await reader.select({ by: tasks.dispatchedBy }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.by ?? null;
  while (next && !seen.has(next)) {
    seen.add(next);
    const up = (await reader.select({ id: tasks.id, title: tasks.title, holdAt: tasks.dispatchHoldAt, by: tasks.dispatchedBy })
      .from(tasks).where(eq(tasks.id, next))).at(0);
    if (!up) return null;
    if (up.holdAt) return { byTaskId: up.id, byTitle: up.title };
    next = up.by;
  }
  return null;
}

/** 分组暂停排在前面：两样都成立时，先放开的那一样不会让任务起跑，说哪一样都对，分组那句更常见。 */
export async function taskHoldOf(task: { id: string; groupId?: string | null }, reader: HoldReader = db): Promise<TaskHold | null> {
  if (task.groupId) {
    const group = (await reader.select({ paused: groups.paused }).from(groups).where(eq(groups.id, task.groupId))).at(0);
    if (group?.paused) return { kind: "group", groupId: task.groupId };
  }
  const dispatch = await dispatchHoldOf(task.id, reader);
  return dispatch ? { kind: "dispatch", ...dispatch } : null;
}

export function dispatchHoldText(hold: DispatchHold): string {
  return `「${hold.byTitle || "未命名任务"}」名下已全部停下`;
}

export function holdText(hold: TaskHold): string {
  return hold.kind === "group" ? "所在分组已暂停" : dispatchHoldText(hold);
}
