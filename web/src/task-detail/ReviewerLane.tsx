import { useEffect, useId, useState, type ReactNode } from "react";
import { FileText, ShieldCheck } from "@phosphor-icons/react";
import { MarkdownBody, ReviewReportDialog } from "../components/MarkdownBody.tsx";
import type { ReviewFileTarget } from "../components/markdownPolicy.ts";
import { api } from "../lib/api.ts";
import { ReviewNote } from "../review/ReviewNote.tsx";
import type { ConversationReviewLane, ReviewLaneConclusion } from "./conversationReviewLanes.ts";
import type { SystemNoticeMode } from "./systemNoticeModel.ts";
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

function repairHeading(text: string): string {
  return text.includes("自动复审已停止")
    ? "自动复审已停止，等待修复后再决定是否复审"
    : "审查发现需要继续修复的问题";
}

function repairSummary(text: string): string {
  if (text.includes("不要扩大原任务边界")) return "请按审查报告修复，不要扩大原任务边界。";
  return "请按本轮审查结论完成修复，再重新确认任务已完成。";
}

export function ReviewerLane({
  taskId,
  lane,
  children,
  noticeMode = "footnote",
}: {
  taskId: string;
  lane: ConversationReviewLane;
  children: ReactNode;
  noticeMode?: SystemNoticeMode;
}) {
  const defaultCollapsed = lane.repairHandoff ? true : lane.defaultCollapsed;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
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

  // 第一轮原本是“最新轮”，第二轮出现后会变成“历史轮”；只在这条默认规则发生变化时
  // 自动折叠一次。用户随后手动展开，不会被 SSE 的普通刷新反复关回去。
  useEffect(() => setCollapsed(defaultCollapsed), [defaultCollapsed, lane.id]);

  const openReport = () => {
    const target = lane.report;
    if (!target) return;
    const url = target.kind === "inline"
      ? api.taskReviewFileUrl(taskId, target.round, "report.md")
      : api.freeReviewFileUrl(taskId, target.runId, target.round, "report.md");
    setReport({ name: "report.md", url });
  };

  if (lane.repairHandoff) {
    const handoff = lane.repairHandoff.text;
    return (
      <article className={`verify-lane verify-lane--repair notice-mode-${noticeMode}${bodyHidden ? " is-collapsed" : ""}`} aria-label={lane.title}>
        <span className="verify-repair-mark" aria-hidden="true"><ShieldCheck size={14} weight="fill" /></span>
        <div className="verify-repair-main">
          <header className="verify-repair-head">
            <b>{lane.title}未通过</b>
            <span>
              {lane.reviewerLabel ?? "审查者"}
              {reviewerModel ? ` · ${reviewerModel}` : ""}
              {lane.note ? " · 含附言" : ""}
            </span>
            {time && <time>{time}</time>}
          </header>
          <p className="verify-repair-title">
            <b>{repairHeading(handoff)}</b>
            <span> · {repairSummary(handoff)}</span>
          </p>
          <footer className="verify-repair-actions">
            <details className="verify-repair-requirements">
              <summary>查看审查要求</summary>
              <div><MarkdownBody text={handoff} /></div>
            </details>
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
                {collapsed ? "审查过程" : "收起过程"}
              </button>
            )}
            <span>已交回原任务，智能体正在修复</span>
          </footer>
          <div className="verify-lane-body" id={bodyId} hidden={bodyHidden}>
            {lane.note && <ReviewNote text={lane.note} />}
            {children}
          </div>
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

  return (
    <article className={`verify-lane notice-mode-${noticeMode}${bodyHidden ? " is-collapsed" : ""}`} aria-label={lane.title}>
      <header className="verify-lane-head">
        <span className="verify-lane-mark" aria-hidden="true"><ShieldCheck size={12} weight="fill" /></span>
        <b>{lane.title}</b>
        <span className="verify-lane-by">
          {lane.reviewerLabel ? `${lane.reviewerLabel} 在审` : "审查中"}
          {reviewerModel ? ` · ${reviewerModel}` : ""}
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
