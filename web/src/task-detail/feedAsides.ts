import type { ReactNode } from "react";
import type { ConversationDisplayRow } from "./conversationSystemRows.ts";

// 会话里那几样「不在会话正文里、但按时刻排在会话里」的东西（宿主给的，例如你派出去的那一句小灰字）
// 插回正文行的哪一处。正文行本来就按时间排，所以按时刻找第一条比它晚的行，插在那一行前面；
// 比所有行都晚的跟在最后。说不出时刻的行（极少）不参与比较，紧跟在前一行后面。

export type FeedAside = { key: string; at: string; node: ReactNode };

/** 一行从什么时候开始：一条消息的时刻、一轮审查 / 一场辩论开始的时刻、一句旁注的时刻。 */
export function feedRowAt(row: ConversationDisplayRow): string | null {
  switch (row.kind) {
    case "item":
    case "system-action":
    case "reply":
      return row.item.at ?? null;
    case "footnote":
      return row.footnote.parts[0]?.at ?? null;
    case "verdict":
      return row.lane.startedAt || (row.lane.items[0]?.at ?? null);
    case "review-lane":
      return row.startedAt || (row.items[0]?.at ?? null);
    case "debate-lane":
    case "discussion-lane":
      return row.startedAt || (row.items[0]?.at ?? null);
  }
}

export type Interleaved<R> = { row: R; aside?: undefined } | { aside: FeedAside; row?: undefined };

export function interleaveAsides<R>(rows: readonly R[], asides: readonly FeedAside[], at: (row: R) => string | null): Interleaved<R>[] {
  if (!asides.length) return rows.map((row) => ({ row }));
  const pending = [...asides].sort((a, b) => a.at.localeCompare(b.at));
  const result: Interleaved<R>[] = [];
  for (const row of rows) {
    const start = at(row);
    if (start) while (pending.length && pending[0]!.at < start) result.push({ aside: pending.shift()! });
    result.push({ row });
  }
  for (const aside of pending) result.push({ aside });
  return result;
}
