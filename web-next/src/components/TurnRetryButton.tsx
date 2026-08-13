import { useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";

/**
 * 会话尾栏那颗「重跑上一回合」。
 *
 * 只在**上一回合非正常结束、任务却仍停在终态**时出现（判据见 `task-detail/turnRetry.ts`）：
 * 续聊回合崩了不改任务状态，头部那颗「重试」只认 failed，所以这颗是那种局面下唯一的入口。
 */
export function TurnRetryButton({
  exitStatus,
  onRetry,
}: {
  exitStatus: number;
  onRetry: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="is-retry"
      disabled={busy}
      aria-label={`上一回合异常结束（退出码 ${exitStatus}），重跑这一回合`}
      onClick={async () => {
        setBusy(true);
        try {
          await onRetry();
        } finally {
          setBusy(false);
        }
      }}
    >
      <ArrowCounterClockwise size={11} aria-hidden="true" />
      {busy ? "重试中…" : `重试（上一回合 exit ${exitStatus}）`}
    </button>
  );
}
