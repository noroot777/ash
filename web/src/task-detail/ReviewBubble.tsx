import { useId, useState, type ReactNode } from "react";
import { FileText, ListBullets } from "@phosphor-icons/react";
import { ReviewReportDialog } from "../components/MarkdownBody.tsx";
import type { ReviewFileTarget } from "../components/markdownPolicy.ts";
import { useNow } from "../lib/useNow.ts";
import { ReviewNote } from "../review/ReviewNote.tsx";
import type { ReviewTarget } from "../review/reviewTarget.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import { FootnoteDot } from "./FootnoteLine.tsx";
import { laneReportUrl, laneReviewTarget } from "./reviewLaneLinks.ts";
import { reviewProgress, type ReviewProgress, type ReviewProgressPhase } from "./reviewProgress.ts";
import { laneVerdictView, reviewLaneTail } from "./turnFootnote.ts";
import { durationBetween, formatDuration, formatInstant } from "./utils.ts";

/**
 * 一轮审查在会话里就是这一颗气泡：审查者对执行者说的话，所以跟你的话同一列（靠右），从开始审到出结论
 * 一直在这儿。还没结论（`lane.complete` 为假，此刻怎么样由 `progress` 给，见 reviewProgress）和出了
 * 结论是同一颗气泡的两个状态——出结论时原地换字，摊开着的照旧摊开（开合状态就在这一个组件里）。
 *
 * - 进行中：气泡里一颗点（真的在往前走才动）+ 审查者最新说完的一句（或者它此刻在等什么）；收着时下面
 *   靠右一行小灰字是正在跑的那一步和这一轮的用时，停了没结论的那种是这一轮最后那句尾注（原因、
 *   「继续本轮审查」）。点气泡在下面就地摊开这一轮的经过（附言在最前），摊开后下面那一行不再出现；
 * - 出了结论：平时只有一句结论。点气泡去右侧审查格的那一场那一轮（`onOpenRound`，认得出去哪儿才给），
 *   认不出就在气泡下面摊开那一轮的经过（`renderLane`）；审查格里没有经过，所以点气泡去审查格的那种，
 *   浮出的那一行里另有一颗经过键。它是会话里最后一件事、又不是好消息时（`live`），字前一颗小圆点；
 *   结论之后才发生的那几句（`trailing`）贴在气泡下面，靠右；
 * - 两种状态都是指到气泡（键盘走进来）才在它上方右侧浮出「审查者 · …」那一行，有报告时那一行里带一颗
 *   报告键；跟你的气泡那一行同一种做法，不占排版高度，触屏上常显在气泡里。
 */
export function ReviewBubble({
  lane,
  progress,
  live = false,
  taskId,
  onOpenRound,
  renderLane,
  trailing,
}: {
  lane: ConversationReviewLane;
  /** 还没出结论的那一轮此刻怎么样。出了结论的不看它。 */
  progress?: ReviewProgress;
  live?: boolean;
  /** 打开审查报告时用（报告的地址挂在任务上）。 */
  taskId?: string;
  onOpenRound?: (target: ReviewTarget) => void;
  renderLane?: (lane: ConversationReviewLane) => ReactNode;
  /** 出了结论：结论之后的那几句；还没结论：停了的那一轮最后那句尾注（收着时才出）。 */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ReviewFileTarget | null>(null);
  const bodyId = useId();
  const pending = !lane.complete;
  const view = laneVerdictView(lane);
  // 没给此刻怎么样的（单摆一轮、拿不到任务的地方）按「还在审」画，跟原来那张卡的「进行中」一样。
  const state = pending ? progress ?? reviewProgress(lane, { status: "running" }, true) : null;
  const text = state ? state.text : view.text;
  // 字真的换了才放一下换字的过渡：头一回画出来的那一句不动。
  const [firstText] = useState(text);
  const swapped = text !== firstText;
  const reportUrl = lane.reportAvailable && lane.report && taskId ? laneReportUrl(taskId, lane.report) : null;
  const traceToggle = !pending && !!onOpenRound && !!renderLane && laneHasTrace(lane);
  // 进行中那一轮摊得开的：审查者说过话，或者带着附言（一句话没说的轮次摊开至少还看得见附言）。
  const hasBody = laneHasTrace(lane) || !!lane.note;
  const urgent = !pending && live && (view.tone === "bad" || view.tone === "warn");
  const toggle = () => setOpen((value) => !value);
  const wordsClass = [state?.said ? "review-progress-say" : "", swapped ? "is-fresh" : ""].filter(Boolean).join(" ");
  const words = <span key={text} className={wordsClass || undefined} data-selection-content="">{text}</span>;
  const tail = pending ? pendingTail(lane) : reviewLaneTail(lane);
  return (
    <div className={`review-verdict${pending ? " is-pending" : ""}`} role={urgent ? "status" : undefined}>
      <div className="review-verdict-bubble">
        <header>
          <b>审查者</b>
          {tail && <span className="review-verdict-meta">{` · ${tail}`}</span>}
          {reportUrl && (
            <button type="button" aria-label="审查报告" onClick={() => setReport({ name: "report.md", url: reportUrl })}>
              <FileText size={14} aria-hidden="true" />
            </button>
          )}
          {traceToggle && (
            <button type="button" aria-label="这一轮的经过" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
              <ListBullets size={14} aria-hidden="true" />
            </button>
          )}
        </header>
        {state ? (
          hasBody ? (
            <button
              type="button"
              className="review-verdict-text"
              aria-label={`${lane.title}：${text}`}
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={toggle}
            >
              <ProgressDot phase={state.phase} />{words}
            </button>
          ) : (
            // 没有可摊的：不是一颗点了没反应的键；仍然走得进来，指到才出的那一行键盘也看得见。
            <p className="review-verdict-text is-static" tabIndex={0}>
              <ProgressDot phase={state.phase} />{words}
            </p>
          )
        ) : (
          <button
            type="button"
            className="review-verdict-text"
            aria-label={onOpenRound ? `${view.text}，在右侧审查格里打开这一轮` : undefined}
            aria-expanded={onOpenRound ? undefined : open}
            aria-controls={onOpenRound ? undefined : bodyId}
            onClick={() => (onOpenRound ? onOpenRound(laneReviewTarget(lane)) : toggle())}
          >
            <FootnoteDot tone={view.tone} live={live} />{words}
          </button>
        )}
      </div>
      {open && (pending ? hasBody : !onOpenRound || traceToggle) && <LaneBody lane={lane} id={bodyId} renderLane={renderLane} />}
      {state && !open && (state.phase === "stopped" ? trailing : <ProgressLine lane={lane} progress={state} />)}
      {!state && trailing}
      {report && <ReviewReportDialog target={report} onReviewReport={setReport} onClose={() => setReport(null)} />}
    </div>
  );
}

/** 进行中那一轮浮出的那一行：谁在审、模型、智能水平、第几轮、什么时候开始的；带附言的看得出来。 */
function pendingTail(lane: ConversationReviewLane): string {
  const model = lane.reviewerModel && !lane.reviewerLabel?.includes(lane.reviewerModel) ? lane.reviewerModel : null;
  return [lane.reviewerLabel, model, lane.reviewerEffort, lane.title, formatInstant(lane.startedAt), lane.note ? "含附言" : null]
    .filter(Boolean)
    .join(" · ");
}

// 跟侧栏行首那颗同一套记号（task-status-dot.css）：在跑的会动；等你（答复、续跑）静止的琥珀；
// 等一件还没轮到的事（排队、哨兵）一圈灰；卡在上游红环；停了就没有点。
const DOT: Partial<Record<ReviewProgressPhase, string>> = {
  running: "run",
  stalled: "stalled",
  queued: "queue",
  question: "wait",
  monitor: "queue",
  checkpoint: "wait",
};

function ProgressDot({ phase }: { phase: ReviewProgressPhase }) {
  const mark = DOT[phase];
  if (!mark) return null;
  return <span className={`workspace-status-dot workspace-status-dot--${mark} review-progress-dot`} aria-hidden="true" />;
}

/** 收着时气泡下面那一行：正在跑的那一步 + 这一轮的用时（在往前走时走秒）。 */
function ProgressLine({ lane, progress }: { lane: ConversationReviewLane; progress: ReviewProgress }) {
  const moving = progress.phase === "running";
  const now = useNow(moving);
  const start = lane.startedAt ? Date.parse(lane.startedAt) : Number.NaN;
  const elapsed = moving
    ? (Number.isFinite(start) ? formatDuration(now - start) : null)
    : durationBetween(lane.startedAt, lane.endedAt);
  if (!progress.step && !elapsed) return null;
  return (
    <p className="review-progress-now">
      {progress.step && <span className="review-progress-step">{progress.step}</span>}
      {elapsed && <time>{elapsed}</time>}
    </p>
  );
}

/** 这一轮有没有经过可摊：审查者一句话没说的轮次（起就失败）只有结论，不给经过键。 */
export function laneHasTrace(lane: ConversationReviewLane): boolean {
  return lane.items.length > 0;
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
