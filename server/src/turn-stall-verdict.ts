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
 * 上限 = 兜住「写了却没人来读」的那几条。
 *
 * 正常路径上每一笔都会被对应的结算读掉并清掉(单飞在 settle 之后、团队在 endTurn/closeLead
 * 里),所以这张表常态是空的。留个水位是因为熔断本身就发生在异常现场:万一那条链这一次连
 * 结算都没走到,表也不该无界长。Map 迭代序 = 插入序,超了就从最老的扔。
 */
const KEEP = 64;

const key = (sessionId: string, turnStartedAt: string): string => `${sessionId}\u0000${turnStartedAt}`;

/** 看门狗熔断:把「这一轮失败」钉在这个回合身份上。 */
export function markStallFailure(sessionId: string, turnStartedAt: string, reason: string): void {
  failures.set(key(sessionId, turnStartedAt), { reason, at: now() });
  while (failures.size > KEEP) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
}

/** 这个回合身份有没有被看门狗判过失败。读不清掉 —— 同一轮有三处要读(span/会话/任务)。 */
export function stallFailure(sessionId: string, turnStartedAt: string | null): StallVerdict | null {
  if (!turnStartedAt) return null;
  return failures.get(key(sessionId, turnStartedAt)) ?? null;
}

/** 这一轮结算完了:销账。漏掉只会被上面那个水位兜住,但别指望它。 */
export function clearStallFailure(sessionId: string, turnStartedAt: string | null): void {
  if (!turnStartedAt) return;
  failures.delete(key(sessionId, turnStartedAt));
}

/** 只给回归测试。 */
export function __resetStallFailures(): void {
  failures.clear();
}
