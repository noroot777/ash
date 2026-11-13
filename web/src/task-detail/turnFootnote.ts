// 回合的尾注：一回合之后发生的、要你知道的那几件事，并成回合正文下面的一句小灰字。
//
// 哪些事进尾注由分档表定（timelineNoticeCopy：milestone / alert 两档）；记在哪一回合上由
// conversationSystemRows 定。这里只管「并成一句」：
//   - 每件事只留最近一句（审查结论、验收、异常结束、其余要你知道的各一句），重跑、重审过的
//     不并排，被盖过的照样在「N 条记录」里；
//   - 验收成了以后，它之前那些要你知道的（验收暂缓之类）退回记录；
//   - 最多三句，按先后排。
// 颜色只说现在的事：尾注所在的回合是会话里最后一个回合、后面又没有你的话，它才是「现在」，
// 这时坏消息字前才有一颗小圆点（`live`）。
import type { ConversationItem } from "./conversationModel.ts";
import { verifyMarkOf } from "./conversationNotes.ts";
import type { ConversationReviewLane, ReviewLaneConclusion } from "./conversationReviewLanes.ts";
import {
  reviewVerdictText, reviewVerdictTone, type NoticeTopic, type NoticeView, type ReviewVerdictWord,
} from "./timelineNoticeCopy.ts";
import { durationBetween, formatInstant } from "./utils.ts";

type EventItem = Extract<ConversationItem, { kind: "event" }>;

export type FootnotePart =
  /** 一条时间线记录（里程碑 / 要你知道的）。 */
  | { kind: "event"; id: string; at?: string; view: NoticeView; item?: EventItem }
  /** 收了口的一轮审查：点它去审查格的那一轮，或者就地摊开那一轮的经过。 */
  | { kind: "review"; id: string; at?: string; view: NoticeView; lane: ConversationReviewLane }
  /** 这一轮异常结束（刷新以后从会话行认出来的，见 turnFailure）。 */
  | { kind: "failure"; id: string; at?: string; view: NoticeView };

export type TurnFootnote = {
  id: string;
  parts: FootnotePart[];
  /** 它还是现在的事：坏消息字前才有那颗小圆点。 */
  live: boolean;
};

const VERDICT: Record<Exclude<ReviewLaneConclusion, null>, ReviewVerdictWord> = {
  verified: "passed",
  verify_failed: "failed",
  inconclusive: "inconclusive",
};

/** 出了结论的那一轮收成的一句：「第 3 轮审查通过」「第 2 轮审查未通过，2 条意见」。 */
export function reviewLaneSentence(lane: ConversationReviewLane): string {
  const verdict = lane.conclusion ? VERDICT[lane.conclusion] : "inconclusive";
  return reviewVerdictText(lane.source, lane.round, verdict, lane.findings);
}

export function laneVerdictView(lane: ConversationReviewLane): NoticeView {
  const verdict = lane.conclusion ? VERDICT[lane.conclusion] : "inconclusive";
  return {
    tier: "milestone", tone: reviewVerdictTone(verdict), topic: "review",
    text: reviewLaneSentence(lane), detail: null, dispute: false,
  };
}

/** 收了这一轮的那条结论旁注（删除它、在记录里按它排时刻）。就地验证靠阶段翻档收口时可能没有。 */
export function laneVerdictEvent(lane: ConversationReviewLane): EventItem | null {
  return lane.items.findLast((item): item is EventItem => item.kind === "event" && verifyMarkOf(item)?.phase === "end") ?? null;
}

/** 指到才出的那半句：谁审的、用时、什么时候出的结论。 */
export function reviewLaneTail(lane: ConversationReviewLane): string {
  return [lane.reviewerLabel, durationBetween(lane.startedAt, lane.endedAt), formatInstant(lane.endedAt)]
    .filter(Boolean)
    .join(" · ");
}

/** 指到才出的那半句：（是哪条命令 ·）时刻。 */
export function noticeTail(view: Pick<NoticeView, "meta">, at?: string): string | null {
  return [view.meta, at ? formatInstant(at) : ""].filter(Boolean).join(" · ") || null;
}

export function footnotePartTail(part: FootnotePart): string | null {
  if (part.kind === "review") return reviewLaneTail(part.lane) || null;
  return noticeTail(part.view, part.at);
}

const MAX_PARTS = 3;

/** 同一回合上攒下的那几件事（按先后）→ 尾注里留下的那几句。 */
export function composeFootnote(parts: readonly FootnotePart[]): FootnotePart[] {
  const latest = new Map<NoticeTopic, number>();
  parts.forEach((part, index) => latest.set(part.view.topic, index));
  const acceptedAt = latest.get("accept") ?? -1;
  return parts
    .filter((part, index) => latest.get(part.view.topic) === index && (part.view.topic !== "other" || index > acceptedAt))
    .slice(-MAX_PARTS);
}

/** 尾注的签名：已经收口的回合只在它变了的时候重画（见 ConversationFeed 的 sameSettledTurn）。 */
export function footnoteKey(footnote: TurnFootnote | undefined, extra = ""): string {
  if (!footnote) return extra;
  return [
    footnote.live ? "live" : "past",
    ...footnote.parts.map((part) => part.kind === "review"
      ? `${part.id}:${part.lane.conclusion}:${part.lane.runId}:${part.lane.reportAvailable}:${part.lane.reviewerLabel}:${part.lane.items.length}`
      : `${part.id}:${part.view.text}:${part.view.tone}`),
    extra,
  ].join("|");
}
