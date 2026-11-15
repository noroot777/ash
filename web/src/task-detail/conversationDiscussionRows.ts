import type { TaskDiscussion } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationDebateFeedRow } from "./conversationDebateRows.ts";

/**
 * 时间线上的一整场讨论，折成一行（同辩论那一套，见 conversationDebateRows.ts）。
 *
 * 展开前它在会话里是：`开始讨论：…` + 每段一条 `讨论第 i/N 段：轮到 X。` + 各方每一段的提示词和随口的交代
 * + `讨论结束：…`（或 `讨论已中止：…`）。真正的发言走 `debate_reply` 落库（server/src/discussion.ts），会话里那几颗
 * 气泡不是讨论的记录。折起来之后是你发起时写的那一句，跟着一颗讨论气泡（DiscussionBubble）；合稿是这条任务的
 * 执行器之后照常回的那一段，不折进来。
 *
 * 交给它写合稿的那一句提示（`【讨论说完了 · 写合稿】…`）也不出现：它是系统替你说的，气泡已经写着「在写合稿」。
 *
 * 哪一句属于哪一场只认那几句带的讨论身份：一场的开始那句读不出来（会话文件缺了一份、时间线没写进去），后面那场
 * 也不会顶上来——配不上落盘记录就把原文原样摆出来。
 */
export type ConversationDiscussionRow = {
  kind: "discussion-lane";
  id: string;
  /** 折进来的原始行。配不到落盘记录时原样摆出来兜底，绝不凭空少掉一段。 */
  items: ConversationItem[];
  /** 配到的落盘记录；null = 只读视图没传，或这一场还没落到快照里。 */
  discussion: TaskDiscussion | null;
  startedAt: string | null;
  endedAt: string | null;
};

const SYNTHESIS_PROMPT = /^【讨论说完了 · 写合稿】/;

/** 讨论的结构那几句（server/src/discussion.ts 写时带着 `discussion` 类型和是哪一场）；别的一律不认。 */
function noteOf(item: ConversationItem): { id: string; phase: "start" | "segment" | "end" } | null {
  if (item.kind !== "event" || item.notice?.kind !== "discussion") return null;
  const { discussionId: id, phase } = item.notice;
  return { id, phase: phase === "aborted" ? "end" : phase };
}

const synthesisPrompt = (item: ConversationItem) => item.kind === "user" && !!item.bySystem && SYNTHESIS_PROMPT.test(item.text.trim());
/** 真人插话就收口（讨论期间你发的话是排着的，正常用不上；讨论崩在半路、收口那句永远不来时靠它）。 */
const closeBefore = (item: ConversationItem) => item.kind === "user" && !item.bySystem && !item.isAnswer;

function itemEnd(item: ConversationItem): string | null {
  if (item.kind === "agent") return item.markerEndedAt ?? item.endedAt ?? item.at ?? null;
  return item.at ?? null;
}

export function conversationDiscussionRows(
  rows: ConversationDebateFeedRow[],
  options?: { discussions?: readonly TaskDiscussion[] | null },
): ConversationDebateFeedRow[] {
  const records = new Map((options?.discussions ?? []).map((item) => [item.id, item]));
  const out: ConversationDebateFeedRow[] = [];
  let open: (ConversationDiscussionRow & { discussionId: string }) | null = null;
  const flush = () => {
    if (!open) return;
    const { discussionId: _, ...lane } = open;
    if (lane.discussion) lane.items = lane.items.filter((item) => noteOf(item)?.phase !== "segment");
    out.push(lane);
    open = null;
  };

  for (const row of rows) {
    if (row.kind !== "item") {
      flush();
      out.push(row);
      continue;
    }
    if (synthesisPrompt(row.item)) continue;
    const note = noteOf(row.item);
    if (note?.phase === "start") {
      flush();
      const discussion = records.get(note.id) ?? null;
      open = {
        kind: "discussion-lane",
        id: `discussion-lane:${note.id}`,
        discussionId: note.id,
        items: [row.item],
        discussion,
        startedAt: row.item.at ?? null,
        endedAt: row.item.at ?? null,
      };
      continue;
    }
    // 别的场的那几句（开始那句没读到）不折进这一场，原样留着。
    if (open && note && note.id !== open.discussionId) flush();
    if (!open || closeBefore(row.item)) {
      flush();
      out.push(row);
      continue;
    }
    open.items.push(row.item);
    open.endedAt = itemEnd(row.item) ?? open.endedAt;
    if (note?.phase === "end") flush();
  }
  flush();
  return out;
}
