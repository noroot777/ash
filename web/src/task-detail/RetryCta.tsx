import { useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";

/**
 * 说「这一轮为什么没办成」的那句话后面那颗带字的重来（跟「去裁定」同一种挂法）：审查档是「继续本轮
 * 审查」，普通回合是「重试这一回合」。可用性和动作都由 TaskDetail 给（turnRetry.ts 的 turnRetryTarget
 * → retryTurn），这里只管按着时别连点。
 */
export function RetryCta({ label, run }: { label: string; run: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const press = async () => {
    setBusy(true);
    try { await run(); } finally { setBusy(false); }
  };
  return (
    <button type="button" className="system-event-cta" disabled={busy} onClick={() => void press()}>
      <ArrowCounterClockwise size={11} weight="bold" aria-hidden="true" />{label}
    </button>
  );
}
