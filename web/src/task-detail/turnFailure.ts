// 一轮异常结束以后，会话里留下的那一句（docs/ui-ux-audit run-8）。
//
// 直播那一路有回合边界事件（「执行异常结束 · exit 1」，带着结尾 done 事件给的「怎么断的」），由
// noticeView 落定成「这一轮中断 · 模型上游连不上（503）」；刷新以后那条边界没了，就从会话行认：
// 哪一回合自己的结局是失败（或者会话**最后一回合**的会话行报的是异常收口），就在那一回合后面补同一句，
// 原因取那一回合自己的（Session.turnInterruptions）。老记录没有原因，就还是「这一轮异常结束」。失败要
// 一直看得见：此刻能重试时，「重试这一回合」就挂在可重试那一回合的这句话后面（ConversationFeed）。
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
import type { Session, TurnInterruption, TurnOutcome } from "@ash/shared";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { legacyTier } from "./legacyNoticeTable.ts";
import { latestTurnStart } from "./conversationTurnParts.ts";

/**
 * 补出来的那一句：点开看到的原文（退出码），它落在什么时刻（会话行的收口时刻），以及服务端判的
 * 怎么断的（老记录没有）。
 */
export type CrashedTurn = { text: string; at?: string; interruption?: TurnInterruption };

/**
 * agent 条目 id → 补出来的那一句。**每个异常结束的回合各补一句**，补在那一回合的最后一颗气泡上。
 *
 * 两种证据：
 * - 回合**自己**的结局（`turnOutcome`，服务端按回合交出来的）是失败 —— 历史回合只认这一样。同一条
 *   会话重试成功以后，前一回合那句话刷新后还得在原处，原因取那一回合自己的（`turnInterruption`），
 *   只看会话最后一回合的那一版一续跑就把它丢了（第 2 轮审查第 2 条）。
 * - 会话**最后一回合**再加会话行上那份：会话行带了结局（`turnOutcome`）就说明那一回合已经收口，
 *   不再另要会话行的收尾时刻 —— 跟重试入口（turnRetry.ts）读同一份判据，不然会话行晚一步时就出现
 *   「能重试、却没有说这件事的那句话、键也无处可挂」（第 1 轮审查第 1 条）。不知道结局时才拿收尾
 *   时刻兜底：回合还开着的时候，会话行上的退出码是上一个进程的。
 *
 * `retrySessionId` = 此刻能「重试这一回合」的那条会话（turnRetryTarget 普通档）：它的最后一回合
 * 必定补一句。可重试本身就是「这一回合异常结束」的证据，入口只挂在这句话后面，少了它就没地方挂。
 * 重试入口只挂那一句（ConversationFeed），历史回合的那几句只说事。
 */
export function crashedTurns(items: readonly ConversationItem[], retrySessionId?: string | null): Map<string, CrashedTurn> {
  const lastBySession = new Map<string, number>();
  const lastByTurn = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind !== "agent" || !item.session || item.reviewer) return;
    lastBySession.set(item.session.id, index);
    // 回合身份：落盘那一路是结局、原因查的那一个（turnKey），直播那一路是事件带的起点。两样都没有的
    // （老记录）不单独成段，只走下面「最后一回合」那条。
    const turn = item.turnKey ?? item.turnStartedAt;
    if (turn) lastByTurn.set(`${item.session.id}\u0000${turn}`, index);
  });
  const latest = new Set(lastBySession.values());
  const out = new Map<string, CrashedTurn>();
  for (const index of new Set([...lastByTurn.values(), ...latest])) {
    const item = items[index] as Extract<ConversationItem, { kind: "agent" }>;
    const session = item.session!;
    const sessionSays = latest.has(index) && (
      (!!retrySessionId && session.id === retrySessionId)
      || (!!(session.turnOutcome || session.endedAt) && turnEndedAbnormally(session))
    );
    if (!sessionSays && !turnFailed(item)) continue;
    // 直播那一路已经落了一条异常边界：那一条就是这一句，不再补。
    const next = items.slice(index + 1).find((entry) => entry.kind !== "event" || entry.variant === "boundary");
    if (next?.kind === "event" && next.variant === "boundary" && next.tone === "error") continue;
    // 会话行上的退出码、收尾时刻、原因说的都是**最后一回合**；历史回合只有它自己那一份原因。
    const interruption = item.turnInterruption
      ?? (sessionSays ? session.turnInterruptions?.[latestTurnStart(session) ?? session.startedAt] : undefined);
    out.set(item.id, {
      text: sessionSays && session.exitStatus != null ? `执行异常结束 · exit ${session.exitStatus}` : "执行异常结束：这一轮没有正常收口",
      at: sessionSays ? session.endedAt ?? undefined : undefined,
      ...(interruption ? { interruption } : {}),
    });
  }
  return out;
}

/**
 * 这一回合自己的结局是失败（`Session.turnOutcomes` / 直播回合结尾带的 `turnOutcome`，服务端收口时写下的
 * 同一份）。哨兵叫醒的并回拿它断段：异常结束之后来的叫醒不并进那一回合。
 *
 * 这是权威事实；服务端还没把每回合结局带出门时一律是「不知道」，只能退到下面那条从记录上认的判法——
 * 那条认不全：留了续跑交代以后崩掉的回合不写结算说明，刷新后就认不出来。
 */
export function turnFailed(item: Extract<ConversationItem, { kind: "agent" }>): boolean {
  return item.turnOutcome === "failed";
}

/**
 * 落盘重建那一路的一截回合**是哪一回合、结局如何、怎么断的** —— 三样一起给，出自同一个回合身份：它领到的
 * trace 自己记着回合起点（切过组的下半截也一样），没有 trace 就用重建推出来的起点。
 *
 * 落盘那一路**每一个**构造气泡的地方都只从这里拿（正文那一段、只有执行过程的兜底那一段）。分开取的那一版
 * 让兜底气泡带上了结局和原因、却没带身份，历史失败那句话按回合认的时候就认不到它 —— 没来得及说话就失败的
 * 那一回合，重试成功一刷新，失败说明就没了（第 3 轮审查第 1 条）。
 */
export function persistedTurnFacts(
  session: Session,
  trace: readonly SessionTraceEntry[],
  turnStartedAt: string,
): { turnKey: string; turnOutcome: TurnOutcome | null; turnInterruption?: TurnInterruption } {
  const turnKey = trace[0]?.turnStartedAt ?? turnStartedAt;
  const turnInterruption = session.turnInterruptions?.[turnKey];
  return { turnKey, turnOutcome: session.turnOutcomes?.[turnKey] ?? null, ...(turnInterruption ? { turnInterruption } : {}) };
}

/**
 * 这条记录说的是「上一回合没有正常收口」——不知道回合结局（见 turnFailed）时，落盘重建和直播到达两路
 * 都认得出的那份记录（哨兵叫醒的并回拿它断段，见 monitorWakeTurns）。
 *
 * 只认两样：直播那一路的异常回合边界（「执行异常结束 · exit 1」），以及结算说明里「这一轮没办成」的那几句
 * （legacyNoticeTable 的 SETTLEMENT_LEADS，照服务端 settle-status 的落位说明抄的）。后者两路都有——服务端
 * 收口时写进会话、同时播出来——也覆盖进程 exit 0 却被 ash 判失败的那种（被终止的续聊、没交卷）。回合边界
 * 只在直播里有，落盘那一路没有，单凭它判，开着页面看和刷新以后就是两个样子。
 */
export function endsTurnAbnormally(item: Extract<ConversationItem, { kind: "event" }>): boolean {
  if (item.variant === "boundary") return item.tone === "error";
  return item.tone === "notice" && legacyTier(item.text, { settlement: true }) === "alert";
}
