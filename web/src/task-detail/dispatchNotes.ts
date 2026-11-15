import type { ReactNode } from "react";
import type { TaskListItem } from "@ash/shared";
import type { ConversationDisplayRow } from "./conversationSystemRows.ts";

/**
 * 会话里靠右那一句小灰字「开了新任务〈标题〉，交给 codex」：你在回复框里派出去的每一条各一句。
 *
 * 不另存一份记录，直接从任务列表里认——派出去的任务带着 dispatchedBy（挂在谁名下）和创建来源
 * （用户自己建的）。刷新以后照样在，标题跟着新任务自动起的名字走；智能体在回合里派的不算（那件事
 * 在它的执行过程里已经看得见）。
 */
export type DispatchNote = { id: string; at: string; title: string; agent: string | null };

export function dispatchNotes(taskId: string, tasks: readonly TaskListItem[]): DispatchNote[] {
  return tasks
    .filter((task) => task.dispatchedBy === taskId && task.creationOrigin?.kind === "user")
    .map((task) => ({ id: task.id, at: task.createdAt, title: task.title || "未命名任务", agent: task.agentType ?? null }))
    .sort((left, right) => left.at.localeCompare(right.at));
}

export type Interleaved<R, A> = { kind: "row"; row: R } | { kind: "aside"; aside: A };

/**
 * 把按时间排好的旁白插进会话的行里：排在第一个比它晚的行前面，比所有行都晚的跟在最后。
 * 认不出时刻的行（审查气泡、辩论之类）原样留在原处，不拿它当参照。
 */
export function interleaveByTime<R, A extends { at: string }>(
  rows: readonly R[],
  atOf: (row: R) => string | null | undefined,
  asides: readonly A[],
): Interleaved<R, A>[] {
  const out: Interleaved<R, A>[] = [];
  let next = 0;
  for (const row of rows) {
    const at = atOf(row);
    while (at && next < asides.length && asides[next]!.at < at) out.push({ kind: "aside", aside: asides[next++]! });
    out.push({ kind: "row", row });
  }
  while (next < asides.length) out.push({ kind: "aside", aside: asides[next++]! });
  return out;
}

/** 会话里按时刻插进来的一行旁白（ConversationFeed 的 `asides`）。 */
export type FeedAside = { id: string; at: string; node: ReactNode };

/** 会话里一行的时刻：你说的话、它说的话、系统动作、单摆着的那几句；其余认不出就不拿来比。 */
export function displayRowAt(row: ConversationDisplayRow): string | null {
  if (row.kind === "item") return row.item.at ?? null;
  if (row.kind === "system-action") return row.item.at ?? null;
  if (row.kind === "footnote") return row.footnote.parts[0]?.at ?? null;
  return null;
}
