import type { FreeReviewRound, FreeReviewRun, TaskListItem } from "@navi/shared";
import { ArrowSquareOut, ArrowsOutSimple } from "@phosphor-icons/react";
import { FoldedProse } from "../components/FoldedProse.tsx";
import { useLeftDrawer } from "../components/LeftDrawer.tsx";
import { InspTool } from "../inspector/parts.tsx";
import { DebateOverview } from "./DebateOverview.tsx";
import { debateDrawerEntry, type DebateDrawerSource } from "./DebateRecord.tsx";
import { debateSpeaking, debateTotalSegments } from "./debateModel.ts";
import { DISPUTE_PROSE_LABELS, rulingNoteLabel, rulingText } from "./disputeCopy.ts";
import { disputeTarget } from "./disputeRuling.ts";
import { useRulingQuote } from "./disputeRulingStore.ts";
import { disputeWho } from "./freeReviewRounds.ts";

export type DisputeRecordHost = {
  task: Pick<TaskListItem, "id">;
  reviews: readonly FreeReviewRun[] | null | undefined;
  onOpenTask?: (taskId: string) => void;
};

/**
 * 审查格里有驳回的那一轮，报告之后依次是：
 * - 驳回：执行者那一句话；两段依据各自折着、标着字数（老驳回没有那一句，依据默认摊开——那是用户唯一能
 *   读到的东西，折起来就成了「什么都没有」）；
 * - 辩论（辩过才有，辩过多次按次序各一段）：跟会话里就地摊开的是同一份概览，右上一颗展开键 = 左侧
 *   抽屉读完整记录；辩论中这里跟着长；
 * - 裁定（裁完才有）：一句结果——哪一档、有没有附要点（附了就折着能读）、转走的链到新任务。
 *
 * 段和段之间只有一条细线，不套框。这里**没有任何裁定的按钮**：裁定在回复框顶上那一行（一个动作一个
 * 入口）；这里只有「用这段作要点」，它落进的也是那一行。
 */
export function FreeReviewDisputeRecord({ run, round, host }: { run: FreeReviewRun; round: FreeReviewRound; host: DisputeRecordHost }) {
  const drawer = useLeftDrawer();
  const dispute = round.dispute;
  const target = disputeTarget(run, round);
  const quote = useRulingQuote(host.task.id, target);
  if (!dispute) return null;
  const ruling = rulingText(dispute);
  const multiple = dispute.debates.length > 1;
  return (
    <div className="dispute-record">
      <section className="dispute-part" aria-label="驳回">
        <header><b>{disputeWho(round)}</b></header>
        {dispute.summary && <p className="dispute-part-gist">{dispute.summary}</p>}
        {dispute.reason && <FoldedProse label={DISPUTE_PROSE_LABELS.reason} text={dispute.reason} open={!dispute.summary} />}
        {dispute.deferReason && <FoldedProse label={DISPUTE_PROSE_LABELS.defer} text={dispute.deferReason} open={!dispute.summary} tone="defer" />}
      </section>
      {dispute.debates.map((debate, index) => {
        const ordinal = multiple ? index + 1 : null;
        const source = (seq?: number): DebateDrawerSource => ({
          task: host.task, target, debateId: debate.id, ordinal, seq, reviews: host.reviews,
        });
        const entryKey = debateDrawerEntry(source()).key;
        const count = debate.status === "running"
          ? `第 ${debateSpeaking(debate).seq} / ${debateTotalSegments(debate)} 段`
          : `${debate.turns.filter((turn) => turn.status === "done").length} 段${debate.status === "failed" ? " · 中途断了" : ""}`;
        return (
          <section key={debate.id} className="dispute-part" data-debate={debate.id} aria-label={`辩论${ordinal ? ` 第 ${ordinal} 次` : ""}`}>
            <header>
              <b>辩论{ordinal ? ` · 第 ${ordinal} 次` : ""}<i>{count}</i></b>
              {drawer && (
                <InspTool
                  label="在左侧读完整记录"
                  placement="left"
                  aria-pressed={drawer.activeKey === entryKey}
                  onClick={() => (drawer.activeKey === entryKey ? drawer.close() : drawer.open(debateDrawerEntry(source())))}
                >
                  <ArrowsOutSimple size={14} aria-hidden="true" />
                </InspTool>
              )}
            </header>
            <DebateOverview
              debate={debate}
              onOpen={drawer ? (seq) => drawer.open(debateDrawerEntry(source(seq))) : undefined}
              onQuote={quote}
            />
          </section>
        );
      })}
      {ruling && (
        <section className="dispute-part" aria-label="裁定">
          <header><b>裁定</b></header>
          <p className="dispute-part-gist">
            {ruling}
            {dispute.deferredTaskId && host.onOpenTask && (
              <button type="button" className="dispute-part-link" onClick={() => host.onOpenTask!(dispute.deferredTaskId!)}>
                <ArrowSquareOut size={12} aria-hidden="true" />打开新任务
              </button>
            )}
          </p>
          {dispute.resolutionNote && <FoldedProse label={rulingNoteLabel(dispute)} text={dispute.resolutionNote} />}
        </section>
      )}
    </div>
  );
}
