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
// ## 失效协议:写了一行就发一声
//
// 这张表的读取口(`GET /tasks/:id/notices`)还捎带着**此刻**算出来的 `remedy`(那个人工
// 救援入口该不该显示)。两样东西都会在「任务本身一个字段都没变」的情况下变化 —— 新挡回、
// 巡检写下一条诊断、锁被放开。前端那个 effect 原先只认 task.id,于是一直开着详情页的人
// 看不到后来出现的救援入口,也看不到它已经失效(第 1 轮审查 F5)。所以**真落了一行就发
// 一条 `task.notices`**(只发信号不带载荷),界面据此重读;「该不该显示」那一问由时间
// 决定、没有写入可挂,它的信号在 `turn-lock-reclaim.ts` 的巡检里发。
//
//// ## 为什么要去重
//
// 挡回往往不是单次事件:按钮没反应,用户会连点;前端还可能自动重试。一次点一条的话
// 时间线会被同一句话刷满,反而把真正的进展埋掉。所以同一个 (任务, 操作, 理由) 在
// `DEDUPE_MS` 内只记一条 —— 换了理由(挡板变了)或者隔得足够久(用户过一会儿又试了一次)
// 都算新事实,照记。
//
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { taskNotices } from "./db/schema.js";
import { id as newId, now } from "./util.js";

/** 同一条挡回在这段时间内只写一次(理由见文件头「为什么要去重」)。 */
const DEDUPE_MS = 60_000;

/**
 * 用户看得懂的操作名 —— 留痕里出现的就是这几个字,别写路由路径。
 *
 * 加一个的判据是「界面上真有这么一颗按钮」:这几个字会原样出现在任务历史里给人读,
 * 跟他按的那颗按钮对不上就等于没留痕。所以别拿它当端点清单用。
 */
export type RejectedAction =
  | "派审查" | "运行" | "触发新一轮" | "重跑上一回合" | "停止" | "申请人工授权" | "放开回合占位"
  // 自由工作流那张卡上的几颗:派合并结果审查、按意见修复、预约复审,以及驳回之后
  // 用户要拍的那两下(让双方辩论 / 裁定)。
  | "按审查意见修复" | "建修复任务" | "预约派审" | "让双方辩论" | "裁定驳回";

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
  /**
   * `unknown` = 库里那一格的值这一版认不出来(列值写丢了、或者是更新的版本写的)。
   *
   * 为什么要单独一档而不是回落 `rejected`:那两档说的是**完全相反**的两件事 ——
   * 「点了,系统没执行」和「执行了,只是没到位」。认不出来时选 `rejected`,就会对一次
   * 其实已经发生、已经改了状态的操作说「你点的操作没有执行」,用户据此再点一次。
   * 宁可说「这条记录读不准」,也不能替它编一个确定的方向。
   */
  outcome: ActionOutcome | "system" | "unknown";
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
    bus.publish({ type: "task.notices", taskId });
    return true;
  } catch (error) {
    // 去重记账要撤回,否则这条挡回会被静默吞掉整个 DEDUPE_MS。
    lastNoted.delete(key);
    console.warn(`[ash] 用户操作留痕写表失败 task=${taskId}（${action}/${outcome}）:`, error);
    console.warn(`[ash] 用户操作${outcome === "rejected" ? "被挡回" : "没到位"}（${action}）task=${taskId}：${reason}`);
    return false;
  }
}

export async function noteSystemNotice(
  taskId: string,
  eventKey: string,
  action: string,
  reason: string,
): Promise<boolean> {
  const id = `system:${createHash("sha256").update(JSON.stringify([taskId, eventKey])).digest("hex")}`;
  try {
    // `returning` 是为了分清「真写进去了」和「同一条诊断又来了一趟」:发信号要按前者,
    // 否则每 30 秒一趟的巡检会让每个开着的详情页白跑一次 GET(事件键稳定、按 id 冲突)。
    const inserted = await db.insert(taskNotices)
      .values({ id, taskId, action, outcome: "system", reason, occurredAt: now() })
      .onConflictDoNothing({ target: taskNotices.id })
      .returning({ id: taskNotices.id });
    if (inserted.length) bus.publish({ type: "task.notices", taskId });
    return true;
  } catch (error) {
    console.warn(`[ash] 系统诊断留痕写表失败 task=${taskId}（${action}）:`, error);
    return false;
  }
}

/**
 * **挡回的那一刻顺手留痕**,返回原样的响应体 —— 调用处写
 * `c.json(await noted(taskId, "运行", { error: "…" }), 409)`,路由的返回形状一个字不变
 * (前端读的还是同一个 `error` 字段)。
 *
 * 用在哪:**用户看不出原因**的那几种挡板 —— 回合正在进行、验收占用、同队有人在跑、
 * 上一回合在这中间变了。「已归档」「not found」「状态不可运行」「已接力出去」这类他
 * 一眼就能从界面上读到的,不记,免得把时间线刷成噪音。
 *
 * **只给真人点的入口用。** agent 在自己回合里调的那些口子(MCP 的驳回、辩论发言)挡回
 * 时不记 —— 记了就是把 agent 的动作写成「用户点过」,而这张表的全部用途是回答「我点过
 * 没有」。程序化路径(队列推进、消息补投、定时班次)的退避同理。
 */
export const noted = async <Body extends { error: string }>(
  taskId: string,
  action: RejectedAction,
  body: Body,
): Promise<Body> => {
  await noteRejectedUserAction(taskId, action, body.error);
  return body;
};

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
  // 列是 TEXT。`rejected` 是建表默认值,所以补列之前写的旧行读出来就是它,那一格可信。
  // 认不出的值(写丢了、或者更新的版本写的)落 `unknown` —— 不替它编一个方向,理由见
  // `RejectionNotice.outcome`。
  const KNOWN = new Set<RejectionNotice["outcome"]>(["rejected", "incomplete", "system"]);
  return rows.map((row): RejectionNotice => ({
    ...row,
    outcome: KNOWN.has(row.outcome as RejectionNotice["outcome"])
      ? (row.outcome as RejectionNotice["outcome"])
      : "unknown",
  }));
}
