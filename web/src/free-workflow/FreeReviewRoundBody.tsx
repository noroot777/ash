// 自由审查一轮点开后的正文：起止和检查类型一行、派审附言、报告、驳回与辩论的回放、证据截图。
// 右侧「审查」格里就地铺开（ReviewInlineReport）；「工作流」格点一轮审查还是弹抽屉。
import type { RefObject } from "react";
import type { FreeReviewRound, FreeReviewRun } from "@ash/shared";
import { Warning } from "@phosphor-icons/react";
import { FoldedProse } from "../components/FoldedProse.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody, ReviewReportBody } from "../components/MarkdownBody.tsx";
import { reportFileResolver } from "../components/markdownPolicy.ts";
import { InspNote } from "../inspector/parts.tsx";
import { api } from "../lib/api.ts";
import { ReviewEvidenceDrawer } from "../review/ReviewEvidenceDrawer.tsx";
import { ReviewInlineReport } from "../review/ReviewInlineReport.tsx";
import { ReviewNote } from "../review/ReviewNote.tsx";
import { ReviewScreenshotStrip } from "../review/ReviewScreenshotStrip.tsx";
import { FreeReviewDebateTranscript } from "./FreeReviewDebateTranscript.tsx";
import { DISPUTE_PROSE_LABELS } from "./disputeCopy.ts";
import { checkModeText, disputeStateText, missingReportText, recurrenceText, reviewRoundLabel, timeRange } from "./freeReviewRounds.ts";

function Screenshots({ taskId, run, round }: { taskId: string; run: FreeReviewRun; round: FreeReviewRound }) {
  if (!round.screenshots.length) return null;
  return (
    <ReviewScreenshotStrip items={round.screenshots.map((name) => ({
      key: name,
      name,
      src: api.freeReviewFileUrl(taskId, run.id, round.round, name),
      label: `第 ${round.round} 轮 · ${name}`,
    }))} />
  );
}

/** 报告、驳回回放：就地和抽屉里是同一份。截图另放（抽屉里贴底边）。 */
export function FreeReviewRoundContent({ taskId, run, round }: { taskId: string; run: FreeReviewRun; round: FreeReviewRound }) {
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
      {/* 驳回与辩论跟报告长在同一轮上，读结论的人必须在同一个地方读到「执行者不认这条、
          理由是什么」。这里只回放，裁定入口在审查格上面那张卡上（一个动作一个入口）。 */}
      {round.dispute && (
        <div className="review-round-dispute">
          <b>{disputeStateText(round)}</b>
          {/* 和驳回卡同一个读法：那一句人话摆出来，几千字依据折起来（用户 2026-10-20
              「一大篇文字都看不懂」）。老记录没有那一句，正文就默认摊开。 */}
          {round.dispute.summary && <p className="review-round-dispute__gist">{round.dispute.summary}</p>}
          {round.dispute.reason && (
            <FoldedProse label={DISPUTE_PROSE_LABELS.reason} text={round.dispute.reason} open={!round.dispute.summary} />
          )}
          {round.dispute.deferReason && (
            <FoldedProse label={DISPUTE_PROSE_LABELS.defer} text={round.dispute.deferReason} open={!round.dispute.summary} tone="defer" />
          )}
          {round.dispute.debates.map((debate, index) => (
            <FreeReviewDebateTranscript
              key={debate.id}
              debate={debate}
              ordinal={round.dispute!.debates.length > 1 ? index + 1 : null}
            />
          ))}
          {/* 裁定要点是**用户**写的那一段，跟驳回理由和发言不是一回事，所以单独摆在最后
              （时间顺序也在最后）。裁定完那张卡就收了，不在这儿留一份的话，用户自己写的
              话下次打开就只剩时间线里那 60 字摘要。 */}
          {round.dispute.resolutionNote && (
            <div className="review-round-dispute__note">
              <b>你裁定时写的要点</b>
              <MarkdownBody text={round.dispute.resolutionNote} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function drawerTitle(run: FreeReviewRun, round: FreeReviewRound): string {
  return run.target?.kind === "accepted_merge" ? `合并结果审查 · ${run.target.mergeCommit.slice(0, 8)}` : `第 ${round.round} 轮审查`;
}

function drawerSubtitle(run: FreeReviewRun, round: FreeReviewRound): string {
  return `${reviewRoundLabel(round)} · ${run.reviewerName} · ${checkModeText(run)}`;
}

/** 抽屉里的那一份：标题、副标题、正文，截图贴底边。 */
export function FreeReviewRoundDrawer({ taskId, run, round, anchorRef, keepOpenRef, onClose }: {
  taskId: string;
  run: FreeReviewRun;
  round: FreeReviewRound;
  anchorRef: RefObject<HTMLElement | null>;
  keepOpenRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <ImagePreviewGroup isolated>
      <ReviewEvidenceDrawer
        anchorRef={anchorRef}
        keepOpenRef={keepOpenRef}
        title={drawerTitle(run, round)}
        subtitle={drawerSubtitle(run, round)}
        onClose={onClose}
        footer={round.screenshots.length ? <Screenshots taskId={taskId} run={run} round={round} /> : undefined}
      >
        <div className="review-round-body"><FreeReviewRoundContent taskId={taskId} run={run} round={round} /></div>
      </ReviewEvidenceDrawer>
    </ImagePreviewGroup>
  );
}

/** 「审查」格里就地铺开的那一份。 */
export function FreeReviewRoundBody({ taskId, run, round, anchorRef }: {
  taskId: string;
  run: FreeReviewRun;
  round: FreeReviewRound;
  /** 抽屉贴着谁的左边缘弹（右侧面板）。 */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  return (
    <ReviewInlineReport
      meta={`${checkModeText(run)} · ${timeRange(round.startedAt, round.endedAt)}`}
      title={drawerTitle(run, round)}
      subtitle={drawerSubtitle(run, round)}
      anchorRef={anchorRef}
      screenshots={round.screenshots.length ? <Screenshots taskId={taskId} run={run} round={round} /> : null}
    >
      <FreeReviewRoundContent taskId={taskId} run={run} round={round} />
    </ReviewInlineReport>
  );
}
