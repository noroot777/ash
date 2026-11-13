import { Fragment, useId, useState, type ReactNode } from "react";
import { FileText } from "@phosphor-icons/react";
import { ReviewReportDialog } from "../components/MarkdownBody.tsx";
import type { ReviewFileTarget } from "../components/markdownPolicy.ts";
import { ReviewNote } from "../review/ReviewNote.tsx";
import type { ReviewTarget } from "../review/reviewTarget.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import { DeleteMessageButton, type DeletableItem } from "./MessageDelete.tsx";
import { laneReportUrl, laneReviewTarget } from "./reviewLaneLinks.ts";
import type { NoticeView } from "./timelineNoticeCopy.ts";
import { footnotePartTail, type FootnotePart, type TurnFootnote } from "./turnFootnote.ts";

/** 句子里的分支名、标签名换成等宽字（不垫底色）。 */
function SentenceText({ view }: { view: Pick<NoticeView, "text" | "mono"> }) {
  const at = view.mono ? view.text.indexOf(view.mono) : -1;
  if (!view.mono || at < 0) return <>{view.text}</>;
  return (
    <>
      {view.text.slice(0, at)}
      <code className="turn-footnote-mono">{view.mono}</code>
      {view.text.slice(at + view.mono.length)}
    </>
  );
}

/** 坏消息、又还是现在的事：字前面一颗小圆点（红 = 没办成，琥珀 = 要你知道或拍板）。 */
function Dot({ part, live }: { part: FootnotePart; live: boolean }) {
  if (!live || (part.view.tone !== "bad" && part.view.tone !== "warn")) return null;
  return <span className={`turn-footnote-dot is-${part.view.tone}`} aria-hidden="true" />;
}

/**
 * 回合的尾注：回合正文下面、回合尾那排操作上面的一句小灰字（模型与归属见 turnFootnote /
 * conversationSystemRows）。没有图标、没有底色，几件事并成一句、中间一个间隔号。
 *
 * - 指到这一句（键盘走进来）才出最近那一句的时刻（谁审的 · 用时 · 时刻），触屏上常显；
 * - 审查结论那半句去右侧审查格的那一场那一轮（`reviewOpener` 认得出去哪儿才给），认不出就在
 *   这句下面摊开那一轮的经过（`renderLane`）；有原文细节的那半句点了就地摊开原文；
 * - 挂在某半句后面的键（「去裁定」）由 `actionFor` 给，紧跟在那半句后面，时刻排在键后面；
 * - 删除不在这里：每一句同时也是「N 条记录」里的一条，删除在那儿。只有没有记录可去的地方
 *   （团队时间线）才给 `deletable`。
 */
export function FootnoteLine({
  footnote,
  taskId,
  actionFor,
  reviewOpener,
  renderLane,
  standalone = false,
  deletable,
}: {
  footnote: TurnFootnote;
  /** 摊开审查报告时用（报告的地址挂在任务上）。 */
  taskId?: string;
  actionFor?: (part: FootnotePart) => ReactNode;
  reviewOpener?: (lane: ConversationReviewLane) => ((target: ReviewTarget) => void) | undefined;
  renderLane?: (lane: ConversationReviewLane) => ReactNode;
  /** 前面没有回合可挂、在原处单独占一行的那一句。 */
  standalone?: boolean;
  deletable?: DeletableItem;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [report, setReport] = useState<ReviewFileTarget | null>(null);
  const bodyId = useId();
  const { parts, live } = footnote;
  if (!parts.length) return null;
  const tail = footnotePartTail(parts.at(-1)!);
  const opened = parts.find((part) => part.id === open) ?? null;
  const toggle = (id: string) => setOpen((value) => value === id ? null : id);

  const sentence = (part: FootnotePart) => {
    const text = <span className="turn-footnote-text" data-selection-content=""><SentenceText view={part.view} /></span>;
    if (part.kind === "review") {
      const go = reviewOpener?.(part.lane);
      return (
        <button
          type="button"
          className="turn-footnote-part"
          aria-label={go ? `${part.view.text}，在右侧审查格里打开这一轮` : undefined}
          aria-expanded={go ? undefined : open === part.id}
          aria-controls={go ? undefined : bodyId}
          onClick={() => (go ? go(laneReviewTarget(part.lane)) : toggle(part.id))}
        >
          <Dot part={part} live={live} />{text}
        </button>
      );
    }
    // 验收那句只是报个结果，不能点（分支名已经写在字里，原文在「N 条记录」里点开）。
    if (part.view.detail && part.view.topic !== "accept") {
      return (
        <button
          type="button"
          className="turn-footnote-part"
          aria-expanded={open === part.id}
          aria-controls={bodyId}
          onClick={() => toggle(part.id)}
        >
          <Dot part={part} live={live} />{text}
        </button>
      );
    }
    return <span className="turn-footnote-part is-static"><Dot part={part} live={live} />{text}</span>;
  };

  const lane = opened?.kind === "review" ? opened.lane : null;
  return (
    <div
      className={`turn-footnote${standalone ? " is-standalone" : ""}`}
      role={live && parts.some((part) => part.view.tone === "bad" || part.view.tone === "warn") ? "status" : undefined}
    >
      <p className="turn-footnote-line">
        {parts.map((part, index) => (
          <Fragment key={part.id}>
            {index > 0 && <span className="turn-footnote-sep" aria-hidden="true">·</span>}
            {sentence(part)}
            {actionFor?.(part)}
          </Fragment>
        ))}
        {tail && <time className="turn-footnote-tail">{tail}</time>}
        {deletable && <DeleteMessageButton item={deletable} />}
      </p>
      {opened && opened.kind !== "review" && opened.view.detail && opened.view.topic !== "accept" && (
        <p className="turn-footnote-detail" id={bodyId}>{opened.view.detail}</p>
      )}
      {lane && (
        <div className="turn-footnote-lane" id={bodyId}>
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
        </div>
      )}
      {report && <ReviewReportDialog target={report} onReviewReport={setReport} onClose={() => setReport(null)} />}
    </div>
  );
}
