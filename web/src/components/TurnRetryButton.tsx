import { useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { TurnRetryKind } from "../task-detail/turnRetry.ts";

/**
 * 会话尾栏那颗「重跑上一回合」。
 *
 * 只在**上一回合非正常结束、任务却仍停在终态**时出现（判据见 `task-detail/turnRetry.ts`）：
 * 续聊回合崩了不改任务状态，头部那颗「重试」只认 failed，所以这颗是那种局面下唯一的入口。
 *
 * 审查会话上的这颗跑的是**那一轮审查**（同一位审查者接着把这一轮做完），跟重投一句话
 * 不是一回事，文案必须分开写 —— 用户点之前得知道自己要开的是哪台机器。写「继续」而不是
 * 「重跑」，因为服务端默认就是从中断处接着做（上下文还在那条 CLI 会话里）；只有崩在 CLI
 * 起来之前、无处可接时才退回重发任务书，那一种由点完之后的提示当面说明。
 *
 * 括号里那半句是**这颗按钮为什么会出现**的证据，所以不能写死「exit N」：审查档认的是
 * 「这一轮没给出结论」，而 CLI 报完 API Error 照样 exit 0，写「exit 0」等于自相矛盾。
 */
export function TurnRetryButton({
  exitStatus,
  kind = "turn",
  onRetry,
}: {
  exitStatus: number | null;
  kind?: TurnRetryKind;
  onRetry: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const what = kind === "review" ? "这一轮审查" : "这一回合";
  const why = exitStatus != null && exitStatus !== 0 ? `上一回合 exit ${exitStatus}` : "上一轮未出结论";
  return (
    <button
      type="button"
      className="is-retry"
      disabled={busy}
      aria-label={`上一回合异常结束（${why}），${kind === "review" ? "继续" : "重跑"}${what}`}
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
      {busy ? "重试中…" : `${kind === "review" ? "继续本轮审查" : "重试"}（${why}）`}
    </button>
  );
}
