import { useId, useState, type ReactNode } from "react";
import { FileText } from "@phosphor-icons/react";
import { ReviewReportDialog } from "../components/MarkdownBody.tsx";
import type { ReviewFileTarget } from "../components/markdownPolicy.ts";
import { ReviewNote } from "../review/ReviewNote.tsx";
import type { ReviewTarget } from "../review/reviewTarget.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import { FootnoteDot } from "./FootnoteLine.tsx";
import { laneReportUrl, laneReviewTarget } from "./reviewLaneLinks.ts";
import { laneVerdictView, reviewLaneTail } from "./turnFootnote.ts";

/**
 * 收了口的一轮审查：审查者对执行者说的话，所以跟你的话同一列（靠右）、在被审那一回合之后单独一行
 * （归属见 conversationSystemRows 的 ConversationVerdictRow）。
 *
 * - 平时只有一句结论。指到气泡（键盘走进来）才在它上方右侧浮出「审查者 · 谁审的 · 用时 · 时刻」，
 *   有报告时那一行里带一颗报告键；跟你的气泡那一行同一种做法，不占排版高度，触屏上常显在气泡里；
 * - 点气泡去右侧审查格的那一场那一轮（`onOpenRound`，认得出去哪儿才给），认不出就在气泡下面摊开
 *   那一轮的经过（`renderLane`），摊开的那一块占满正文宽度；
 * - 它是会话里最后一件事、又不是好消息时（`live`），字前一颗小圆点，跟尾注同一套；
 * - 结论之后才发生的那几句（`trailing`）贴在气泡下面，靠右。
 */
export function ReviewVerdict({
  lane,
  live = false,
  taskId,
  onOpenRound,
  renderLane,
  trailing,
}: {
  lane: ConversationReviewLane;
  live?: boolean;
  /** 打开审查报告时用（报告的地址挂在任务上）。 */
  taskId?: string;
  onOpenRound?: (target: ReviewTarget) => void;
  renderLane?: (lane: ConversationReviewLane) => ReactNode;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ReviewFileTarget | null>(null);
  const bodyId = useId();
  const view = laneVerdictView(lane);
  const tail = reviewLaneTail(lane);
  const reportUrl = lane.reportAvailable && lane.report && taskId ? laneReportUrl(taskId, lane.report) : null;
  const urgent = live && (view.tone === "bad" || view.tone === "warn");
  return (
    <div className="review-verdict" role={urgent ? "status" : undefined}>
      <div className="review-verdict-bubble">
        <header>
          <b>审查者</b>
          {tail && <span className="review-verdict-meta">{` · ${tail}`}</span>}
          {reportUrl && (
            <button type="button" aria-label="审查报告" onClick={() => setReport({ name: "report.md", url: reportUrl })}>
              <FileText size={14} aria-hidden="true" />
            </button>
          )}
        </header>
        <button
          type="button"
          className="review-verdict-text"
          aria-label={onOpenRound ? `${view.text}，在右侧审查格里打开这一轮` : undefined}
          aria-expanded={onOpenRound ? undefined : open}
          aria-controls={onOpenRound ? undefined : bodyId}
          onClick={() => (onOpenRound ? onOpenRound(laneReviewTarget(lane)) : setOpen((value) => !value))}
        >
          <FootnoteDot tone={view.tone} live={live} />
          <span data-selection-content="">{view.text}</span>
        </button>
      </div>
      {!onOpenRound && open && <LaneBody lane={lane} id={bodyId} renderLane={renderLane} />}
      {trailing}
      {report && <ReviewReportDialog target={report} onReviewReport={setReport} onClose={() => setReport(null)} />}
    </div>
  );
}

/**
 * 就地摊开的那一轮审查：（报告、）派审附言、那一轮的经过。气泡点开、「N 条记录」里被后一轮盖过的
 * 那一条（TurnReceipts）点开都是它。气泡上那一行已经有报告键，给 `taskId` 才在这里另出一颗。
 */
export function LaneBody({ lane, id, taskId, renderLane }: {
  lane: ConversationReviewLane;
  id: string;
  taskId?: string;
  renderLane?: (lane: ConversationReviewLane) => ReactNode;
}) {
  const [report, setReport] = useState<ReviewFileTarget | null>(null);
  return (
    <div className="turn-footnote-lane" id={id}>
      {lane.reportAvailable && lane.report && taskId && (
        <button
          type="button"
          className="turn-footnote-report"
          onClick={() => setReport({ name: "report.md", url: laneReportUrl(taskId, lane.report!) })}
        >
          <FileText size={12} aria-hidden="true" />审查报告
        </button>
      )}
      {lane.note && <ReviewNote text={lane.note} />}
      {renderLane?.(lane)}
      {report && <ReviewReportDialog target={report} onReviewReport={setReport} onClose={() => setReport(null)} />}
    </div>
  );
}
