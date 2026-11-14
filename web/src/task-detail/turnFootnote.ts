// 回合的尾注：一回合之后发生的、要你知道的那几件事，并成回合正文下面的一句小灰字。
//
// 哪些事进尾注由分档表定（timelineNoticeCopy：milestone / alert 两档）；记在哪一回合上由
// conversationSystemRows 定。收了口的审查轮不在尾注里：它是审查者对执行者说的话，在会话右边
// 自己占一行（ReviewBubble），跟在它后面的那几句贴在它下面，同样用这里并成一句。
// 这里只管「并成一句」：
//   - 每件事只留最近一句（验收、异常结束、其余要你知道的各一句），被盖过的照样在「N 条记录」里；
//   - 验收成了以后，它之前那些要你知道的（验收暂缓之类）退回记录；
//   - 最多三句，按先后排。
// 颜色只说现在的事：尾注所在的回合（或审查结论）是会话里最后一件事、后面又没有你的话，它才是
// 「现在」，这时坏消息字前才有一颗小圆点（`live`）。
import type { ConversationItem } from "./conversationModel.ts";
import type { TurnReceipt } from "./conversationSystemRows.ts";
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
  /** 这一轮异常结束（刷新以后从会话行认出来的，见 turnFailure）。 */
  | { kind: "failure"; id: string; at?: string; view: NoticeView }
  /** 一轮审查为什么没给出结论（按轮次身份从审查状态取的，见 reviewNoVerdictCause）。 */
  | { kind: "cause"; id: string; at?: string; view: NoticeView };

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

/** 收这一轮的那个词：先认结论旁注原本的说法（「没能开始」不并进「没有结论」）。 */
function laneVerdict(lane: ConversationReviewLane): ReviewVerdictWord {
  return lane.verdict ?? (lane.conclusion ? VERDICT[lane.conclusion] : "inconclusive");
}

/** 出了结论的那一轮收成的一句：「第 3 轮审查通过」「第 2 轮审查未通过，2 条意见」「第 1 轮审查没能开始」。 */
export function reviewLaneSentence(lane: ConversationReviewLane): string {
  return reviewVerdictText(lane.source, lane.round, laneVerdict(lane), lane.findings);
}

export function laneVerdictView(lane: ConversationReviewLane): NoticeView {
  const verdict = laneVerdict(lane);
  return {
    // 没能开始的那一轮跟带类型的旁注同一档（timelineNoticeCopy 的 review.verdict）。
    tier: verdict === "aborted" ? "alert" : "milestone", tone: reviewVerdictTone(verdict), topic: "review", icon: "review",
    text: reviewLaneSentence(lane), detail: null, dispute: false,
  };
}

/** 收了这一轮的那条结论旁注（删除它、在记录里按它排时刻）。就地验证靠阶段翻档收口时可能没有。 */
export function laneVerdictEvent(lane: ConversationReviewLane): EventItem | null {
  return lane.items.findLast((item): item is EventItem => item.kind === "event" && verifyMarkOf(item)?.phase === "end") ?? null;
}

/** 指到审查结论才出的那一行：谁审的、用时、什么时候出的结论。 */
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

/**
 * 一轮审查摆出来的样子由哪些东西定：那一句（结论、几条意见），点它去哪儿（哪一场、哪一轮），
 * 摊开以后有什么（报告入口、派审附言、谁审的、用时、那一轮里的每一条）。记录里那一条拿它当
 * 签名——审查记录晚到一步补上了哪一场、有没有报告，签名就变，那一回合就重画。
 */
export function laneKey(lane: ConversationReviewLane): string {
  return JSON.stringify([
    lane.id, lane.source, lane.round, lane.conclusion, lane.verdict, lane.findings, lane.runId,
    lane.reportAvailable, lane.report, lane.note, lane.reviewerLabel, lane.startedAt, lane.endedAt,
    lane.items.map((item) => item.kind === "agent"
      ? [item.id, item.endedAt, item.markdown.length, item.segments.length]
      : item.kind === "event" ? [item.id, item.text] : [item.id]),
  ]);
}

function viewKey(view: NoticeView): string {
  return JSON.stringify([view.text, view.tone, view.tier, view.detail, view.mono, view.meta]);
}

/** 尾注的签名：已经收口的回合只在它变了的时候重画（见 ConversationFeed 的 sameSettledTurn）。 */
export function footnoteKey(footnote: TurnFootnote | undefined, extra = ""): string {
  if (!footnote) return extra;
  return [
    footnote.live ? "live" : "past",
    ...footnote.parts.map((part) => `${part.id}:${part.at}:${viewKey(part.view)}`),
    extra,
  ].join("|");
}

/** 记在一回合上的那份记录的签名：每一条摆出来的字、能不能点、点了去哪儿，变了就重画。 */
export function receiptsKey(receipts: readonly TurnReceipt[] | undefined): string {
  return (receipts ?? [])
    .map((receipt) => `${receipt.id}:${receipt.at}:${receipt.item?.id ?? ""}:${viewKey(receipt.view)}:${receipt.lane ? laneKey(receipt.lane) : ""}`)
    .join("|");
}
