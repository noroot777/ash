// 「这一版成果」与「这一次失败」的身份。飞书卡片的代次（im/attention.ts）记的就是它；验收、重试接口
// 收到调用方给的期望值时，在拿到互斥（验收互斥 / 回合占位）之后按它现核：卡片是上一版的，就不能验收、
// 重试后来那一版（审查实测：旧验收卡点下去之前另一端又跑完一轮，验收的是用户没看过的新成果）。
//   成果  这一版的结束时刻；团队调度台取它和执行者里最晚的那个（任何一个执行者又跑完，成果就换了一版）
//   失败  这一次失败的结束时刻（重试后再失败就换了）
// 不传期望值的调用方（网页、MCP）照旧：它们点的是眼前这一版。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

type Ended = { endedAt?: string | null };

/** 一组结束时刻里最晚的那个；都没有记 "-"。 */
export function latestEnd(items: Ended[]): string {
  return items.map((item) => item.endedAt ?? "").reduce((max, at) => (at > max ? at : max), "") || "-";
}

export function failureVersionOf(task: Ended & { updatedAt: string }): string {
  return task.endedAt ?? task.updatedAt;
}

/** 此刻这一版成果的身份（团队调度台连同它的执行者）。 */
export async function resultVersionOf(task: Ended & { id: string; mode: string; parentId: string | null }): Promise<string> {
  const crew = task.mode === "team" && !task.parentId
    ? await db.select({ endedAt: tasks.endedAt }).from(tasks).where(eq(tasks.parentId, task.id))
    : [];
  return latestEnd([task, ...crew]);
}
