import { useId, useState, type ReactNode } from "react";
import type { FreeReviewDebate, FreeReviewRun, TaskListItem } from "@ash/shared";
import { FileText, ListBullets } from "@phosphor-icons/react";
import { useLeftDrawer } from "../components/LeftDrawer.tsx";
import { DebateOverview } from "../free-workflow/DebateOverview.tsx";
import { debateDrawerEntry, type DebateDrawerSource } from "../free-workflow/DebateRecord.tsx";
import { DEBATE_SIDE_LABEL, debateBubbleText, debateNowText, debateTotalSegments, type DebateBubbleState } from "../free-workflow/debateModel.ts";
import { useRulingQuote } from "../free-workflow/disputeRulingStore.ts";
import type { ReviewTarget } from "../review/reviewTarget.ts";
import { BubbleKey, BubbleShell } from "./BubbleShell.tsx";
import type { ConversationDebateRow } from "./conversationDebateRows.ts";
import { durationBetween, formatInstant } from "./utils.ts";

function meta(row: ConversationDebateRow, debate: FreeReviewDebate | null): string {
  const parts = [`${DEBATE_SIDE_LABEL.reviewer}和${DEBATE_SIDE_LABEL.executor}`];
  if (debate) {
    parts.push(debate.status === "running"
      ? `共 ${debateTotalSegments(debate)} 段`
      : `${debate.turns.filter((turn) => turn.status === "done").length} 段`);
  }
  if (row.ordinal) parts.push(`第 ${row.ordinal} 次`);
  const took = durationBetween(row.startedAt, debate?.status === "running" ? null : row.endedAt);
  if (took && debate?.status !== "running") parts.push(took);
  const at = formatInstant(row.startedAt);
  if (at) parts.push(at);
  return parts.join(" · ");
}

/**
 * 一整场辩论在会话里的那一颗气泡：靠右、一圈细边，跟审查者那颗是同一副骨架（BubbleShell），点法也照它。
 * 位置照旧：在驳回那一回合后面，一场辩论一颗（同一条驳回辩过多次的各一颗）。
 *
 * 写什么见 `debateBubbleText`：辩论中写刚说完那一段的一句话（最多两行，新的一段说完就原地换字，
 * 气泡不往下长），下面靠右一行小灰字是此刻谁在说第几段；辩完还等裁定写审查者收尾的立场和那一句
 * （正文的字色——用户据以裁定的就是它）；裁完以后、历史上的缩成一行小灰字；中途断了如实写断在哪儿。
 *
 * 点法：
 * - 辩论中：点气泡 = 在下面就地摊开概览；浮出的那一行只有文档键；
 * - 辩完之后：点气泡 = 右侧「审查」格里打开那一场那一轮，停在它的辩论那一段（`onOpenRound`，认不出
 *   去哪儿、没有审查格时不给，退回就地摊开——同审查气泡那条退路）；
 * - 浮出那一行右端两颗图标键：文档 = 左侧抽屉读完整记录；列表 = 在气泡下面就地摊开概览。
 *
 * 配不到落盘记录（只读视图、快照还没跟上）时，照原来的兜底把原始那几行摆出来，宁可啰嗦也不凭空少一段。
 */
export function DebateBubble({ row, fallback, task, reviews, awaiting, onOpenRound }: {
  row: ConversationDebateRow;
  fallback: ReactNode;
  task: Pick<TaskListItem, "id">;
  reviews: readonly FreeReviewRun[] | null | undefined;
  /** 这场辩论辩的就是此刻等裁定的那一条驳回。 */
  awaiting: boolean;
  onOpenRound?: (target: ReviewTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const drawer = useLeftDrawer();
  const candidate = row.candidate;
  const debate = candidate?.debate ?? null;
  // 「用这段作要点」跟回复框顶上那一行同生共死（那一行在、能按、引的就是它那一条）。
  const quote = useRulingQuote(task.id, candidate && { runId: candidate.runId, round: candidate.round });
  const toggle = () => setOpen((value) => !value);
  const title = `第 ${row.round ?? "?"} 轮审查意见的辩论`;
  const state: DebateBubbleState = debate?.status === "running" ? "live"
    : debate?.status === "failed" ? "failed" : awaiting ? "awaiting" : "settled";
  const said = debate ? debateBubbleText(debate, state) : { lead: null, text: title };
  // 新的一段说完就原地换字：真换了才放一下换字的过渡（同审查气泡）。
  const [shown, setShown] = useState(said.text);
  const [swapped, setSwapped] = useState(false);
  if (said.text !== shown) {
    setShown(said.text);
    setSwapped(true);
  }
  if (!candidate || !debate) {
    return (
      <BubbleShell className="debate-bubble is-settled" name="辩论" meta={meta(row, null)}
        below={open && <div className="turn-footnote-lane" id={bodyId}>{fallback}</div>}>
        <button type="button" className="review-verdict-text" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>{title}</button>
      </BubbleShell>
    );
  }
  const live = state === "live";
  const target = { runId: candidate.runId, round: candidate.round };
  const source = (seq?: number): DebateDrawerSource => ({
    task, target, debateId: debate.id, ordinal: row.ordinal, seq, reviews,
  });
  const entryKey = debateDrawerEntry(source()).key;
  const openRecord = (seq?: number) => drawer?.open(debateDrawerEntry(source(seq)));
  // 辩完之后点气泡去审查格那一轮的辩论那一段；辩论中、认不出去哪儿时就地摊开。
  const goRound = !live && onOpenRound
    ? () => onOpenRound({ source: "free", runId: candidate.runId, round: candidate.round, debateId: debate.id })
    : null;
  return (
    <BubbleShell
      className={`debate-bubble is-${state}${live ? " is-pending" : ""}`}
      name="辩论"
      meta={meta(row, debate)}
      keys={<>
        {drawer && (
          <BubbleKey label="辩论的完整记录" pressed={drawer.activeKey === entryKey}
            onClick={() => (drawer.activeKey === entryKey ? drawer.close() : openRecord())}>
            <FileText size={14} aria-hidden="true" />
          </BubbleKey>
        )}
        {!live && <BubbleKey label="每段一句" expanded={open} controls={bodyId} onClick={toggle}><ListBullets size={14} aria-hidden="true" /></BubbleKey>}
      </>}
      below={<>
        {open && (
          <div className="turn-footnote-lane debate-bubble-lane" id={bodyId}>
            <DebateOverview
              debate={debate}
              onOpen={drawer ? openRecord : undefined}
              onQuote={quote}
            />
          </div>
        )}
        {live && !open && <p className="review-progress-now"><span className="review-progress-step">{debateNowText(debate)}</span></p>}
      </>}
    >
      <button
        type="button"
        className="review-verdict-text"
        aria-label={`${title}：${said.lead ? `${said.lead}，` : ""}${said.text}${goRound ? "，在右侧审查格里打开这一轮的辩论" : ""}`}
        aria-expanded={goRound ? undefined : open}
        aria-controls={goRound ? undefined : bodyId}
        onClick={() => (goRound ? goRound() : toggle())}
      >
        {live && <span className="workspace-status-dot workspace-status-dot--run review-progress-dot" aria-hidden="true" />}
        <span key={said.text} className={`debate-bubble-say${swapped ? " is-fresh" : ""}`} data-selection-content="">
          {said.lead && <b>{said.lead}</b>}{said.text}
        </span>
      </button>
    </BubbleShell>
  );
}
