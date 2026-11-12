import { useState } from "react";
import type { FreeReviewRun } from "@ash/shared";
import { MAX_FREE_REVIEW_RETRIES } from "@ash/shared/free-workflow";
import { Repeat } from "@phosphor-icons/react";
import { RoundsStepper } from "../components/RoundsStepper.tsx";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import "../styles/free-review-dialog.css";

/**
 * 审查进行中改这条链最多跑几轮。正在跑的那一轮自己占一轮，所以下限就是它；
 * 最后一轮跑着时往上加，这一轮没通过就会转给执行者修复、修完自动续审（服务端结算按
 * 落笔那一刻的上限判，见 server/src/free-review-rounds.ts）。
 */
export function FreeReviewRoundsDialog({
  taskId,
  run,
  onChanged,
  onClose,
  notify,
}: {
  taskId: string;
  run: FreeReviewRun;
  onChanged: (state: FreeWorkflowApiState) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const min = run.currentRound;
  const max = MAX_FREE_REVIEW_RETRIES + 1;
  const [total, setTotal] = useState(() => Math.max(run.retryLimit + 1, min));
  const [busy, setBusy] = useState(false);
  const unchanged = total === run.retryLimit + 1;

  const save = async () => {
    if (busy) return;
    if (unchanged) { onClose(); return; }
    setBusy(true);
    try {
      onChanged(await api.adjustFreeReviewRounds(taskId, { runId: run.id, retryLimit: total - 1 }));
      notify(`审查轮数已改为最多 ${total} 轮`);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "调整审查轮数失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title="调整审查轮数"
      eyebrow={`${run.reviewerName} · ${run.checkMode === "logic" ? "逻辑检查" : "语法检查"}`}
      icon={<Repeat size={19} weight="duotone" />}
      message={`第 ${run.currentRound} 轮正在审查。`}
      confirmLabel="保存"
      busy={busy}
      onConfirm={() => void save()}
      onClose={() => { if (!busy) onClose(); }}
    >
      <div className="free-review-rounds">
        <div>
          <span>最多</span>
          <RoundsStepper label="最多轮数" value={total} min={min} max={max} disabled={busy} onChange={setTotal} />
          <span>轮</span>
        </div>
        <small>{total > run.currentRound
          ? `第 ${run.currentRound} 轮未通过时，意见交给执行者修复，修完自动审第 ${run.currentRound + 1} 轮。`
          : `第 ${run.currentRound} 轮是最后一轮，未通过就停下来等你处理。`}</small>
      </div>
    </ConfirmDialog>
  );
}
