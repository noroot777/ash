import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, tasks } from "./db/schema.js";
import { freshRunFailureTarget, reportTurnFailure } from "./turn-failure.js";

export async function reportGroupStartFailure(groupId: string, error: unknown, taskId?: string): Promise<void> {
  const message = `分组本次启动未完成：${error instanceof Error ? error.message : String(error)}`;
  console.error(`[ash] group=${groupId}${taskId ? ` task=${taskId}` : ""} ${message}`, error);
  try {
    const members = taskId
      ? await db.select().from(tasks).where(eq(tasks.id, taskId))
      : await db.select().from(tasks).where(eq(tasks.groupId, groupId));
    const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
    if (!taskId && group?.ownerTaskId && !members.some((task) => task.id === group.ownerTaskId)) {
      members.push(...await db.select().from(tasks).where(eq(tasks.id, group.ownerTaskId)));
    }
    for (const task of members) {
      try {
        const target = await freshRunFailureTarget(task, null);
        await reportTurnFailure({ taskId: task.id, message, role: "single", target });
      } catch (reportError) {
        console.error(`[ash] 分组启动失败交代写入失败 task=${task.id}:`, reportError);
      }
    }
  } catch (reportError) {
    console.error(`[ash] 分组启动失败交代读取失败 group=${groupId}:`, reportError);
  }
}
