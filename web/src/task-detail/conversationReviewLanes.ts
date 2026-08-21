import { LEGACY_SYS_MARKER } from "@ash/shared";
import type { FreeReviewRun } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import { verifyNoteOf, type VerifyNoteMark } from "./conversationNotes.ts";

export type ReviewLaneConclusion = "verified" | "verify_failed" | "inconclusive" | null;
export type ReviewLaneSource = VerifyNoteMark["kind"];

/** 这张卡的报告在哪：两种审查落盘目录不同，free 的 URL 还多一个 runId。 */
export type ReviewLaneReport =
  | { kind: "inline"; round: number }
  | { kind: "free"; runId: string; round: number };

export type ConversationReviewLane = {
  kind: "review-lane";
  id: string;
  source: ReviewLaneSource;
  /** 合并结果审查没有轮号（它跑在验收后的只读快照上，一次就是一次）。 */
  round: number | null;
  title: string;
  items: ConversationItem[];
  reviewerLabel: string | null;
  reviewerModel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  conclusion: ReviewLaneConclusion;
  complete: boolean;
  reportAvailable: boolean;
  report: ReviewLaneReport | null;
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
  if (!mark || mark.phase !== "end") return null;
  if (mark.kind === "inline") {
    if (item.tone === "error") return "verify_failed";
    return /第\s*\d+\s*轮验证通过(?:$|[。，；：\s])/.test(item.text) ? "verified" : "inconclusive";
  }
  // 自由派审 / 合并结果审查的收尾旁注。tone 在这里不能当判据：「未通过」本身就命中
  // noteTone 的失败词表，跟「启动失败」是同一个红，可结论完全不同。
  if (/审查通过/.test(item.text)) return "verified";
  if (/审查(仍)?未通过/.test(item.text)) return "verify_failed";
  return "inconclusive";
}

function laneStart(item: ConversationItem): VerifyNoteMark | null {
  if (item.kind !== "event") return null;
  const mark = verifyNoteOf(item.text);
  return mark?.phase === "start" ? mark : null;
}

function matchingEnd(item: ConversationItem, lane: ActiveLane): boolean {
  if (item.kind !== "event") return false;
  const mark = verifyNoteOf(item.text);
  if (mark?.phase !== "end" || mark.kind !== lane.source) return false;
  // 「自由工作流审查仍未通过，自动复审次数已用完」这类收尾不带轮号，但它收的就是
  // 当前这一轮 —— 不认的话最后一轮永远等不到收口。
  return mark.round === lane.round || (lane.source === "free" && mark.round === null);
}

function closeBefore(lane: ActiveLane, item: ConversationItem): boolean {
  if (item.kind === "user") return !item.bySystem && !item.isAnswer;
  if (item.kind === "agent") {
    // 就地验证搭在被验任务自己的会话上，区间内说话的就是审查者；轮次徽标要等 run 事件
    // 或旁注区间补上，所以在审查者开口前先放行（reviewerSpoke 门禁）。
    // 自由派审反过来 —— 它另开一条 reviewer 会话，主任务完全可能同时在说话，那些发言
    // 一旦折进审查卡就会被默认收起、彻底藏掉，所以不是本轮审查者就立刻收口。
    if (lane.source === "inline") return lane.reviewerSpoke && item.reviewer?.round !== lane.round;
    return item.reviewer?.round !== lane.round;
  }
  // 自由派审段落里的旁注全归这张卡，收口交给服务端一定会写的那条结束旁注（matchingEnd）
  // 以及上面两条兜底；就地验证没有这样一条必到的收尾信号，只能推。
  if (lane.source !== "inline") return false;
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
  // 就地验证的报告只能推：跑完且审查者确实说过话，就当那一轮有 report.md。
  // 自由派审不用推，下面 attachReports 拿得到落盘状态里的 reportMarkdown。
  if (lane.source === "inline") {
    lane.reportAvailable = lane.complete && lane.reviewerSpoke;
    if (lane.reportAvailable && lane.round !== null) lane.report = { kind: "inline", round: lane.round };
  }
  const { reviewerSpoke: _reviewerSpoke, ...finished } = lane;
  return finished;
}

function titleOf(mark: VerifyNoteMark): string {
  if (mark.kind === "merge") return "合并结果审查";
  return `第 ${mark.round} 轮${mark.kind === "inline" ? "验证" : "审查"}`;
}

/**
 * 给自由派审 / 合并结果审查的卡补上报告入口。
 *
 * 报告落在 `data/runs/<taskId>/free-review/<runId>/round-<N>/report.md`，URL 少了 runId
 * 就打不开；而时间线旁注里**只有轮号**（服务端从不把 runId 写进去）。所以只能拿
 * `FreeWorkflowState.reviews` 反查：同一类 target 下按起始时间升序、轮号对得上就依次配对，
 * 配过的不再复用 —— 同一个轮号在重开的审查里会重复出现，一一对应比「找到就用」稳。
 */
function attachReports(lanes: ConversationReviewLane[], reviews: readonly FreeReviewRun[]): void {
  const candidates = reviews
    .flatMap((run) => (run.rounds ?? []).map((round) => ({
      runId: run.id,
      round: round.round,
      source: run.target?.kind === "accepted_merge" ? "merge" as const : "free" as const,
      startedAt: round.startedAt ?? "",
      hasReport: (round.reportMarkdown ?? "").trim().length > 0,
      reviewerName: run.reviewerName,
      model: run.model,
    })))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const assigned = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    // 重跑异常回合沿用同一个 runId + round，数据库也只保留这一条 round；时间线上却有
    // 「启动失败旧卡 + 重跑结果卡」两张。候选应落到本次 run 的时间窗口内最后一次尝试，
    // 下一条同类 round 的 startedAt 就是窗口右边界。否则旧卡会抢走后来生成的报告。
    const nextAt = candidates.slice(index + 1)
      .find((next) => next.source === candidate.source)?.startedAt ?? null;
    const started = Date.parse(candidate.startedAt);
    const ended = nextAt ? Date.parse(nextAt) : Number.NaN;
    const matching = lanes.filter((lane) => {
      if (assigned.has(lane.id) || lane.source !== candidate.source) return false;
      if (candidate.source === "free" && lane.round !== candidate.round) return false;
      const at = lane.startedAt ? Date.parse(lane.startedAt) : Number.NaN;
      if (Number.isFinite(started) && Number.isFinite(at) && at < started) return false;
      if (Number.isFinite(ended) && Number.isFinite(at) && at >= ended) return false;
      return true;
    });
    const lane = matching.at(-1);
    if (!lane) continue;
    assigned.add(lane.id);
    // 审查者会话还没落盘时卡上没有气泡可推名字，用配到的这一 run 补齐。
    lane.reviewerLabel ??= candidate.reviewerName || null;
    lane.reviewerModel ??= candidate.model;
    if (!candidate.hasReport) continue;
    lane.reportAvailable = true;
    lane.report = { kind: "free", runId: candidate.runId, round: candidate.round };
  }
}

// D 方案的结构推导：把「第 N 轮验证开始」「自由工作流第 N 轮审查开始」「合并结果审查开始」
// 各自圈出的那一段折成一张结论卡，历史轮默认收起、只留结论和报告入口。
export function conversationFeedRows(
  items: ConversationItem[],
  options?: { reviews?: readonly FreeReviewRun[] | null },
): ConversationFeedRow[] {
  const rows: ConversationFeedRow[] = [];
  let active: ActiveLane | null = null;
  const pushActive = (opts?: { complete?: boolean; superseded?: boolean }) => {
    if (!active) return;
    rows.push(finishLane(active, opts));
    active = null;
  };

  for (const item of items) {
    const start = laneStart(item);
    // 同一轮的「重跑上一回合」接着原来那张卡跑，不另开一张只有半截的历史卡。
    const rerun = !!active && !!start && start.kind === active.source && start.round === active.round;
    if (active && start && !rerun) pushActive({ superseded: true });
    else if (active && closeBefore(active, item)) pushActive();
    if (!active && start) {
      active = {
        kind: "review-lane",
        id: `review-lane:${start.kind}:${start.round ?? "once"}:${item.id}`,
        source: start.kind,
        round: start.round,
        title: titleOf(start),
        items: [],
        reviewerLabel: null,
        reviewerModel: null,
        startedAt: item.at ?? null,
        endedAt: item.at ?? null,
        conclusion: null,
        complete: false,
        reportAvailable: false,
        report: null,
        defaultCollapsed: false,
        reviewerSpoke: false,
      };
    }
    if (!active) {
      rows.push({ kind: "item", item });
      continue;
    }
    addToLane(active, item);
    if (matchingEnd(item, active)) pushActive({ complete: true });
  }
  pushActive();

  const lanes = rows.filter((row): row is ConversationReviewLane => row.kind === "review-lane");
  attachReports(lanes, options?.reviews ?? []);
  const latest = lanes.at(-1);
  for (const lane of lanes) {
    // 设计稿 D 的默认规则：已有结论、且后面还有更新轮次的历史卡折起来；最新轮和
    // 正在跑的轮次展开，避免用户只看见一张不动的卡片。
    lane.defaultCollapsed = lane !== latest && lane.conclusion !== null;
  }
  return rows;
}
