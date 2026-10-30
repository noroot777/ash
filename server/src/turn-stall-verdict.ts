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

interface Entry extends StallVerdict {
  /**
   * 这个回合身份**退场**的时刻(`null` = 还在跑)。
   *
   * 由 `turn-stall.ts` 在那条停滞记录离开状态机时填(真实收口、摘牌、或被新一轮顶掉)——
   * 也就是「不会再有人往这一轮里写东西了」那一刻。回收只看它,见 ORPHAN_MS。
   */
  retiredAt: string | null;
}

const failures = new Map<string, Entry>();

/**
 * 回收**只认生命周期**:一条判决要么还归某个在跑的回合,要么已经退场够久了。
 *
 * 这一处被打回过两次,两次都是「拿淘汰策略代替生命周期」:
 *   · 第 2 轮是条数水位(KEEP=64,超了扔最老的)—— 扔掉的恰恰是还没结算那一条。断网会同时
 *     波及很多台,实测 65 个回合先全部熔断、再统一收到结束回执时,最早那一轮的判决已经被挤掉,
 *     `endTurn` 读不到于是记成 `completed`(1 completed / 64 failed)。
 *   · 第 3 轮是纯年龄 TTL —— **老不等于孤立**。`ASH_STALL_TRIP_GRACE_MS=0`(产品允许的配置)
 *     关掉了强制回收,于是一个熔断过、`interrupt` 没人理的回合可以继续活着;跨过 6 小时、或者
 *     主机休眠把墙钟往前一跳,下一次熔断的写入就会把那条**仍然有人要读**的判决扫掉,旧回合
 *     后来真收到 turnEnd 时读到 null,照样写 `completed`(第 3 轮审查 F3,已实测)。
 *
 * 所以年龄只能用在**已经退场**的那些上:`retiredAt` 由状态机在那条停滞记录离开 `stalls` 时
 * 填(真实收口 / 摘牌 / 被新一轮顶掉),填上就意味着「这一轮不会再产生事件了」,余下只剩那条
 * 消费链自己来销账(`clearStallFailure`)。链要是半路没了(进程被硬杀、异常绕过结算),这条
 * 记录就等 ORPHAN_MS 之后被顺手清掉 —— 这才是「明确孤立」。
 *
 * **还在跑的一条都不碰**,所以条数上界就是「同时卡着的回合数」,一条几百字节;跨 server 重启
 * 这张表本来是空的(进程内状态),所以也不存在越攒越多那回事。
 */
const ORPHAN_MS = 6 * 60 * 60_000;

const key = (sessionId: string, turnStartedAt: string): string => `${sessionId}\u0000${turnStartedAt}`;

/**
 * 顺手清掉**已退场且已经够老**的那些(写入时做,不另起计时器:这张表只在熔断时被写,频率极低)。
 *
 * `retiredAt === null` = 这一轮还在跑,**一个字都不许碰** —— 判据见 ORPHAN_MS 那段。
 */
function sweepOrphans(cutoffMs: number): void {
  for (const [k, verdict] of failures) {
    if (verdict.retiredAt === null) continue;
    const at = Date.parse(verdict.retiredAt);
    // 时间戳读不出来就留着:宁可多留一条孤立记录,也不能因为解析失败丢掉一条活判决。
    if (Number.isFinite(at) && at <= cutoffMs) failures.delete(k);
  }
}

/** 看门狗熔断:把「这一轮失败」钉在这个回合身份上。 */
export function markStallFailure(sessionId: string, turnStartedAt: string, reason: string): void {
  const at = now();
  failures.set(key(sessionId, turnStartedAt), { reason, at, retiredAt: null });
  const cutoff = Date.parse(at) - ORPHAN_MS;
  if (Number.isFinite(cutoff)) sweepOrphans(cutoff);
}

/**
 * 这个回合身份**退场了**:状态机里那条停滞记录离开了(真实收口 / 摘牌 / 被新一轮顶掉)。
 *
 * 只打时间戳,**不删**:退场之后紧接着就是那条消费链读判决、结算、再 `clearStallFailure`,
 * 这中间一个字都不能少。链要是半路没了,这条记录从此刻开始算 ORPHAN_MS 的孤立时效。
 * 没有对应判决(这一轮压根没熔断)时是空转。
 */
export function retireStallFailure(sessionId: string, turnStartedAt: string): void {
  const entry = failures.get(key(sessionId, turnStartedAt));
  if (!entry || entry.retiredAt !== null) return;
  entry.retiredAt = now();
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
    const shift = (iso: string | null): string | null =>
      (iso === null ? null : new Date(Date.parse(iso) - ms).toISOString());
    failures.set(k, { ...verdict, at: shift(verdict.at)!, retiredAt: shift(verdict.retiredAt) });
  }
}
