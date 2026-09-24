import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationDebateFeedRow } from "./conversationDebateRows.ts";
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
  /**
   * 这几条全是任务时间线旁注（aside），而且上面紧挨着一颗 agent 气泡 —— 它们讲的就是
   * 「那一回合跑着的时候顺带发生的事」，所以贴着那颗气泡排成尾注，而不是在两段对话之间
   * 横一道。旁注本来就不该看起来像「这里换了一段」（用户 2026-09-14 反馈）。
   */
  attached?: boolean;
};

export type ConversationDisplayRow =
  | ConversationDebateFeedRow
  | ConversationSystemActionRow
  | ConversationSystemDigestRow;

/**
 * 冲突交接前面通常连写「开始验收 → 合并冲突 → 已叫醒任务」三四条旁注，随后再塞一整块
 * 后端代写指令。它们讲的是同一件事：收成一条可展开旁注，原始记录仍留在详情里。
 */
export function conversationSystemRows(rows: ConversationDebateFeedRow[]): ConversationDisplayRow[] {
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
  const afterAgentTurn = () => {
    const previous = display.at(-1);
    return previous?.kind === "item" && previous.item.kind === "agent";
  };
  const flush = () => {
    if (!pending.length) return;
    display.push({
      kind: "system-digest",
      id: `system-digest:${pending[0]!.id}`,
      items: pending,
      attached: pending.every((item) => item.aside) && afterAgentTurn(),
    });
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
