import { useEffect, useId, useState, type ReactNode } from "react";
import { FileText, ShieldCheck } from "@phosphor-icons/react";
import { ReviewReportDialog } from "../components/MarkdownBody.tsx";
import type { ReviewFileTarget } from "../components/markdownPolicy.ts";
import { api } from "../lib/api.ts";
import { ReviewNote } from "../review/ReviewNote.tsx";
import { reviewPanelSources, reviewTargetLocatable, type ReviewTarget } from "../review/reviewTarget.ts";
import type { ConversationReviewLane, ReviewLaneConclusion } from "./conversationReviewLanes.ts";
import { NoticeLine } from "./SystemNotice.tsx";
import { reviewVerdictText, reviewVerdictTone, type ReviewVerdictWord } from "./timelineNoticeCopy.ts";
import { durationBetween, formatInstant } from "./utils.ts";

function stateOf(conclusion: ReviewLaneConclusion, complete: boolean) {
  if (conclusion === "verified") return { className: "is-verified", label: "已通过" };
  if (conclusion === "verify_failed") return { className: "is-failed", label: "未通过" };
  if (conclusion === "inconclusive" || complete) return { className: "is-inconclusive", label: "无结论" };
  return { className: "is-running", label: "进行中" };
}

function timing(lane: ConversationReviewLane): string | null {
  const start = formatInstant(lane.startedAt);
  const end = lane.complete ? formatInstant(lane.endedAt) : "";
  const duration = lane.complete ? durationBetween(lane.startedAt, lane.endedAt) : null;
  if (!start) return duration;
  return `${start}${end && end !== start ? `–${end}` : ""}${duration ? ` · ${duration}` : ""}`;
}

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

/** 点这一轮去审查格时带的话：来源、那一场、第几轮（见 review/reviewTarget）。 */
export function laneReviewTarget(lane: ConversationReviewLane): ReviewTarget {
  return { source: lane.source, runId: lane.runId, round: lane.round };
}

/**
 * 这一轮点了去不去审查格：认得出是哪一条记录（老时间线配不上那一场、这个任务的审查格不装这一类
 * 都算认不出）才给 `open`，否则不给——ReviewerLane 就在原处展开，不去审查格猜。
 */
export function laneRoundOpener(
  lane: ConversationReviewLane,
  workflowMode: string | null | undefined,
  open: ((target: ReviewTarget) => void) | undefined,
): ((target: ReviewTarget) => void) | undefined {
  return open && reviewTargetLocatable(laneReviewTarget(lane), reviewPanelSources(workflowMode)) ? open : undefined;
}

/** 指到才出的那半句：谁审的、用时、什么时候出的结论。 */
export function reviewLaneTail(lane: ConversationReviewLane): string {
  return [lane.reviewerLabel, durationBetween(lane.startedAt, lane.endedAt), formatInstant(lane.endedAt)]
    .filter(Boolean)
    .join(" · ");
}

export function ReviewerLane({
  taskId,
  lane,
  children,
  onOpenRound,
}: {
  taskId: string;
  lane: ConversationReviewLane;
  children: ReactNode;
  /**
   * 出了结论的轮次点一下去右侧「审查」格、展开这一轮（带着来源和那一场，见 review/reviewTarget）。
   * 不给（只读视图、团队时间线没有那一格，或者认不出这一轮是哪一条记录）就在原处摊开这一轮的经过。
   */
  onOpenRound?: (target: ReviewTarget) => void;
}) {
  // 收了口的一轮（出了结论，或者到头了也没给出结论）收成一行；还在跑的保留整张卡。
  if (lane.complete) return <ReviewMilestone taskId={taskId} lane={lane} onOpenRound={onOpenRound}>{children}</ReviewMilestone>;
  return <RunningReviewLane taskId={taskId} lane={lane}>{children}</RunningReviewLane>;
}

/**
 * 出了结论的审查轮：一行一句，整行可点。颜色只在行首那颗盾上，结论写在字里；谁审的、
 * 用时、时刻指到再看。点开去右侧「审查」格的这一轮（报告、附言、证据都在那儿）。
 */
function ReviewMilestone({ taskId, lane, children, onOpenRound }: {
  taskId: string;
  lane: ConversationReviewLane;
  children: ReactNode;
  onOpenRound?: (target: ReviewTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [report, setReport] = useState<ReviewFileTarget | null>(null);
  const bodyId = useId();
  const verdict = lane.conclusion ? VERDICT[lane.conclusion] : "inconclusive";
  const view = {
    tier: "milestone" as const,
    tone: reviewVerdictTone(verdict),
    glyph: "review" as const,
    text: reviewLaneSentence(lane),
    detail: null,
  };
  const openReport = () => {
    const target = lane.report;
    if (!target) return;
    setReport({ name: "report.md", url: reportUrl(taskId, target) });
  };
  return (
    <section className="review-milestone" aria-label={view.text}>
      <NoticeLine
        view={view}
        tail={reviewLaneTail(lane)}
        onOpen={onOpenRound ? () => onOpenRound(laneReviewTarget(lane)) : () => setExpanded((value) => !value)}
        openLabel={onOpenRound ? "在右侧审查格里打开这一轮" : expanded ? "收起这一轮的经过" : "展开这一轮的经过"}
      />
      {!onOpenRound && expanded && (
        <div className="review-milestone-body" id={bodyId}>
          {lane.reportAvailable && lane.report && (
            <button type="button" className="review-milestone-report" onClick={openReport}>
              <FileText size={12} aria-hidden="true" />审查报告
            </button>
          )}
          {lane.note && <ReviewNote text={lane.note} />}
          {children}
        </div>
      )}
      {report && <ReviewReportDialog target={report} onReviewReport={setReport} onClose={() => setReport(null)} />}
    </section>
  );
}

function reportUrl(taskId: string, target: NonNullable<ConversationReviewLane["report"]>): string {
  return target.kind === "inline"
    ? api.taskReviewFileUrl(taskId, target.round, "report.md")
    : api.freeReviewFileUrl(taskId, target.runId, target.round, "report.md");
}

/** 审查进行中：保留整张卡，看得见审查者正在说什么。 */
function RunningReviewLane({
  taskId,
  lane,
  children,
}: {
  taskId: string;
  lane: ConversationReviewLane;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(lane.defaultCollapsed);
  const [report, setReport] = useState<ReviewFileTarget | null>(null);
  const bodyId = useId();
  const state = stateOf(lane.conclusion, lane.complete);
  const time = timing(lane);
  // 附言也是卡内容的一部分：审查者一句话没说的轮次（刚起、或起就失败），展开后至少
  // 还能看见「我当时要求他重点看什么」。
  const hasBody = lane.items.length > 0 || !!lane.note;
  const bodyHidden = collapsed || !hasBody;
  const reviewerModel = lane.reviewerModel && !lane.reviewerLabel?.includes(lane.reviewerModel)
    ? lane.reviewerModel
    : null;
  // 卡内首条气泡的头整条省掉了（见 reviewLaneMessageRoles），模型和智能水平只剩这一处可看。
  const reviewerMeta = [reviewerModel, lane.reviewerEffort].filter(Boolean).join(" · ");

  // 轮次跑出结论后默认规则会从「展开」翻成「折叠」；只在这条默认规则发生变化时自动
  // 折叠一次。用户随后手动展开，不会被 SSE 的普通刷新反复关回去。
  useEffect(() => setCollapsed(lane.defaultCollapsed), [lane.defaultCollapsed, lane.id]);

  const openReport = () => {
    const target = lane.report;
    if (!target) return;
    setReport({ name: "report.md", url: reportUrl(taskId, target) });
  };

  return (
    <article className={`verify-lane${bodyHidden ? " is-collapsed" : ""}`} aria-label={lane.title}>
      <header className="verify-lane-head">
        <span className="verify-lane-mark" aria-hidden="true"><ShieldCheck size={12} weight="fill" /></span>
        <b>{lane.title}</b>
        <span className="verify-lane-by">
          {lane.reviewerLabel ? `${lane.reviewerLabel} 在审` : "审查中"}
          {reviewerMeta ? ` · ${reviewerMeta}` : ""}
          {/* 折叠着的历史轮也得看得出「这一轮是带着附言跑的」，展开才有正文。 */}
          {lane.note ? " · 含附言" : ""}
        </span>
        <span className={`verify-lane-state ${state.className}`}>{state.label}</span>
        {time && <small className="verify-lane-time">{time}</small>}
        <span className="verify-lane-actions">
          {lane.reportAvailable && lane.report && (
            <button type="button" onClick={openReport}>
              <FileText size={11} aria-hidden="true" />审查报告
            </button>
          )}
          {hasBody && (
            <button
              type="button"
              aria-controls={bodyId}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? "展开" : "收起"}
            </button>
          )}
        </span>
      </header>
      <div className="verify-lane-body" id={bodyId} hidden={bodyHidden}>
        {lane.note && <ReviewNote text={lane.note} />}
        {children}
      </div>
      {report && (
        <ReviewReportDialog
          target={report}
          onReviewReport={setReport}
          onClose={() => setReport(null)}
        />
      )}
    </article>
  );
}
