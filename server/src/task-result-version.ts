// 「这一版成果」与「这一次失败」的身份。飞书卡片的代次（im/attention.ts）记的就是它；验收、重试接口
// 收到调用方给的期望值时，在拿到互斥（验收互斥 / 回合占位）之后按它现核：卡片是上一版的，就不能验收、
// 重试后来那一版（审查实测：旧验收卡点下去之前另一端又跑完一轮，验收的是用户没看过的新成果）。
//   成果  这一版的结束时刻；团队调度台取共享执行者里最晚结束的、和它自己最近一轮开始的那个里更晚的一个
//         （任何一个共享执行者又跑完、调度台自己又跑了一轮，成果就换了一版）。只算共享执行者：开独立 worktree
//         的那些改不到团队的工作目录、团队验收也不给它们盖章，算进来只会让卡片无故失配；这一批也正是团队验收
//         占住、冻住的那一批（team-acceptance-hold.ts）。调度台每轮收尾落回 idle、
//         不是终态，tasks.ended_at 一直空着，它自己的回合只能从 session_turns 认（第 1 轮审查后的
//         对抗复核实测：门禁跑着时调度台自己改了共享工作区，绿了照样替旧卡验收）。
//   失败  这一次失败的结束时刻（重试后再失败就换了）
// 不传期望值的调用方（网页、MCP）照旧：它们点的是眼前这一版。
import { eq, max } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessionTurns, tasks } from "./db/schema.js";

type Ended = { endedAt?: string | null };

/** 共享执行者：不开独立 worktree、跟调度台共用一个工作目录的那些。成果版本、验收占位、联动盖章三处共用这一个判据。 */
export const isSharedTeamWorker = (worker: { useWorktree: boolean }): boolean => !worker.useWorktree;

/** 一组结束时刻里最晚的那个；都没有记 "-"。 */
function latestEnd(items: Ended[]): string {
  return items.map((item) => item.endedAt ?? "").reduce((max, at) => (at > max ? at : max), "") || "-";
}

export function failureVersionOf(task: Ended & { updatedAt: string }): string {
  return task.endedAt ?? task.updatedAt;
}

/** 此刻这一版成果的身份（团队调度台连同它的共享执行者和它自己的回合）。飞书卡片的代次也用这一份。 */
export async function resultVersionOf(task: Ended & { id: string; mode: string; parentId?: string | null }): Promise<string> {
  if (task.mode !== "team" || task.parentId) return latestEnd([task]);
  const [crew, lead] = await Promise.all([
    db.select({ endedAt: tasks.endedAt, useWorktree: tasks.useWorktree }).from(tasks).where(eq(tasks.parentId, task.id)),
    db.select({ at: max(sessionTurns.startedAt) }).from(sessionTurns).where(eq(sessionTurns.taskId, task.id)),
  ]);
  return latestEnd([task, ...crew.filter(isSharedTeamWorker), { endedAt: lead[0]?.at ?? null }]);
}
