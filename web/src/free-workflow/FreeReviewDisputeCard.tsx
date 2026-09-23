import { useState } from "react";
import type { FreeReviewRound, FreeReviewRun } from "@ash/shared";
import { MAX_FREE_REVIEW_DEBATE_EXCHANGES } from "@ash/shared/free-workflow";
import { ChatsCircle, HandPalm, SpinnerGap, Wrench } from "@phosphor-icons/react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { FreeReviewDebateTranscript } from "./FreeReviewDebateTranscript.tsx";

type Pending = "debate" | "withdrawn" | "upheld";

/**
 * 「执行者不认这一轮意见」的那张卡：驳回理由 + 辩论回放 + 三个只有用户能按的出口。
 *
 * 三个出口互不等价，文案必须把差别说死：
 * - 让双方辩论：先听几段再决定，**不改变任何结论**，辩完还是回到这张卡上裁定。
 * - 采纳执行者：这条未通过意见作废；审查记录与证据原样留着，那条 run 也**不会**被
 *   改写成「已通过」——替审查者签字比留一条「用户裁定作废」的记录危险得多。
 * - 维持意见：驳回作废，后端接着按原报告发起修复。
 */
export function FreeReviewDisputeCard({
  taskId,
  run,
  round,
  disabled = false,
  onChanged,
  notify,
}: {
  taskId: string;
  run: FreeReviewRun;
  round: FreeReviewRound;
  disabled?: boolean;
  onChanged: (state: FreeWorkflowApiState) => void;
  notify: (message: string) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState(1);
  const dispute = round.dispute;
  const debates = dispute?.debates ?? [];
  const latestDebate = debates.at(-1) ?? null;
  const debateRunning = latestDebate?.status === "running";
  // 辩完的那条挡住再辩（后端同判据）：同一份报告挂两条辩完的记录只会让「以哪条为准」
  // 变成新问题。中断的可以重开——那是系统没让人说完，不该连带把用户的出路关掉。
  const canDebate = !latestDebate || latestDebate.status === "failed";
  if (!dispute) return null;
  const blocked = disabled || debateRunning;

  const startDebate = async () => {
    setBusy(true);
    try {
      const result = await api.startFreeReviewDebate(taskId, exchanges);
      onChanged(result.state);
      setPending(null);
      notify(`已开始辩论：审查者先答辩，共 ${exchanges * 2 + 1} 段发言；说完还是由你裁定`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "发起辩论失败");
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (resolution: "withdrawn" | "upheld") => {
    setBusy(true);
    try {
      const result = await api.resolveFreeReviewDispute(taskId, resolution);
      onChanged(result.state);
      setPending(null);
      notify(resolution === "withdrawn"
        ? `已采纳执行者说法：第 ${round.round} 轮那条意见作废，审查记录原样保留`
        : result.repairError
          ? `已维持审查意见，但发起修复失败：${result.repairError}`
          : `已维持审查意见，正在按第 ${round.round} 轮报告发起修复`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "裁定失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="free-review-dispute-card" aria-label="执行者驳回审查意见">
      <header>
        <span><HandPalm size={13} weight="fill" /></span>
        <div>
          <b>执行者驳回了第 {round.round} 轮意见</b>
          <small>{run.reviewerName} · {debateRunning ? "辩论进行中" : "等你裁定"}</small>
        </div>
      </header>
      <div className="free-review-dispute-card__reason">
        <b>驳回理由</b>
        <MarkdownBody text={dispute.reason} />
      </div>
      {debates.map((item, index) => (
        <FreeReviewDebateTranscript
          key={item.id}
          debate={item}
          ordinal={debates.length > 1 ? index + 1 : null}
        />
      ))}
      <p>
        {debateRunning
          ? "双方正在各自陈词；辩论只产生发言，不改变结论，说完仍由你裁定。"
          : latestDebate?.status === "finished"
            ? "双方都说完了。审查者收尾时给的只是它自己的立场，最后由你裁定。"
            : latestDebate?.status === "failed"
              ? "上一场辩论中途断了（有一段没能发言）；可以重开一场，也可以直接裁定。"
              : "审查链已停在这里：既没有照改，也没有当成通过。"}
      </p>
      <div className="free-review-dispute-card__actions">
        {(canDebate || debateRunning) && (
          <button type="button" disabled={blocked || busy} onClick={() => setPending("debate")}>
            {debateRunning ? <SpinnerGap size={12} className="is-spinning" /> : <ChatsCircle size={12} />}
            {latestDebate ? "重开辩论" : "让双方辩论"}
          </button>
        )}
        <button type="button" disabled={blocked || busy} onClick={() => setPending("withdrawn")}>
          <HandPalm size={12} />采纳执行者说法
        </button>
        <button type="button" disabled={blocked || busy} onClick={() => setPending("upheld")}>
          <Wrench size={12} />维持意见并修复
        </button>
      </div>

      {pending === "debate" && (
        <ConfirmDialog
          title="让审查者和执行者辩论"
          eyebrow="CONFIRM ACTION"
          icon={<ChatsCircle size={19} weight="duotone" />}
          message="双方会轮流发言、都不改代码；辩完仍然回到这张卡上由你裁定。"
          confirmLabel="开始辩论"
          busy={busy}
          onConfirm={() => void startDebate()}
          onClose={() => { if (!busy) setPending(null); }}
        >
          <div className="free-review-debate-exchanges">
            <b>辩几个来回</b>
            <div>
              {Array.from({ length: MAX_FREE_REVIEW_DEBATE_EXCHANGES }, (_, index) => index + 1).map((count) => (
                <button
                  key={count}
                  type="button"
                  className={count === exchanges ? "is-selected" : ""}
                  aria-pressed={count === exchanges}
                  onClick={() => setExchanges(count)}
                >{count}</button>
              ))}
            </div>
            <small>一个来回 = 审查者答辩 + 执行者回应；末尾审查者再收个尾，共 {exchanges * 2 + 1} 段发言。</small>
          </div>
        </ConfirmDialog>
      )}
      {pending === "withdrawn" && (
        <ConfirmDialog
          title="采纳执行者说法"
          message={`第 ${round.round} 轮那条未通过意见作废，执行者不再按它修改。审查报告与截图原样保留，这条审查链也不会被改写成「已通过」。`}
          confirmLabel="采纳，作废这条意见"
          busy={busy}
          onConfirm={() => void resolve("withdrawn")}
          onClose={() => { if (!busy) setPending(null); }}
        />
      )}
      {pending === "upheld" && (
        <ConfirmDialog
          title="维持审查意见"
          message={`驳回作废，执行者会按第 ${round.round} 轮报告继续修复。`}
          confirmLabel="维持并发起修复"
          busy={busy}
          onConfirm={() => void resolve("upheld")}
          onClose={() => { if (!busy) setPending(null); }}
        />
      )}
    </section>
  );
}
