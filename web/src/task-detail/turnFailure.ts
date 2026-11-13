// 一轮异常结束以后，会话里留下的那一句（docs/ui-ux-audit run-8）。
//
// 直播那一路有回合边界事件（「执行异常结束 · exit 1」），由 noticeView 落定成「这一轮异常结束」；
// 刷新以后那条边界没了，就从会话行认：每条会话**最后一回合**的会话行报的是异常收口，就在那一回合
// 后面补同一句。失败要一直看得见（重试在任务头上）。
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
import type { ConversationItem } from "./conversationModel.ts";

/** 补出来的那一句：点开看到的原文（退出码），以及它落在什么时刻（会话行的收口时刻）。 */
export type CrashedTurn = { text: string; at?: string };

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
    });
  }
  return out;
}
