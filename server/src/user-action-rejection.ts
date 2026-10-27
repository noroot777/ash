// ── 被挡回的用户操作:留一条持久可见的痕迹 ───────────────────────────────────
// 用户点「派审查」被挡回(任务正等答复/续跑、回合正在进行),界面上只弹一次 toast ——
// 刷新页面之后**什么都看不出来**:点过没有、为什么没成,全凭记忆。2026-10-26 那次卡死里
// 用户因此两次误判:先以为按钮坏了,后以为任务已经跑完。`/run` 的 409 同病。
//
// 判据沿用 AGENTS.md「停止/暂停必须留下持久可见的状态」:**用户刷新页面后仍能看出
// 「我点过、它没成、因为什么」**。
//
// ## 两处落点,各管一段,缺一不可
//
// ① `task_notices` 表 —— **权威记录,每次都写**。它不依赖 agent 会话,这是关键:
//    `appendTaskTimeline` 要往某条会话的 transcript 文件里写,任务从没跑过就没有会话、
//    那条路只会 return false 加一行 warn。而「点运行被同队前项挡回」最常发生的正是一个
//    **刚排进队列、还没跑过**的任务 —— 最该留痕的那一档原本一个字都留不下(本轮审查 F4)。
//    前端在对话流空态里读这张表(`GET /api/tasks/:id/notices`)。
// ② 会话时间线 —— **有会话才写**。跑过的任务,用户是在对话流里按时间顺序读进展的,
//    挡回这件事也该落在它发生的那一刻,和「预约审查」「预览起停」同一条通道(aside 事件)。
//
// 两边不会重复出现:空态只在对话流一条都没有时才渲染,那时 ② 必然没写成。
//
// ## 为什么要去重
//
// 挡回往往不是单次事件:按钮没反应,用户会连点;前端还可能自动重试。一次点一条的话
// 时间线会被同一句话刷满,反而把真正的进展埋掉。所以同一个 (任务, 操作, 理由) 在
// `DEDUPE_MS` 内只记一条 —— 换了理由(挡板变了)或者隔得足够久(用户过一会儿又试了一次)
// 都算新事实,照记。
//
// ## 不记什么
//
// 只记**用户主动操作被挡回**。程序化路径(队列推进、消息补投、定时班次)被挡是正常退避,
// 它们自己会重试,记进时间线只会变成噪音 —— 那些的可观察性归日志和托盘。
import { and, desc, gte, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { taskNotices } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id as newId, now } from "./util.js";

/** 同一条挡回在这段时间内只写一次(理由见文件头「为什么要去重」)。 */
const DEDUPE_MS = 60_000;

/** 用户看得懂的操作名 —— 留痕里出现的就是这几个字,别写路由路径。 */
export type RejectedAction =
  | "派审查" | "运行" | "触发新一轮" | "重跑上一回合" | "停止" | "放开回合占位";

/**
 * 空态里回看多久以内的挡回。挡回是「刚才那一下没成」,不是任务历史 —— 窗口之外的不再
 * 顶在用户眼前(真要追溯有日志和会话时间线)。表只增不删,靠这个窗口自然退场。
 */
export const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const lastNoted = new Map<string, number>();

export type RejectionNotice = { action: string; reason: string; occurredAt: string };

/**
 * 记下「用户点了什么、被什么挡回」:写表(权威)+ 有会话就再写一条会话时间线。
 * **不抛**:留痕失败绝不能把那条 409 响应也带翻(用户至少还看得见 toast)。
 *
 * 返回是否真的留下了持久痕迹 —— 两处落点有任一成功就算留住了。
 */
export async function noteRejectedUserAction(
  taskId: string,
  action: RejectedAction,
  reason: string,
): Promise<boolean> {
  const key = `${taskId}\u0000${action}\u0000${reason}`;
  const at = Date.now();
  const previous = lastNoted.get(key);
  if (previous !== undefined && at - previous < DEDUPE_MS) return false;
  lastNoted.set(key, at);
  // 过期条目顺手清掉:这张去重表不该随运行时长无界增长。
  for (const [existing, when] of lastNoted) {
    if (at - when >= DEDUPE_MS) lastNoted.delete(existing);
  }
  // 两处落点各自容错:表写失败不该连累会话时间线,反之亦然。任何一处成了就算留住了。
  let persisted = false;
  try {
    await db.insert(taskNotices).values({
      id: newId(), taskId, action, reason, occurredAt: now(),
    });
    persisted = true;
  } catch (error) {
    // 去重记账要撤回,否则这条挡回会被静默吞掉整个 DEDUPE_MS。
    lastNoted.delete(key);
    console.warn(`[ash] 被挡回的用户操作写表失败 task=${taskId}（${action}）:`, error);
  }
  try {
    if (await appendTaskTimeline(taskId, `〔系统〕你点的「${action}」这一次没有执行：${reason}`)) {
      persisted = true;
    }
  } catch (error) {
    console.warn(`[ash] 被挡回的用户操作写会话时间线失败 task=${taskId}（${action}）:`, error);
  }
  if (!persisted) console.warn(`[ash] 用户操作被挡回（${action}）task=${taskId}：${reason}`);
  return persisted;
}

/**
 * 这个任务最近被挡回的那些操作(新的在前)。给对话流空态用 —— 从没跑过的任务没有会话
 * 时间线可读,这是它唯一的痕迹来源。
 */
export async function recentRejectionNotices(
  taskId: string,
  limit = 5,
  windowMs = NOTICE_WINDOW_MS,
): Promise<RejectionNotice[]> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = await db
    .select({ action: taskNotices.action, reason: taskNotices.reason, occurredAt: taskNotices.occurredAt })
    .from(taskNotices)
    .where(and(eq(taskNotices.taskId, taskId), gte(taskNotices.occurredAt, since)))
    .orderBy(desc(taskNotices.occurredAt))
    .limit(limit);
  return rows;
}
