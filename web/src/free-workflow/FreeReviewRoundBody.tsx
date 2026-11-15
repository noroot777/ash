// 自由审查一轮点开后的正文：起止和检查类型一行、派审附言、报告、证据截图；有驳回的那一轮，报告之后
// 依次是驳回、辩论、裁定（FreeReviewDisputeRecord）。右侧「审查」格里就地铺开（ReviewInlineReport），
// 读报告全文、「工作流」格点一轮审查，都是从左边推出来的那一屉（LeftDrawer）。
import type { FreeReviewRound, FreeReviewRun } from "@ash/shared";
import { Warning } from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import type { LeftDrawerEntry } from "../components/LeftDrawer.tsx";
import { ReviewReportBody, ReviewReportFileView } from "../components/MarkdownBody.tsx";
import { reportFileResolver } from "../components/markdownPolicy.ts";
import { InspNote } from "../inspector/parts.tsx";
import { api } from "../lib/api.ts";
import { ReviewInlineReport } from "../review/ReviewInlineReport.tsx";
import { ReviewNote } from "../review/ReviewNote.tsx";
import { ReviewScreenshotStrip } from "../review/ReviewScreenshotStrip.tsx";
import { FreeReviewDisputeRecord, type DisputeRecordHost } from "./FreeReviewDisputeRecord.tsx";
import {
  checkModeText, missingReportText, noVerdictSaidText, recurrenceText, reviewRoundLabel, timeRange,
} from "./freeReviewRounds.ts";
import { useFreeWorkflowSnapshot } from "./useFreeWorkflowState.ts";

const hasScreenshots = (round: FreeReviewRound) => round.screenshots.length > 0 || !!round.expiredScreenshots?.length;

function Screenshots({ taskId, run, round }: { taskId: string; run: FreeReviewRun; round: FreeReviewRound }) {
  if (!hasScreenshots(round)) return null;
  return (
    <ReviewScreenshotStrip expired={round.expiredScreenshots?.length} items={round.screenshots.map((name) => ({
      key: name,
      name,
      src: api.freeReviewFileUrl(taskId, run.id, round.round, name),
      label: `第 ${round.round} 轮 · ${name}`,
    }))} />
  );
}

/** 报告这一份：就地和左侧抽屉里是同一份。截图另放（抽屉里贴底边）。 */
export function FreeReviewReportContent({ taskId, run, round }: { taskId: string; run: FreeReviewRun; round: FreeReviewRound }) {
  const recurrence = recurrenceText(round);
  return (
    <>
      {run.note && <ReviewNote text={run.note} />}
      {recurrence && <InspNote tone="warn" icon={<Warning weight="fill" />}>{recurrence}</InspNote>}
      {round.reportMarkdown
        ? <ReviewReportBody
            text={round.reportMarkdown}
            reportKey={`${run.id}:${round.round}`}
            conclusion={round.conclusion}
            // 文档根归属（相对路径 → 证据目录；绝对路径 → 被审任务工作目录）一处定
            // 清楚，判据见 markdownPolicy 的 reportFileResolver。
            resolveFile={reportFileResolver(
              (name) => api.freeReviewFileUrl(taskId, run.id, round.round, name),
              taskId,
            )}
          />
        : <p className="insp-faint">{missingReportText(round)}</p>}
      {/* 是什么错只有执行器自己说得出：没出结论的那一轮把它的原话摆出来 —— 跟报告写没写无关，
          先写了报告再断掉的那一轮同样要知道断在哪儿。 */}
      {round.status !== "reviewing" && noVerdictSaidText(round.noVerdict) && (
        <p className="insp-faint review-round-said">{noVerdictSaidText(round.noVerdict)}</p>
      )}
    </>
  );
}

function roundTitle(run: FreeReviewRun, round: FreeReviewRound): string {
  return run.target?.kind === "accepted_merge" ? `合并结果审查 · ${run.target.mergeCommit.slice(0, 8)}` : `第 ${round.round} 轮审查`;
}

function roundSubtitle(run: FreeReviewRun, round: FreeReviewRound): string {
  return `${reviewRoundLabel(round)} · ${run.reviewerName} · ${checkModeText(run)}`;
}

type RoundFallback = { run: FreeReviewRun; round: FreeReviewRound } | null;

/** 抽屉里那一份跟着长：这个任务页上已经有人在拉审查状态（还在审的那一轮报告会落下来）。 */
function useLiveRound(taskId: string, runId: string, round: number, fallback: RoundFallback): RoundFallback {
  const live = useFreeWorkflowSnapshot(taskId);
  const run = live?.reviews.find((item) => item.id === runId);
  const hit = run?.rounds.find((item) => item.round === round);
  return run && hit ? { run, round: hit } : fallback;
}

function LiveTitle({ taskId, runId, round, fallback }: { taskId: string; runId: string; round: number; fallback: RoundFallback }) {
  const live = useLiveRound(taskId, runId, round, fallback);
  return <>{live ? `${roundTitle(live.run, live.round)} · ${roundSubtitle(live.run, live.round)}` : `第 ${round} 轮审查`}</>;
}

function LiveReport({ taskId, runId, round, fallback }: { taskId: string; runId: string; round: number; fallback: RoundFallback }) {
  const live = useLiveRound(taskId, runId, round, fallback);
  // 手上没有这一轮的记录（只有报告的地址）：照报告文件本身读。
  if (!live) return <ReviewReportFileView target={{ name: "report.md", url: api.freeReviewFileUrl(taskId, runId, round, "report.md") }} />;
  return <div className="review-round-body"><FreeReviewReportContent taskId={taskId} run={live.run} round={live.round} /></div>;
}

function LiveShots({ taskId, runId, round, fallback }: { taskId: string; runId: string; round: number; fallback: RoundFallback }) {
  const live = useLiveRound(taskId, runId, round, fallback);
  return live ? <Screenshots taskId={taskId} run={live.run} round={live.round} /> : null;
}

/** 一轮自由审查的报告全文在左侧抽屉里的那一屉。`fallback` = 开的人手上那一份（没有就按地址读）。 */
export function freeReportEntry(taskId: string, runId: string, round: number, fallback: RoundFallback): LeftDrawerEntry {
  const props = { taskId, runId, round, fallback };
  return {
    key: `report:${taskId}:${runId}:${round}`,
    kind: "审查报告",
    title: <LiveTitle {...props} />,
    ariaLabel: `审查报告：${fallback ? roundTitle(fallback.run, fallback.round) : `第 ${round} 轮审查`}`,
    closeLabel: "关闭审查报告",
    body: <ImagePreviewGroup isolated><LiveReport {...props} /></ImagePreviewGroup>,
    // 截图贴底边：正文单独滚动，截图再多也不挤掉报告（没有截图时这一段是空的，不占地方）。
    footer: <ImagePreviewGroup isolated><LiveShots {...props} /></ImagePreviewGroup>,
  };
}

/** 「审查」格里就地铺开的那一份：报告，之后是驳回、辩论、裁定。 */
export function FreeReviewRoundBody({ taskId, run, round, dispute }: {
  taskId: string;
  run: FreeReviewRun;
  round: FreeReviewRound;
  /** 驳回、辩论、裁定那几段要的宿主信息（任务此刻的状态、去新任务）。不给就不摆那几段。 */
  dispute?: DisputeRecordHost;
}) {
  return (
    <ReviewInlineReport
      meta={`${checkModeText(run)} · ${timeRange(round.startedAt, round.endedAt)}`}
      entry={freeReportEntry(taskId, run.id, round.round, { run, round })}
      screenshots={hasScreenshots(round) ? <Screenshots taskId={taskId} run={run} round={round} /> : null}
      after={round.dispute && dispute ? <FreeReviewDisputeRecord run={run} round={round} host={dispute} /> : null}
    >
      <FreeReviewReportContent taskId={taskId} run={run} round={round} />
    </ReviewInlineReport>
  );
}
