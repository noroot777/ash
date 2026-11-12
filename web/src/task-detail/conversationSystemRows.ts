import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationDebateFeedRow } from "./conversationDebateRows.ts";
import { conflictContextEvent, isConflictHandoff } from "./systemNoticeModel.ts";
import { verifyMarkOf } from "./conversationNotes.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import { noticeView, type NoticeView } from "./timelineNoticeCopy.ts";

type EventItem = Extract<ConversationItem, { kind: "event" }>;

/** 记在某一回合上的一条回执：平时不画，指到那一回合才有「N 条记录」，点开是一份带时刻的流水。 */
export type TurnReceipt = {
  id: string;
  at?: string;
  view: NoticeView;
  /** 原条目：删除消息、取原文都从它拿。 */
  item: EventItem;
};

export type ConversationSystemActionRow = {
  kind: "system-action";
  id: string;
  item: Extract<ConversationItem, { kind: "user" }>;
  related: EventItem[];
};

/** 常显的那一行：里程碑（审查出了结论、验收了），或者出了岔子 / 要你拍板的。 */
export type ConversationNoticeRow = {
  kind: "notice";
  id: string;
  item: EventItem;
  view: NoticeView;
};

/**
 * 找不到所属回合的回执（这一段里一回合都没有：任务还没跑过就预约了审查、两段真人插话之间
 * 只有系统动作……）。它们照样平时不画，只在原处留一颗「N 条记录」。
 */
export type ConversationReceiptLogRow = {
  kind: "receipt-log";
  id: string;
  receipts: TurnReceipt[];
};

export type ConversationDisplayRow =
  | ConversationDebateFeedRow
  | ConversationSystemActionRow
  | ConversationNoticeRow
  | ConversationReceiptLogRow;

export type ConversationDisplay = {
  rows: ConversationDisplayRow[];
  /** agent 条目 id → 记在它上面的回执（按时间先后）。 */
  receipts: ReadonlyMap<string, TurnReceipt[]>;
};

/**
 * 冲突交接前面通常连写「开始验收 → 合并冲突 → 已叫醒任务」三四条旁注，随后再塞一整块
 * 后端代写指令。它们讲的是同一件事：收成一张卡，原始记录在卡里的「流程记录」。
 */
function groupConflictHandoffs(rows: ConversationDebateFeedRow[]): Array<ConversationDebateFeedRow | ConversationSystemActionRow> {
  const grouped: Array<ConversationDebateFeedRow | ConversationSystemActionRow> = [];
  for (const row of rows) {
    if (row.kind === "item" && row.item.kind === "user" && row.item.bySystem && isConflictHandoff(row.item.text)) {
      const related: EventItem[] = [];
      while (grouped.length) {
        const previous = grouped.at(-1);
        if (previous?.kind !== "item" || previous.item.kind !== "event" || !conflictContextEvent(previous.item.text)) break;
        related.unshift(previous.item);
        grouped.pop();
      }
      grouped.push({ kind: "system-action", id: `system-action:${row.item.id}`, item: row.item, related });
      continue;
    }
    grouped.push(row);
  }
  return grouped;
}

/**
 * 回执归到哪一回合 —— 判据只有「它跟谁在同一段里」：
 *
 * - 段只由**你的话**（以及后端代写、占着真人回合的那种）和**一整轮审查 / 辩论**来分；
 * - 段里已经有回合了，回执记在**最近那一回合**上：回合跑着时顺带发生的事（开始盯、暂停），
 *   回合跑完紧跟着的事（审查已预约、这一轮跑完预约的审查开始），都是那一回合的后话；
 * - 段里还没有回合，就等这一段的第一回合来认领（「意见已交给执行者」→ 按意见改的那一回合）；
 * - 等到段落结束也没有回合来认，就在原处留一颗只有「N 条记录」的行。
 *
 * 里程碑与要你知道的那几种照常占一行，不打断归属：它们之后的回执仍记在同一回合上。
 */
function attachReceipts<Row extends { kind: string }>(
  rows: Row[],
  turnIdOf: (row: Row) => string | null,
  breaksSegment: (row: Row) => boolean,
  eventOf: (row: Row) => EventItem | null,
): { rows: Array<Row | ConversationNoticeRow | ConversationReceiptLogRow>; receipts: Map<string, TurnReceipt[]> } {
  const out: Array<Row | ConversationNoticeRow | ConversationReceiptLogRow> = [];
  const receipts = new Map<string, TurnReceipt[]>();
  let turn: string | null = null;
  let pending: TurnReceipt[] = [];
  const give = (id: string, list: TurnReceipt[]) => {
    if (list.length) receipts.set(id, [...receipts.get(id) ?? [], ...list]);
  };
  const flushOrphans = () => {
    if (!pending.length) return;
    out.push({ kind: "receipt-log", id: `receipt-log:${pending[0]!.id}`, receipts: pending });
    pending = [];
  };
  for (const row of rows) {
    const event = eventOf(row);
    if (event) {
      const view = noticeView(event);
      if (view.tier !== "receipt") {
        out.push({ kind: "notice", id: `notice:${event.id}`, item: event, view });
        continue;
      }
      const receipt = { id: event.id, at: event.at, view, item: event };
      if (turn) give(turn, [receipt]);
      else pending.push(receipt);
      continue;
    }
    const turnId = turnIdOf(row);
    if (turnId) {
      give(turnId, pending);
      pending = [];
      turn = turnId;
    } else if (breaksSegment(row)) {
      flushOrphans();
      turn = null;
    }
    out.push(row);
  }
  flushOrphans();
  return { rows: out, receipts };
}

export function conversationSystemRows(rows: ConversationDebateFeedRow[]): ConversationDisplay {
  type Grouped = ConversationDebateFeedRow | ConversationSystemActionRow;
  const { rows: display, receipts } = attachReceipts<Grouped>(
    groupConflictHandoffs(rows),
    (row) => row.kind === "item" && row.item.kind === "agent" ? row.item.id : null,
    (row) => row.kind !== "item" || row.item.kind === "user",
    (row) => row.kind === "item" && row.item.kind === "event" ? row.item : null,
  );
  return { rows: display, receipts };
}

export type LaneRow = { kind: "item"; item: ConversationItem } | ConversationNoticeRow | ConversationReceiptLogRow;

/**
 * 同一套归属，用在一轮审查里：卡里的旁注同样不单独占行，记在审查者那一回合上。
 * 收了口的一轮，那条结论旁注就是会话里那一句本身，不在摊开的经过里再说一遍。
 */
export function laneReceipts(lane: Pick<ConversationReviewLane, "items" | "complete">): { rows: LaneRow[]; receipts: ReadonlyMap<string, TurnReceipt[]> } {
  const items = lane.complete
    ? lane.items.filter((item) => item.kind !== "event" || verifyMarkOf(item)?.phase !== "end")
    : lane.items;
  return attachReceipts<{ kind: "item"; item: ConversationItem }>(
    items.map((item) => ({ kind: "item", item })),
    (row) => row.item.kind === "agent" ? row.item.id : null,
    (row) => row.item.kind === "user",
    (row) => row.item.kind === "event" ? row.item : null,
  );
}
