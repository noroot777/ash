// 看门狗熔断掉的那一轮:**「这一轮是失败的」这个结论本身**,按回合身份存着。
//
// 跟 `turn-failure.ts` 不是一件事(名字别看混):那边讲的是**一个回合连起跑都没成**时用户
// 那边能看见什么;这里讲的是**一个已经在跑的回合被我们判了死刑**,而这个判决要怎么传到结算。
//
// 为什么要单独存一份,而不是让各条链各自记一个布尔(第 1 轮审查第 2 条,已实测):熔断是
// 「我们主动杀掉一个还在跑的回合」,而**被杀的进程报不出非零退出码** ——
//   · claude 走信号退出时 `claude-stream.ts` 写的是 `code ?? 0`,信号退出 `code` 是 null,
//     于是退出码 **0**;
//   · codex 的 `kill()` 会置 `stopRequested`,它自己那份失败诊断跟着被咽掉;
//   · 团队常驻台更彻底:`endTurn` 走的是执行器自己报的 turnEnd,那条路**无条件**记
//     `outcome:"completed"`。
// 三条路叠起来的后果是同一个:时间线上红着写「已终止本回合并按失败结算」,而回合区间记
// `completed`、任务落 `done` —— 看门狗说过的话一句都没兑现。所以结论不能靠退出码反推,得由
// **下结论的那一方**写下来,再由 span / 会话 / 任务结算三处各自读。
//
// 键是 `(sessionId, turnStartedAt)` 这个**回合身份**而不是 sessionId:常驻台一条会话跑很多
// 轮,只有熔断掉的那一轮该算失败,下一轮正常答完仍然是成功(同一个理由见 turn-stall.ts 的
// 持有者+回合双判,以及 session-waiting.ts 的换台闸)。
//
// 刻意**不落库**:它只在「同一个进程里杀掉回合 → 紧接着结算这一轮」这段几十毫秒内有用。
// 跨 server 重启那一种本来就走另一条路(重启后接回 → 进程没了 → `closeLead` / 验尸诊断按
// 真实非零退出判失败),不需要这份内存事实。
import { now } from "./util.js";

export interface StallVerdict {
  /** 判失败的原因原文(熔断诊断那一段),给结算侧需要时转述。 */
  reason: string;
  at: string;
}

const failures = new Map<string, StallVerdict>();

/**
 * 回收**只认时间,不认条数**。
 *
 * 上一版留的是条数水位(KEEP=64,超了从最老的扔),那是反的:被扔掉的恰恰是**还没结算**的那
 * 一条。断网会同时波及很多台(「每组限流 4」限的是单个分组,不是整进程的会话数),实测 65 个
 * 回合先全部熔断、再统一收到结束回执时,最早那一轮的判决已经被挤掉,`endTurn` 读不到于是记成
 * `completed` —— 时间线上明明白白写着「按失败结算」,区间却是成功(第 2 轮审查 F2,已实测:
 * 1 completed / 64 failed)。
 *
 * 所以不变量是:**判决一直留着,直到对应回合自己来销账**(`clearStallFailure`,各链在结算之后
 * 调)。容量清理只许碰**明确孤立**的那些 —— 久到不可能还有人来结算的。
 *
 * 为什么不怕它涨:每一条都要先有一次真实熔断(默认 30 分钟只收到错误事件)才写得出来,所以
 * 条数天然被「同时卡住的会话数」限住,而一条就几百字节。跨 server 重启这张表本来就是空的
 * (进程内状态),所以「孤立」只可能来自同一进程里某条链连结算都没走到 —— 那种残留等 TTL
 * 到了自己消失,不必也不许去挤掉活的。
 */
const ORPHAN_MS = 6 * 60 * 60_000;

const key = (sessionId: string, turnStartedAt: string): string => `${sessionId}\u0000${turnStartedAt}`;

/**
 * 顺手清掉明确孤立的那些(写入时做,不另起计时器:这张表只在熔断时被写,频率极低)。
 *
 * **只按时间判,绝不按条数** —— 判据见 ORPHAN_MS 那段。
 */
function sweepOrphans(cutoffMs: number): void {
  for (const [k, verdict] of failures) {
    const at = Date.parse(verdict.at);
    // 时间戳读不出来就留着:宁可多留一条孤立记录,也不能因为解析失败丢掉一条活判决。
    if (Number.isFinite(at) && at <= cutoffMs) failures.delete(k);
  }
}

/** 看门狗熔断:把「这一轮失败」钉在这个回合身份上。 */
export function markStallFailure(sessionId: string, turnStartedAt: string, reason: string): void {
  const at = now();
  failures.set(key(sessionId, turnStartedAt), { reason, at });
  const cutoff = Date.parse(at) - ORPHAN_MS;
  if (Number.isFinite(cutoff)) sweepOrphans(cutoff);
}

/** 这个回合身份有没有被看门狗判过失败。读不清掉 —— 同一轮有三处要读(span/会话/任务)。 */
export function stallFailure(sessionId: string, turnStartedAt: string | null): StallVerdict | null {
  if (!turnStartedAt) return null;
  return failures.get(key(sessionId, turnStartedAt)) ?? null;
}

/**
 * 这一轮结算完了:销账。
 *
 * **这是唯一的正常出口** —— 三条链都得调(单飞在 settle 之后、团队在 endTurn/closeLead 逐轮、
 * 讨论在 recordTurnSpan 之后)。漏掉的那一条要等 ORPHAN_MS 才消失,而在那之前它一直占着内存,
 * 所以漏不是「没后果」,只是后果被兜住了。
 */
export function clearStallFailure(sessionId: string, turnStartedAt: string | null): void {
  if (!turnStartedAt) return;
  failures.delete(key(sessionId, turnStartedAt));
}

/** 只给回归测试。 */
export function __resetStallFailures(): void {
  failures.clear();
}

/**
 * 只给回归测试:把现存判决的时间戳往前挪 `ms`,用来跑孤立回收那一路(不然得等 6 小时)。
 * 回收发生在下一次 `markStallFailure` 里,所以测试得在挪完之后再写一条。
 */
export function __ageStallFailures(ms: number): void {
  for (const [k, verdict] of failures) {
    failures.set(k, { ...verdict, at: new Date(Date.parse(verdict.at) - ms).toISOString() });
  }
}
