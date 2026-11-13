// 一轮异常结束以后，会话里留下的那一句（docs/ui-ux-audit run-8）。
//
// 直播那一路有回合边界事件（「执行异常结束 · exit 1」，带着结尾 done 事件给的「怎么断的」），由
// noticeView 落定成「这一轮中断 · 模型上游连不上（503）」；刷新以后那条边界没了，就从会话行认：
// 每条会话**最后一回合**的会话行报的是异常收口，就在那一回合后面补同一句，原因取会话行上同一份
// （Session.turnInterruption）。老记录没有原因，就还是「这一轮异常结束」。失败要一直看得见：此刻
// 能重试时，「重试这一回合」就挂在这句话后面（ConversationFeed）。
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
import type { Session, TurnInterruption, TurnOutcome } from "@ash/shared";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { legacyTier } from "./legacyNoticeTable.ts";

/**
 * 补出来的那一句：点开看到的原文（退出码），它落在什么时刻（会话行的收口时刻），以及服务端判的
 * 怎么断的（老记录没有）。
 */
export type CrashedTurn = { text: string; at?: string; interruption?: TurnInterruption };

/** agent 条目 id → 补出来的那一句。 */
export function crashedTurns(items: readonly ConversationItem[]): Map<string, CrashedTurn> {
  const lastBySession = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind === "agent" && item.session && !item.reviewer) lastBySession.set(item.session.id, index);
  });
  const out = new Map<string, CrashedTurn>();
  for (const index of lastBySession.values()) {
    const item = items[index] as Extract<ConversationItem, { kind: "agent" }>;
    const session = item.session!;
    if (!session.endedAt || !turnEndedAbnormally(session)) continue;
    // 直播那一路已经落了一条异常边界：那一条就是这一句，不再补。
    const next = items.slice(index + 1).find((entry) => entry.kind !== "event" || entry.variant === "boundary");
    if (next?.kind === "event" && next.variant === "boundary" && next.tone === "error") continue;
    out.set(item.id, {
      text: session.exitStatus != null ? `执行异常结束 · exit ${session.exitStatus}` : "执行异常结束：这一轮没有正常收口",
      at: session.endedAt ?? undefined,
      ...(session.turnInterruption ? { interruption: session.turnInterruption } : {}),
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

/** 落盘重建那一路的一截回合是哪一回合：它领到的 trace 自己记着回合起点（切过组的下半截也一样），没有 trace 就用重建推出来的起点。 */
export function persistedTurnOutcome(session: Session, trace: readonly SessionTraceEntry[], turnStartedAt: string): TurnOutcome | null {
  return session.turnOutcomes?.[trace[0]?.turnStartedAt ?? turnStartedAt] ?? null;
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
