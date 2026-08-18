import { useEffect, useId, useState, type ReactNode } from "react";
import { FileText, ShieldCheck } from "@phosphor-icons/react";
import { ReviewReportDialog } from "../components/MarkdownBody.tsx";
import type { ReviewFileTarget } from "../components/markdownPolicy.ts";
import { api } from "../lib/api.ts";
import type { ConversationReviewLane, ReviewLaneConclusion } from "./conversationReviewLanes.ts";
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

export function ReviewerLane({
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
  const reviewerModel = lane.reviewerModel && !lane.reviewerLabel?.includes(lane.reviewerModel)
    ? lane.reviewerModel
    : null;

  // 第一轮原本是“最新轮”，第二轮出现后会变成“历史轮”；只在这条默认规则发生变化时
  // 自动折叠一次。用户随后手动展开，不会被 SSE 的普通刷新反复关回去。
  useEffect(() => setCollapsed(lane.defaultCollapsed), [lane.defaultCollapsed, lane.id]);

  const openReport = () => {
    setReport({ name: "report.md", url: api.taskReviewFileUrl(taskId, lane.round, "report.md") });
  };

  return (
    <article className={`verify-lane${collapsed ? " is-collapsed" : ""}`} aria-label={`第 ${lane.round} 轮验证`}>
      <header className="verify-lane-head">
        <span className="verify-lane-mark" aria-hidden="true"><ShieldCheck size={12} weight="fill" /></span>
        <b>第 {lane.round} 轮验证</b>
        <span className="verify-lane-by">
          {lane.reviewerLabel ? `${lane.reviewerLabel} 在审` : "审查中"}
          {reviewerModel ? ` · ${reviewerModel}` : ""}
        </span>
        <span className={`verify-lane-state ${state.className}`}>{state.label}</span>
        {time && <small className="verify-lane-time">{time}</small>}
        <span className="verify-lane-actions">
          {lane.reportAvailable && (
            <button type="button" onClick={openReport}>
              <FileText size={11} aria-hidden="true" />审查报告
            </button>
          )}
          <button
            type="button"
            aria-controls={bodyId}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "展开" : "收起"}
          </button>
        </span>
      </header>
      <div className="verify-lane-body" id={bodyId} hidden={collapsed}>{children}</div>
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
