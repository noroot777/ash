import type { FreeReviewRun } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationFeedRow } from "./conversationReviewLanes.ts";
import { debateCandidatesOf, type DebateCandidate } from "../free-workflow/debateModel.ts";

/**
 * 时间线上的一整场辩论，折成一行。
 *
 * 展开前它在会话里是这样的：`开始辩论第 N 轮审查意见…` + 七条 `辩论第 i/7 段：轮到 X
 * 发言` 的流水旁注 + 七颗气泡 + `辩论结束…`。十六行东西讲一件事，而且那七颗气泡讲的
 * 还**不是**辩论的记录——真正的发言走 `debate_reply` 落库，气泡里只是各自随口的交代
 * （codex 一句「本段发言已提交」、claude 把整段又讲一遍）。所以按对话渲染必然是一边
 * 完整一边空白，用户 2026-09-24 报的「codex 那一方所有结论我都看不到」就是这么来的。
 *
 * 折起来之后：卡头一行给出「谁跟谁、几段、审查者自述什么立场」，展开列的是 statement。
 */
export type ConversationDebateRow = {
  kind: "debate-lane";
  id: string;
  /** 辩的是第几轮审查意见；旁注里只有轮号，配对全靠它。 */
  round: number | null;
  /** 折进来的原始行。配不到落盘记录时原样摆出来兜底，绝不凭空少掉一段。 */
  items: ConversationItem[];
  /** 配到的落盘记录；null = 只读视图没传 reviews，或这场辩论还没落到快照里。 */
  candidate: DebateCandidate | null;
  /** 同一条驳回上辩过多次时的第几次（只有一次就是 null）。 */
  ordinal: number | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type ConversationDebateFeedRow = ConversationFeedRow | ConversationDebateRow;

const DEBATE_START = /^开始辩论第\s*(\d+)\s*轮审查意见/;
// 收口的两句：好好辩完，或者某一段没能起跑而中止。两句都由 free-review-debate.ts 写。
const DEBATE_END = /^辩论结束[，,]|辩论已中止[；;]/;
/** 段间流水（「轮到审查者发言」）—— 折起来之后一条都不留：它讲的是进度，不是内容。 */
const DEBATE_SEGMENT = /^辩论第\s*\d+(?:\/\d+)?\s*段[：:]/;

function debateNoteKind(item: ConversationItem): "start" | "end" | "segment" | null {
  if (item.kind !== "event") return null;
  const text = item.text.replace(/^〔系统〕/, "").trim();
  if (DEBATE_START.test(text)) return "start";
  if (DEBATE_END.test(text)) return "end";
  if (DEBATE_SEGMENT.test(text)) return "segment";
  return null;
}

function roundOf(item: ConversationItem): number | null {
  if (item.kind !== "event") return null;
  const matched = DEBATE_START.exec(item.text.replace(/^〔系统〕/, "").trim());
  const round = matched ? Number(matched[1]) : Number.NaN;
  return Number.isFinite(round) ? round : null;
}

function itemEnd(item: ConversationItem): string | null {
  if (item.kind === "agent") return item.markerEndedAt ?? item.endedAt ?? item.at ?? null;
  return item.at ?? null;
}

/**
 * 真人插话就收口。辩论期间任务是停着的（每一段都是旁路回合），正常情况下这条兜底用不上；
 * 但辩论中途崩掉、`辩论结束` 那句永远不会来时，没有它这张卡会把后面所有内容都吞进去。
 */
function closeBefore(item: ConversationItem): boolean {
  return item.kind === "user" && !item.bySystem && !item.isAnswer;
}

export function conversationDebateRows(
  rows: ConversationFeedRow[],
  options?: { reviews?: readonly FreeReviewRun[] | null },
): ConversationDebateFeedRow[] {
  const candidates = debateCandidatesOf(options?.reviews);
  // 「第 k 场第 N 轮」配「第 k 条第 N 轮」：同一条驳回上可以辩多次（中断的那条能重开），
  // 「找到就用」会让第二场显示第一场的发言。
  const used = new Set<number>();
  const seenOfRound = new Map<number, number>();
  const take = (round: number | null): { candidate: DebateCandidate | null; ordinal: number | null } => {
    if (round === null) return { candidate: null, ordinal: null };
    const seen = (seenOfRound.get(round) ?? 0) + 1;
    seenOfRound.set(round, seen);
    const index = candidates.findIndex((item, at) => !used.has(at) && item.round === round);
    if (index < 0) return { candidate: null, ordinal: seen > 1 ? seen : null };
    used.add(index);
    const total = candidates.filter((item) => item.round === round).length;
    return { candidate: candidates[index]!, ordinal: total > 1 ? seen : null };
  };

  const out: ConversationDebateFeedRow[] = [];
  let open: ConversationDebateRow | null = null;
  const flush = () => {
    if (!open) return;
    // 段间流水只在折叠卡里降噪；配不到落盘记录时留着，否则兜底视图会缺一半骨架。
    if (open.candidate) open.items = open.items.filter((item) => debateNoteKind(item) !== "segment");
    out.push(open);
    open = null;
  };

  for (const row of rows) {
    if (row.kind !== "item") {
      flush();
      out.push(row);
      continue;
    }
    const kind = debateNoteKind(row.item);
    if (kind === "start") {
      flush();
      const round = roundOf(row.item);
      const { candidate, ordinal } = take(round);
      open = {
        kind: "debate-lane",
        id: `debate-lane:${round ?? "?"}:${row.item.id}`,
        round,
        items: [row.item],
        candidate,
        ordinal,
        startedAt: row.item.at ?? null,
        endedAt: row.item.at ?? null,
      };
      continue;
    }
    if (!open) {
      out.push(row);
      continue;
    }
    if (closeBefore(row.item)) {
      flush();
      out.push(row);
      continue;
    }
    open.items.push(row.item);
    open.endedAt = itemEnd(row.item) ?? open.endedAt;
    if (kind === "end") flush();
  }
  flush();
  return out;
}
