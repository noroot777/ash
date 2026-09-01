import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationFeedRow } from "./conversationReviewLanes.ts";
import { conflictContextEvent, isConflictHandoff } from "./systemNoticeModel.ts";

export type ConversationSystemActionRow = {
  kind: "system-action";
  id: string;
  item: Extract<ConversationItem, { kind: "user" }>;
  related: Array<Extract<ConversationItem, { kind: "event" }>>;
};

export type ConversationSystemDigestRow = {
  kind: "system-digest";
  id: string;
  items: Array<Extract<ConversationItem, { kind: "event" }>>;
};

export type ConversationDisplayRow = ConversationFeedRow | ConversationSystemActionRow | ConversationSystemDigestRow;

/**
 * 冲突交接前面通常连写「开始验收 → 合并冲突 → 已叫醒任务」三四条旁注，随后再塞一整块
 * 后端代写指令。它们讲的是同一件事：收成一条可展开旁注，原始记录仍留在详情里。
 */
export function conversationSystemRows(rows: ConversationFeedRow[]): ConversationDisplayRow[] {
  const grouped: ConversationDisplayRow[] = [];
  for (const row of rows) {
    if (
      row.kind === "item"
      && row.item.kind === "user"
      && row.item.bySystem
      && isConflictHandoff(row.item.text)
    ) {
      const related: Array<Extract<ConversationItem, { kind: "event" }>> = [];
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

  const display: ConversationDisplayRow[] = [];
  let pending: Array<Extract<ConversationItem, { kind: "event" }>> = [];
  const flush = () => {
    if (!pending.length) return;
    display.push({ kind: "system-digest", id: `system-digest:${pending.map((item) => item.id).join(":")}`, items: pending });
    pending = [];
  };
  for (const row of grouped) {
    if (row.kind === "item" && row.item.kind === "event" && row.item.variant !== "boundary") {
      pending.push(row.item);
      continue;
    }
    flush();
    display.push(row);
  }
  flush();
  return display;
}
