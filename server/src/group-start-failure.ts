import { eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, tasks } from "./db/schema.js";
import { freshRunFailureTarget, reportTurnFailure } from "./turn-failure.js";

/**
 * 这条失败交代**写给谁**。
 *
 *  · `{ taskId }`      —— 单个成员自己那次启动失败(runParallel 的 launch catch)。
 *  · `{ attempted }`   —— 整组启动在后台抛了。名单是**这一次确实挑中要启动的那些成员**,
 *                         不是「谁在这个分组里」。
 *
 * 为什么必须是前者:按 `groupId` 全捞一遍、一个条件都不加,数据库抖一下就会给每一个成员
 * 都塞一条「这一轮没能起跑」—— 包括几天前就完成的、已归档的、以及压根不参与分组启动的
 * 团队调度台(第 2 轮审查必须修 2 实测:8 个成员全收到,其中 4 个与本次启动毫无关系,
 * 还各被插了一条诊断会话行、刷新后仍在)。这恰好撞上 `reportTurnFailure` 自己写下的判据:
 * 「另一位的时间线里不该冒出不属于它的失败」。
 */
export type GroupFailureScope = { taskId: string } | { attempted: string[] };

export async function reportGroupStartFailure(groupId: string, error: unknown, scope: GroupFailureScope): Promise<void> {
  const message = `分组本次启动未完成：${error instanceof Error ? error.message : String(error)}`;
  const single = "taskId" in scope ? scope.taskId : null;
  console.error(`[ash] group=${groupId}${single ? ` task=${single}` : ""} ${message}`, error);
  try {
    const targets = "taskId" in scope ? [scope.taskId] : scope.attempted;
    const members = targets.length
      ? await db.select().from(tasks).where(inArray(tasks.id, targets))
      : [];
    const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
    // 发起这次启动的调度台单列:它是「谁在等这个结果」的那一位,哪怕一个成员都没挑中
    // (失败发生在读库那几步)也该告诉它。已归档的调度台不写 —— 归档了就不该再冒新消息。
    if (!single && group?.ownerTaskId && !members.some((task) => task.id === group.ownerTaskId)) {
      members.push(...(await db.select().from(tasks).where(eq(tasks.id, group.ownerTaskId)))
        .filter((task) => !task.archived));
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
