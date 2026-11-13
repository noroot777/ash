import { useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";

/**
 * 说「这一轮为什么没办成」的那句话后面那颗带字的重来（跟「去裁定」同一种挂法）：审查档是「继续本轮
 * 审查」，普通回合是「重试这一回合」。可用性和动作都由 TaskDetail 给（服务端下发的 `retryTurn`，经
 * turnRetry.ts 的 retryTurnActions），这里只管按着时别连点；`blocked` 是服务端说此刻做不了的原因。
 */
export function RetryCta({ label, run, blocked }: { label: string; run: () => Promise<void>; blocked?: string | null }) {
  const [busy, setBusy] = useState(false);
  const hover = useHoverTip();
  const press = async () => {
    setBusy(true);
    try { await run(); } finally { setBusy(false); }
  };
  return (
    <>
      <button
        type="button"
        className={`system-event-cta${blocked ? " is-disabled" : ""}`}
        disabled={busy}
        aria-disabled={blocked ? true : undefined}
        {...(blocked ? hover.anchorProps : {})}
        onClick={() => { if (!blocked) void press(); }}
      >
        <ArrowCounterClockwise size={11} weight="bold" aria-hidden="true" />{label}
      </button>
      {blocked && <HoverTip at={hover.at}>{blocked}</HoverTip>}
    </>
  );
}
