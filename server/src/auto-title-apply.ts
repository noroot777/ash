// 把认出来的自动标题**落库并广播**。解析在 `auto-title.ts`(纯函数,不碰库);这里是它唯一的
// 写入口,单飞(single-run.ts)和讨论(duet/index.ts)两条起名路共用。
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { now } from "./util.js";

/**
 * 没给标题就什么也不做:任务留着建它时那个临时名(body 首行),下一次 fresh run 还会再试一次
 * —— autoTitle 只在真的改成时才关。
 *
 * 条件里带上 auto_title=1:**起名跑到一半时任务可能已经被显式改过名了** —— 用户在界面上改,
 * 或者 agent 自己调 patch_task 改。那句改名的语义是「这就是标题」,不该被随后吐出来的
 * `标题：xxx` 盖回去。调用方手上那份快照答不了「此刻库里还允不允许自动命名」,只有库自己答得
 * 了(先查一眼再写的那一版,查和写之间被改的名照样被盖掉)。没更新到行就当什么都没发生,连事件
 * 也不发。
 */
export async function applyAutoTitle(taskId: string, newTitle: string | null): Promise<void> {
  if (!newTitle) return;
  const updatedAt = now();
  const hit = await db
    .update(tasks)
    .set({ title: newTitle, autoTitle: false, updatedAt })
    .where(and(eq(tasks.id, taskId), eq(tasks.autoTitle, true)))
    .returning({ id: tasks.id });
  if (!hit.length) return;
  bus.publish({ type: "task.title", taskId, title: newTitle, updatedAt });
}
