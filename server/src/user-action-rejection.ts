// ── 被挡回的用户操作:留一条持久可见的痕迹 ───────────────────────────────────
// 用户点「派审查」被挡回(任务正等答复/续跑、回合正在进行),界面上只弹一次 toast ——
// 刷新页面之后**什么都看不出来**:点过没有、为什么没成,全凭记忆。2026-10-26 那次卡死里
// 用户因此两次误判:先以为按钮坏了,后以为任务已经跑完。`/run` 的 409 同病。
//
// 判据沿用 AGENTS.md「停止/暂停必须留下持久可见的状态」:**用户刷新页面后仍能看出
// 「我点过、它没成、因为什么」**。
//
// ## 一处落点:`task_notices` 表
//
// 上一版写两处(表 + 会话正文),前端只在对话流**空的时候**读表。于是同一段历史有两种
// 可见性:任务一旦跑出正文,通知组件整个卸载,第一次被拒的记录还在库里却再也显示不出来
// (第 2 轮审查 F4)。同一个判据还有第二个受害者 —— 有会话但 transcript 写失败(磁盘满、
// 权限)时只有表写成了,而「有正文」又让 UI 永远不显示它。
//
// 根子是**「存进表」和「形成可见历史」被当成了两件事**。所以改成一处落点:只写表,
// 前端把它按时间合进同一条任务历史(和会话正文的 aside 事件并排),不去问「有没有正文」。
// 这样也不再需要在两份记录之间去重。
//
// 为什么不是反过来(只写会话正文):那条路要求任务**至少跑过一次** —— 没有会话就没有
// transcript 文件可写,只会 return false 加一行 warn。而「点运行被同队前项挡回」最常
// 发生的正是一个刚排进队列、还没跑过的任务。
//// ## 为什么要去重
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
import { desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { taskNotices } from "./db/schema.js";
import { id as newId, now } from "./util.js";

/** 同一条挡回在这段时间内只写一次(理由见文件头「为什么要去重」)。 */
const DEDUPE_MS = 60_000;

/** 用户看得懂的操作名 —— 留痕里出现的就是这几个字,别写路由路径。 */
export type RejectedAction =
  | "派审查" | "运行" | "触发新一轮" | "重跑上一回合" | "停止" | "放开回合占位";

/**
 * 这一下的结果。**不是同一句话的两种语气,是两件不同的事**,所以存下来而不是让前端去猜:
 *   · `rejected`   点了没执行(409 挡回);
 *   · `incomplete` 执行了但没到位 —— 「放开回合占位」成功放开了锁、任务却还停在 queued
 *     点不动的那一档(第 1 轮审查 F3)。把它也记成「没有执行」是假话,而不记就等于开关
 *     一从界面上消失,那句「接着该做什么」也跟着没了。
 */
export type ActionOutcome = "rejected" | "incomplete";

/**
 * 一次取回多少条。**没有时间窗** —— 这是任务历史的一部分,不是「刚才那一下」的提示:
 * 上一版砍到最近 24 小时,窗口之外的记录还在库里却无法从界面追溯(第 2 轮审查 F4)。
 * 上限只防一个任务被连点出几百条时把列表撑爆,取够大的值。
 */
const NOTICE_LIMIT = 200;

const lastNoted = new Map<string, number>();

export type RejectionNotice = {
  id: string;
  action: string;
  outcome: ActionOutcome;
  reason: string;
  occurredAt: string;
};

/** 记下「用户点了什么、被什么挡回」(`rejected` 那一档的薄封装)。 */
export function noteRejectedUserAction(
  taskId: string,
  action: RejectedAction,
  reason: string,
): Promise<boolean> {
  return noteUserActionOutcome(taskId, action, "rejected", reason);
}

/**
 * 记下「用户点了什么、结果是什么」。**不抛**:留痕失败绝不能把那条响应也带翻
 * (用户至少还看得见 toast)。返回是否真的留下了持久痕迹。
 */
export async function noteUserActionOutcome(
  taskId: string,
  action: RejectedAction,
  outcome: ActionOutcome,
  reason: string,
): Promise<boolean> {
  const key = `${taskId}\u0000${action}\u0000${outcome}\u0000${reason}`;
  const at = Date.now();
  const previous = lastNoted.get(key);
  if (previous !== undefined && at - previous < DEDUPE_MS) return false;
  lastNoted.set(key, at);
  // 过期条目顺手清掉:这张去重表不该随运行时长无界增长。
  for (const [existing, when] of lastNoted) {
    if (at - when >= DEDUPE_MS) lastNoted.delete(existing);
  }
  try {
    await db.insert(taskNotices).values({ id: newId(), taskId, action, outcome, reason, occurredAt: now() });
    return true;
  } catch (error) {
    // 去重记账要撤回,否则这条挡回会被静默吞掉整个 DEDUPE_MS。
    lastNoted.delete(key);
    console.warn(`[ash] 用户操作留痕写表失败 task=${taskId}（${action}/${outcome}）:`, error);
    console.warn(`[ash] 用户操作${outcome === "rejected" ? "被挡回" : "没到位"}（${action}）task=${taskId}：${reason}`);
    return false;
  }
}

/**
 * 这个任务被挡回过的那些操作(新的在前)。前端把它合进任务历史 —— **不按「有没有正文」
 * 取舍**,那正是上一版把历史弄丢的判据(见文件头)。
 */
export async function recentRejectionNotices(
  taskId: string,
  limit = NOTICE_LIMIT,
): Promise<RejectionNotice[]> {
  const rows = await db
    .select({
      id: taskNotices.id,
      action: taskNotices.action,
      outcome: taskNotices.outcome,
      reason: taskNotices.reason,
      occurredAt: taskNotices.occurredAt,
    })
    .from(taskNotices)
    .where(eq(taskNotices.taskId, taskId))
    .orderBy(desc(taskNotices.occurredAt))
    .limit(limit);
  // 列是 TEXT,旧行(补列之前写的)读出来是默认值。认不出的一律当 rejected —— 多一档
  // 新语气要前端配合,认错方向不如退回最保守的那一句。
  return rows.map((row) => ({ ...row, outcome: row.outcome === "incomplete" ? "incomplete" as const : "rejected" as const }));
}
