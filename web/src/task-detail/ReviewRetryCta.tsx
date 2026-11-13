import { useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { ReviewRetryAction } from "./turnRetry.ts";

/**
 * 会话里「这一轮审查为什么没结论」那句尾注后面的那颗「继续本轮审查」（跟「去裁定」同一种挂法）。
 * 动作与可用性都是任务头那颗图标的同一份（turnRetry.ts 的 ReviewRetryAction），这里只管按着时别连点。
 */
export function ReviewRetryCta({ action }: { action: ReviewRetryAction }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await action.run(); } finally { setBusy(false); }
  };
  return (
    <button type="button" className="system-event-cta" disabled={busy} onClick={() => void run()}>
      <ArrowCounterClockwise size={11} weight="bold" aria-hidden="true" />继续本轮审查
    </button>
  );
}
