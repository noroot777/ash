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

// ── 接力准备 barrier ─────────────────────────────────────────────────────────
// 导出准备期(exportHandoff 从首个网络 await 到收尾)要求「任务不在队列」是稳定不变量:
// 一次性的只读检查会被 TOCTOU 绕过——检查通过后,对端 ping 的网络等待里并发
// POST /queues/:id/insert 把任务插进队列,随后导出把它结算成 canceled,队列推进对
// canceled 透明跳过,源机提前启动后继(第 2 轮审查用延迟 2 秒的 ping 代理实测)。
// 所以接力在首个网络 await 前占住 barrier,queues.ts 的 insert/create 在改成员前
// 检查它;占到 barrier 后导出侧还要复查一次队列成员(占之前的检查可能已过期)。
// 用进程内存而不是持久标记:singleton.ts 保证同一 DB 只有一个 server 进程,进程
// 崩溃时 barrier 自然消失,不像持久标记那样留下要人工清理的残留。
const preparing = new Set<string>();

/** 占住接力准备 barrier;已被占(同任务并发第二次接力)返回 false。 */
export function beginHandoffPrepare(taskId: string): boolean {
  if (preparing.has(taskId)) return false;
  preparing.add(taskId);
  return true;
}

export function endHandoffPrepare(taskId: string): void {
  preparing.delete(taskId);
}

/** 队列成员变更入口(queues.ts insert/create)用:任务是否正处于接力导出准备期。 */
export function isHandoffPreparing(taskId: string): boolean {
  return preparing.has(taskId);
}
