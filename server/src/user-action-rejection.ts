// ── 被挡回的用户操作:留一条持久可见的痕迹 ───────────────────────────────────
// 用户点「派审查」被挡回(任务正等答复/续跑、回合正在进行),界面上只弹一次 toast ——
// 刷新页面之后**什么都看不出来**:点过没有、为什么没成,全凭记忆。2026-10-26 那次卡死里
// 用户因此两次误判:先以为按钮坏了,后以为任务已经跑完。`/run` 的 409 同病。
//
// 判据沿用 AGENTS.md「停止/暂停必须留下持久可见的状态」:**用户刷新页面后仍能看出
// 「我点过、它没成、因为什么」**。所以挡回的那一刻往任务时间线写一条,和「预约审查」、
// 「预览起停」那些系统说明走同一条通道(`appendTaskTimeline` 的 aside 事件),用户在
// 对话流里按时间顺序就能读到。
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
import { appendTaskTimeline } from "./task-timeline.js";

/** 同一条挡回在这段时间内只写一次(理由见文件头「为什么要去重」)。 */
const DEDUPE_MS = 60_000;

/** 用户看得懂的操作名 —— 写进时间线的就是这几个字,别写路由路径。 */
export type RejectedAction = "派审查" | "运行" | "触发新一轮" | "重跑上一回合" | "停止";

const lastNoted = new Map<string, number>();

/**
 * 记下「用户点了什么、被什么挡回」。**不抛**:留痕失败绝不能把那条 409 响应也带翻
 * (用户至少还看得见 toast)。
 *
 * 返回是否真的写进了时间线 —— 从没跑过的任务还没有会话可写,那种只留日志。
 */
export async function noteRejectedUserAction(
  taskId: string,
  action: RejectedAction,
  reason: string,
): Promise<boolean> {
  try {
    const key = `${taskId}\u0000${action}\u0000${reason}`;
    const at = Date.now();
    const previous = lastNoted.get(key);
    if (previous !== undefined && at - previous < DEDUPE_MS) return false;
    lastNoted.set(key, at);
    // 过期条目顺手清掉:这张表只为去重,不该随运行时长无界增长。
    for (const [existing, when] of lastNoted) {
      if (at - when >= DEDUPE_MS) lastNoted.delete(existing);
    }
    const wrote = await appendTaskTimeline(
      taskId,
      `〔系统〕你点的「${action}」这一次没有执行：${reason}`,
    );
    if (!wrote) console.warn(`[ash] 用户操作被挡回（${action}）task=${taskId}：${reason}`);
    return wrote;
  } catch (error) {
    console.warn(`[ash] 记录被挡回的用户操作失败 task=${taskId}（${action}）:`, error);
    return false;
  }
}
