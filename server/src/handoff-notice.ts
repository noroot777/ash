// 接力前言的投递:「你被搬过机器了」这段话怎么送到续跑的 agent 手里。
//
// 原先它是**写进 tasks.resume_prompt** 的——代价是任务一进门就长着「正等续跑指令」
// 的样子:前端据此把派审/预约/修复/预览一整排按钮判成 waiting,后端 startFreeReview
// 一类入口直接 409。接力过来的任务除了横幅上的标记外应该和本机原生任务**没有区别**
// (用户 2026-08-27 拍板),所以改成挂在 handoff 标记上,由 orchestrator 在**下一回合
// 的 prompt 里注入一次**,注入完就清。
//
// 为什么不用 scheduled_messages:那条路要求任务已经在跑(投递进活着的会话),而接力过来
// 的任务多半是停着的;而且它会在时间线上留一条「用户消息」,可这句话不是用户说的。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";
import type { TaskHandoff } from "@ash/shared";

/** 从 tasks.handoff 原始 JSON 里取出待投递的接力前言;没有就返回空串。 */
export function handoffNoticeFrom(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const marker = JSON.parse(raw) as TaskHandoff;
    return typeof marker.notice === "string" ? marker.notice : "";
  } catch {
    return "";
  }
}

/**
 * 投递完就划掉。读-改-写,但只在 notice 还在时才写:并发的两个回合最多有一个真的清掉,
 * 另一个读到的是同一段文字——重复注入一次远好过永久丢掉。
 *
 * 必须广播:handoff 标记是整行的一部分,长开的页面靠 SSE 整行更新才知道它变了
 * (同 task-resume-prompt.ts 顶部那条教训)。
 */
export async function clearHandoffNotice(taskId: string): Promise<void> {
  try {
    const row = (await db.select({ handoff: tasks.handoff }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!row?.handoff) return;
    const marker = JSON.parse(row.handoff) as TaskHandoff;
    if (!marker.notice) return;
    delete marker.notice;
    await db.update(tasks)
      .set({ handoff: JSON.stringify(marker), updatedAt: now() })
      .where(eq(tasks.id, taskId));
    await publishTaskUpdated(taskId);
  } catch (error) {
    // 清不掉最坏是下一回合再收到同一段前言,不值得让整个回合起不来。
    console.warn(`[ash] 接力前言清理失败 ${taskId}:`, error);
  }
}
