import { useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { TurnRetryKind } from "../task-detail/turnRetry.ts";

/**
 * 会话尾栏那颗「重跑上一回合」。
 *
 * 只在**上一回合非正常结束、任务却仍停在终态**时出现（判据见 `task-detail/turnRetry.ts`）：
 * 续聊回合崩了不改任务状态，头部那颗「重试」只认 failed，所以这颗是那种局面下唯一的入口。
 *
 * 审查会话上的这颗跑的是**那一轮审查**（同一位审查者续跑），跟重投一句话不是一回事，
 * 文案必须分开写 —— 用户点之前得知道自己要开的是哪台机器。
 */
export function TurnRetryButton({
  exitStatus,
  kind = "turn",
  onRetry,
}: {
  exitStatus: number;
  kind?: TurnRetryKind;
  onRetry: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const what = kind === "review" ? "这一轮审查" : "这一回合";
  return (
    <button
      type="button"
      className="is-retry"
      disabled={busy}
      aria-label={`上一回合异常结束（退出码 ${exitStatus}），重跑${what}`}
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
      {busy ? "重试中…" : `${kind === "review" ? "重跑本轮审查" : "重试"}（上一回合 exit ${exitStatus}）`}
    </button>
  );
}
