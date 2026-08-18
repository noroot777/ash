import { LEGACY_SYS_MARKER } from "@harness/shared";
import type { ConversationItem } from "./conversationModel.ts";
import { verifyNoteOf } from "./conversationNotes.ts";

export type ReviewLaneConclusion = "verified" | "verify_failed" | "inconclusive" | null;

export type ConversationReviewLane = {
  kind: "review-lane";
  id: string;
  round: number;
  items: ConversationItem[];
  reviewerLabel: string | null;
  reviewerModel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  conclusion: ReviewLaneConclusion;
  complete: boolean;
  reportAvailable: boolean;
  defaultCollapsed: boolean;
};

export type ConversationFeedRow =
  | { kind: "item"; item: ConversationItem }
  | ConversationReviewLane;

type ActiveLane = ConversationReviewLane & { reviewerSpoke: boolean };

const STAGE_CONCLUSION = /验收阶段更新：.*（(verified|verify_failed)）/;

function itemEnd(item: ConversationItem): string | null {
  if (item.kind === "agent") return item.markerEndedAt ?? item.endedAt ?? item.at ?? null;
  return item.at ?? null;
}

function conclusionOf(item: ConversationItem): ReviewLaneConclusion {
  if (item.kind !== "event") return null;
  const stage = STAGE_CONCLUSION.exec(item.text)?.[1];
  if (stage === "verified" || stage === "verify_failed") return stage;
  const mark = verifyNoteOf(item.text);
  if (mark?.kind !== "inline" || mark.phase !== "end") return null;
  if (item.tone === "error") return "verify_failed";
  return /第\s*\d+\s*轮验证通过(?:$|[。，；：\s])/.test(item.text) ? "verified" : "inconclusive";
}

function inlineStart(item: ConversationItem): number | null {
  if (item.kind !== "event") return null;
  const mark = verifyNoteOf(item.text);
  return mark?.kind === "inline" && mark.phase === "start" ? mark.round : null;
}

function matchingInlineEnd(item: ConversationItem, round: number): boolean {
  if (item.kind !== "event") return false;
  const mark = verifyNoteOf(item.text);
  return mark?.kind === "inline" && mark.phase === "end" && mark.round === round;
}

function closeBefore(lane: ActiveLane, item: ConversationItem): boolean {
  if (item.kind === "user") return !item.bySystem && !item.isAnswer;
  if (item.kind === "agent") return lane.reviewerSpoke && item.reviewer?.round !== lane.round;
  return !!lane.conclusion && lane.reviewerSpoke
    && (
      item.variant === "boundary"
      || item.text.includes(LEGACY_SYS_MARKER)
      // verified 阶段通告之后，审查者还会继续写最终结论；真正跟在它后面的第一条普通
      // 生命周期旁注（开始验收 / 合并 / 清理 / 唤醒）才是 D 卡的稳定收口。历史落盘稿
      // 没有直播 turnEnd，这条判据同时覆盖刷新后的存量会话。
      || conclusionOf(item) === null
    );
}

function addToLane(lane: ActiveLane, item: ConversationItem): void {
  lane.items.push(item);
  lane.endedAt = itemEnd(item) ?? lane.endedAt;
  const conclusion = conclusionOf(item);
  if (conclusion) lane.conclusion = conclusion;
  if (item.kind !== "agent" || item.reviewer?.round !== lane.round) return;
  lane.reviewerSpoke = true;
  lane.reviewerLabel ??= item.label;
  lane.reviewerModel ??= item.run?.model ?? null;
}

function finishLane(
  lane: ActiveLane,
  { complete = false, superseded = false }: { complete?: boolean; superseded?: boolean } = {},
): ConversationReviewLane {
  if (superseded && lane.conclusion === null) lane.conclusion = "inconclusive";
  lane.complete = complete || superseded || lane.conclusion !== null;
  lane.reportAvailable = lane.complete && lane.reviewerSpoke;
  const { reviewerSpoke: _reviewerSpoke, ...finished } = lane;
  return finished;
}

// D 方案的结构推导：只把「第 N 轮验证开始」圈出的就地验证折成结论卡。
// 自由派审本来就有独立 reviewer 会话和自己的报告入口，不混进这条泳道。
export function conversationFeedRows(items: ConversationItem[]): ConversationFeedRow[] {
  const rows: ConversationFeedRow[] = [];
  let active: ActiveLane | null = null;
  const pushActive = (options?: { complete?: boolean; superseded?: boolean }) => {
    if (!active) return;
    rows.push(finishLane(active, options));
    active = null;
  };

  for (const item of items) {
    const round = inlineStart(item);
    if (active && round !== null) pushActive({ superseded: true });
    else if (active && closeBefore(active, item)) pushActive();
    if (!active && round !== null) {
      active = {
        kind: "review-lane",
        id: `review-lane:${round}:${item.id}`,
        round,
        items: [],
        reviewerLabel: null,
        reviewerModel: null,
        startedAt: item.at ?? null,
        endedAt: item.at ?? null,
        conclusion: null,
        complete: false,
        reportAvailable: false,
        defaultCollapsed: false,
        reviewerSpoke: false,
      };
    }
    if (!active) {
      rows.push({ kind: "item", item });
      continue;
    }
    addToLane(active, item);
    if (matchingInlineEnd(item, active.round)) pushActive({ complete: true });
  }
  pushActive();

  const lanes = rows.filter((row): row is ConversationReviewLane => row.kind === "review-lane");
  const latest = lanes.at(-1);
  for (const lane of lanes) {
    // 设计稿 D 的默认规则：已有结论、且后面还有更新轮次的历史卡折起来；最新轮和
    // 正在跑的轮次展开，避免用户只看见一张不动的卡片。
    lane.defaultCollapsed = lane !== latest && lane.conclusion !== null;
  }
  return rows;
}
