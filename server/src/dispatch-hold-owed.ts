// 「欠一次起跑」那一笔（tasks.hold_owed_by）：这一条本该起跑、被「名下全部停下」按住了，记的是按住
// 它的那条任务。单独成文件是为了让调度主路径（scheduler.ts、status.ts）能直接记账、消费，又不把
// 停 / 续那一整套（dispatch-hold.ts，它反过来要推队列、起任务）拖进来绕成环。
//
// **这笔账只由「真的了结」消费**，跟状态写入同一条 UPDATE（`holdOwedPatch`，status.ts 每一笔都调）：
//   · 执行回合真起跑了（status → running，不是旁路回合），而且按住它的那条此刻已经不停着 —— 停着
//     期间用户自己点「运行」那一轮不算兑现，跑完回到暂停照样欠着；
//   · 落了终态（done / failed / canceled）—— 做完了、失败了、被用户单独停掉了，都不再欠一次起跑。
// 「接着跑」本身不销账，它只是把停着的标记清掉、去试一次（dispatch-hold.ts）。试的那一刻起不来的
// （还在退出、回合锁被占、起跑抛错、服务正好重启）账还在，由状态落位那一刻的监听和调度 tick 的巡检
// 再兑现，直到上面两种了结之一发生。
import { and, eq, sql } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

/**
 * 记一笔：这一位本该起跑、被 `holderId` 按住了。已经记着别的按住人的改成这一个 —— 兑现时还被别处
 * 按着，会在起跑那道闸上再被拦一次、再记一次。**写不进去就抛**：吞掉的话这一位就成了「停之前就
 * 停着的」，接着跑时再也没人叫它；调用方各自的失败出路（队列推进重试、路由报错、起跑落 failed）
 * 都比静默丢账好。
 */
export async function oweHeldStart(taskId: string, holderId: string): Promise<void> {
  await db.update(tasks).set({ holdOwedBy: holderId }).where(eq(tasks.id, taskId));
}

/** 只撤自己刚记的那一笔（停的那一下最后发现没停到它）。 */
export async function forgetHeldStart(taskId: string, holderId: string): Promise<void> {
  await db.update(tasks).set({ holdOwedBy: null }).where(and(eq(tasks.id, taskId), eq(tasks.holdOwedBy, holderId)));
}

/** 跟这一笔状态写入同一条 UPDATE 落下的 `hold_owed_by`（规则见文件头）。空对象 = 不动它。 */
export function holdOwedPatch(status: TaskStatus, opts: { sideTurn: boolean }): { holdOwedBy?: ReturnType<typeof sql> | null } {
  if (status === "done" || status === "failed" || status === "canceled") return { holdOwedBy: null };
  if (status !== "running" || opts.sideTurn) return {};
  // 按住它的那条还停着（用户在停着期间自己点了运行）：账留着。
  return {
    // 外层那一行写全限定名：UPDATE 的 SET 里 drizzle 只渲染裸列名，进了子查询会被认成 holder 的列。
    holdOwedBy: sql`CASE WHEN EXISTS (SELECT 1 FROM tasks AS holder WHERE holder.id = "tasks"."hold_owed_by"
      AND holder.dispatch_hold_at IS NOT NULL) THEN "tasks"."hold_owed_by" ELSE NULL END`,
  };
}
