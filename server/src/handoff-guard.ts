// 接力出去的任务在本机的「硬拦截」判定,所有会改变任务/工作区的入口(启动类:
// runTask/continueTask/各 HTTP 路由/定时班次;写入类:验收、派审、预览、状态修改、
// 阶段流转)共用这一个函数,避免每处自己解析 JSON 各写各的。
// 只拦 direction === "out"(含 pending 未确认态):接力进来的("in")任务本来就
// 该在本机跑。允许的操作是明确白名单:只读、停止、归档、删除、移除接力标记、
// 接力收口重试——这些要么不改任务,要么正是清理「历史存档」该有的动作。
// handoffBlockReason 零外部依赖;handoffBlockReasonById 只引 db(叶子依赖,不成环),
// 给手里只有 task id 的路由用。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

export function handoffBlockReason(handoff: string | null | undefined): string | null {
  if (!handoff) return null;
  try {
    const h = JSON.parse(handoff) as { direction?: string; pending?: boolean; peerName?: string | null };
    if (h?.direction !== "out") return null;
    return h.pending
      ? "任务正在接力到另一台机器（还没确认送达）。重试接力完成收口，或先移除接力标记再在本机继续。"
      : `任务已接力到${h.peerName ? `「${h.peerName}」` : "另一台机器"}继续执行，本机这份是历史存档。要在本机继续，先移除接力标记。`;
  } catch {
    return null;
  }
}

/** 手里只有 task id 时的同款判定:查一列就走,任务不存在按不拦处理(让入口自己 404)。 */
export async function handoffBlockReasonById(taskId: string): Promise<string | null> {
  const row = (await db
    .select({ handoff: tasks.handoff })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  return row ? handoffBlockReason(row.handoff) : null;
}
