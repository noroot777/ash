// 「欠一次起跑」那一笔（tasks.hold_owed_by）。单独成文件是为了让调度主路径（scheduler.ts）能直接
// 记账，又不把停 / 续那一整套（dispatch-hold.ts，它反过来要推队列）拖进来绕成环。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

/**
 * 这一位本该起跑、被 `holderId` 按住了：记下来，「接着跑」时兑现。已经记着别的按住人的照样
 * 改成这一个 —— 兑现时还被别处按着，会在起跑那道闸上再被拦一次、再记一次，不会丢。
 * 写不进去只打日志：少记一笔的后果是接着跑之后这一位要人手点一下「运行」，不能为它把调度卡住。
 */
export async function oweHeldStart(taskId: string, holderId: string): Promise<void> {
  try {
    await db.update(tasks).set({ holdOwedBy: holderId }).where(eq(tasks.id, taskId));
  } catch (error) {
    console.error(`[ash] 记「欠一次起跑」失败 task=${taskId} holder=${holderId}:`, error);
  }
}
