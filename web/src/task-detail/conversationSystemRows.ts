import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationDebateFeedRow } from "./conversationDebateRows.ts";
import { conflictContextEvent, isConflictHandoff } from "./systemNoticeModel.ts";
import { verifyMarkOf } from "./conversationNotes.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import { noticeView, turnFailureView, type NoticeContext, type NoticeView } from "./timelineNoticeCopy.ts";
import type { CrashedTurn } from "./turnFailure.ts";
import { composeFootnote, laneVerdictEvent, laneVerdictView, type FootnotePart, type TurnFootnote } from "./turnFootnote.ts";

type EventItem = Extract<ConversationItem, { kind: "event" }>;

/**
 * 记在某一回合上的一条记录：平时不画，指到那一回合才有「N 条记录」，点开是一份带时刻的流水。
 * 尾注里的每一句同时也是这里的一条（删除在这里）。
 */
export type TurnReceipt = {
  id: string;
  at?: string;
  view: NoticeView;
  /** 原条目：删除消息、取原文都从它拿。就地验证靠阶段翻档收口的那一轮没有结论旁注，为空。 */
  item?: EventItem;
  /** 一轮审查的结论：点它去那一轮（被后一轮盖过、尾注里不再说的那一轮，入口就剩这一条）。 */
  lane?: ConversationReviewLane;
};

export type ConversationSystemActionRow = {
  kind: "system-action";
  id: string;
  item: Extract<ConversationItem, { kind: "user" }>;
  related: EventItem[];
};

/**
 * 前面没有回合可挂的那几句（任务还没跑过就验收了、两段真人插话之间只有系统动作……）：留在
 * 原处，跟回合的尾注同一种小灰字；没有要说的、只有回执的，就只是一颗「N 条记录」。
 */
export type ConversationFootnoteRow = {
  kind: "footnote";
  id: string;
  footnote: TurnFootnote;
  receipts: TurnReceipt[];
};

/** 你那条斜杠命令的回答：是你要看的东西，在原处常显。 */
export type ConversationReplyRow = {
  kind: "reply";
  id: string;
  item: EventItem;
  view: NoticeView;
};

export type ConversationDisplayRow =
  | ConversationDebateFeedRow
  | ConversationSystemActionRow
  | ConversationFootnoteRow
  | ConversationReplyRow;

export type ConversationDisplay = {
  rows: ConversationDisplayRow[];
  /** agent 条目 id → 记在它上面的记录（按时间先后）。 */
  receipts: ReadonlyMap<string, TurnReceipt[]>;
  /** agent 条目 id → 它的尾注。 */
  footnotes: ReadonlyMap<string, TurnFootnote>;
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

type Accessors<Row> = {
  turnIdOf: (row: Row) => string | null;
  breaksSegment: (row: Row) => boolean;
  eventOf: (row: Row) => EventItem | null;
  /** 收了口的一轮审查（它不再占行，结论记到被审的那一回合上）。 */
  laneOf?: (row: Row) => ConversationReviewLane | null;
  /** 这一行是你说的话：它后面的尾注都成了过去的事。 */
  yoursOf?: (row: Row) => boolean;
  /** 这一回合异常结束了：尾注里补「这一轮异常结束」（原文是退出码），记录里同样有一条。 */
  failureOf?: (turnId: string) => CrashedTurn | undefined;
  /** 认老记录时用得上的、这个任务自己的东西（见 timelineNoticeCopy 的 NoticeContext）。 */
  context?: NoticeContext;
};

/**
 * ash 自己说的话归到哪一回合 —— 判据只有「它跟谁在同一段里」：
 *
 * - 段只由**你的话**（以及后端代写、占着真人回合的那种）和**辩论**来分。收了口的审查轮不分段：
 *   它审的是前面那一回合的产出，结论连同它后面的验收和回执，都记在**它前面最近的那个回合**上；
 * - 段里已经有回合了，回执和尾注都记在**最近那一回合**上：回合跑着时顺带发生的事（开始盯、暂停），
 *   回合跑完紧跟着的事（审查已预约、审查出了结论、验收了），都是那一回合的后话；
 * - 段里还没有回合：回执等这一段的第一回合来认领（「意见已交给执行者」→ 按意见改的那一回合），
 *   等到段落结束也没有回合来认，就在原处留一颗「N 条记录」；要你知道的那几句不往后挂，在原处
 *   留一句同样的小灰字。
 */
function attach<Row extends { kind: string }>(rows: Row[], acc: Accessors<Row>): {
  rows: Array<Row | ConversationFootnoteRow | ConversationReplyRow>;
  receipts: Map<string, TurnReceipt[]>;
  footnotes: Map<string, TurnFootnote>;
} {
  const out: Array<Row | ConversationFootnoteRow | ConversationReplyRow> = [];
  const receipts = new Map<string, TurnReceipt[]>();
  const parts = new Map<string, FootnotePart[]>();
  const order = new Map<string, number>();
  let turn: string | null = null;
  let pending: TurnReceipt[] = [];
  let orphan: { row: ConversationFootnoteRow; parts: FootnotePart[] } | null = null;
  const orphans: Array<{ row: ConversationFootnoteRow; parts: FootnotePart[] }> = [];
  const give = (id: string, list: TurnReceipt[]) => {
    if (list.length) receipts.set(id, [...receipts.get(id) ?? [], ...list]);
  };
  const openOrphan = (id: string) => {
    orphan = { row: { kind: "footnote", id: `footnote:${id}`, footnote: { id: `footnote:${id}`, parts: [], live: false }, receipts: [] }, parts: [] };
    orphans.push(orphan);
    out.push(orphan.row);
    return orphan;
  };
  const note = (part: FootnotePart, receipt: TurnReceipt | null) => {
    if (turn) {
      parts.set(turn, [...parts.get(turn) ?? [], part]);
      if (receipt) give(turn, [receipt]);
      return;
    }
    const home = orphan ?? openOrphan(part.id);
    home.parts.push(part);
    if (receipt) home.row.receipts.push(receipt);
  };
  const closeSegment = () => {
    if (pending.length) {
      const home = orphan ?? openOrphan(pending[0]!.id);
      home.row.receipts = [...home.row.receipts, ...pending]
        .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    }
    pending = [];
    orphan = null;
    turn = null;
  };
  rows.forEach((row, index) => {
    const event = acc.eventOf(row);
    if (event) {
      const view = noticeView(event, acc.context);
      if (view.tier === "reply") {
        out.push({ kind: "reply", id: `reply:${event.id}`, item: event, view });
        return;
      }
      const receipt: TurnReceipt = { id: event.id, at: event.at, view, item: event };
      order.set(receipt.id, index);
      if (view.tier !== "receipt") note({ kind: "event", id: event.id, at: event.at, view, item: event }, receipt);
      else if (turn) give(turn, [receipt]);
      else pending.push(receipt);
      return;
    }
    const lane = acc.laneOf?.(row);
    if (lane) {
      const end = laneVerdictEvent(lane);
      const view = laneVerdictView(lane);
      const at = end?.at ?? lane.endedAt ?? undefined;
      const receipt: TurnReceipt = { id: end?.id ?? lane.id, at, view, lane, ...(end ? { item: end } : {}) };
      order.set(receipt.id, index);
      note({ kind: "review", id: lane.id, at, view, lane }, receipt);
      return;
    }
    const turnId = acc.turnIdOf(row);
    if (turnId) {
      out.push(row);
      give(turnId, pending);
      pending = [];
      orphan = null;
      turn = turnId;
      const failure = acc.failureOf?.(turnId);
      if (failure) {
        const id = `failure:${turnId}`;
        const view = turnFailureView(failure.text);
        // 排在这一回合后面的那些记录前头：它是这一回合自己的收场。
        order.set(id, index);
        note({ kind: "failure", id, at: failure.at, view }, { id, at: failure.at, view });
      }
      return;
    }
    if (acc.breaksSegment(row)) closeSegment();
    out.push(row);
  });
  closeSegment();

  const footnotes = new Map<string, TurnFootnote>();
  for (const [id, list] of parts) footnotes.set(id, { id: `footnote:${id}`, parts: composeFootnote(list), live: false });
  for (const entry of orphans) entry.row.footnote = { ...entry.row.footnote, parts: composeFootnote(entry.parts) };
  // 现在的事：会话里最后一个有话要说的回合（或原处那一句），后面又没有你的话。
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const row = out[index]!;
    if (row.kind === "footnote") {
      const own = row as ConversationFootnoteRow;
      if (!own.footnote.parts.length) continue;
      own.footnote = { ...own.footnote, live: true };
      break;
    }
    if (row.kind === "reply") continue;
    const turnId = acc.turnIdOf(row as Row);
    if (turnId) {
      const footnote = footnotes.get(turnId);
      if (footnote) footnotes.set(turnId, { ...footnote, live: true });
      break;
    }
    if (acc.yoursOf?.(row as Row)) break;
  }
  return { rows: out, receipts, footnotes };
}

export function conversationSystemRows(
  rows: ConversationDebateFeedRow[],
  options: { failures?: ReadonlyMap<string, CrashedTurn>; context?: NoticeContext } = {},
): ConversationDisplay {
  type Grouped = ConversationDebateFeedRow | ConversationSystemActionRow;
  const display = attach<Grouped>(groupConflictHandoffs(rows), {
    turnIdOf: (row) => row.kind === "item" && row.item.kind === "agent" ? row.item.id : null,
    // 辩论分段；正在跑的审查卡不分（它收口以后就是被审那一回合尾注里的一句）。
    breaksSegment: (row) => row.kind === "debate-lane" || row.kind === "system-action" || (row.kind === "item" && row.item.kind === "user"),
    eventOf: (row) => row.kind === "item" && row.item.kind === "event" ? row.item : null,
    laneOf: (row) => row.kind === "review-lane" && row.complete ? row : null,
    yoursOf: (row) => row.kind === "item" && row.item.kind === "user" && !row.item.bySystem,
    failureOf: (id) => options.failures?.get(id),
    context: options.context,
  });
  return display as ConversationDisplay;
}

export type LaneRow = { kind: "item"; item: ConversationItem } | ConversationFootnoteRow | ConversationReplyRow;

/**
 * 同一套归属，用在一轮审查里：卡里的旁注同样不单独占行，记在审查者那一回合上。
 * 收了口的一轮，那条结论旁注就是被审那一回合尾注里的那一句本身，不在摊开的经过里再说一遍。
 * 卡里的尾注不带颜色（那是过去的一轮，或者正在跑、还没有现在的结论）。
 */
export function laneReceipts(lane: Pick<ConversationReviewLane, "items" | "complete">): {
  rows: LaneRow[];
  receipts: ReadonlyMap<string, TurnReceipt[]>;
  footnotes: ReadonlyMap<string, TurnFootnote>;
} {
  const items = lane.complete
    ? lane.items.filter((item) => item.kind !== "event" || verifyMarkOf(item)?.phase !== "end")
    : lane.items;
  const attached = attach<{ kind: "item"; item: ConversationItem }>(
    items.map((item) => ({ kind: "item", item })),
    {
      turnIdOf: (row) => row.item.kind === "agent" ? row.item.id : null,
      breaksSegment: (row) => row.item.kind === "user",
      eventOf: (row) => row.item.kind === "event" ? row.item : null,
    },
  );
  const footnotes = new Map([...attached.footnotes].map(([id, footnote]) => [id, { ...footnote, live: false }]));
  const rows = attached.rows.map((row) => row.kind === "footnote" ? { ...row, footnote: { ...row.footnote, live: false } } : row);
  return { rows, receipts: attached.receipts, footnotes };
}
