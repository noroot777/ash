// 进行条（docs/ui-ux-audit run-2）：等它开口的那一段，会话最后一行写「在想」，字上有流光；
// 过 2 秒后面跟上这一轮已经跑了多久，想过 15 秒换成「还在想」。它一开口（出正文、调工具），
// 这一行就让给那一回合自己的执行过程那一行（同一时刻只有一个「活的」东西）。
//
// `still` = 这会儿没有东西在动（排着队、等上游回话）：字上没有流光。
import type { ReactNode } from "react";
import { formatDuration } from "../task-detail/utils.ts";
import { useNow } from "../lib/useNow.ts";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";
import "./live-strip.css";

export function thinkWord(elapsedMs: number): string {
  return elapsedMs >= 15_000 ? "还在想" : "在想";
}

export function LiveStrip({ since, text, still = false, tip }: {
  /** 这一轮从哪一刻算起；没有就不写用时。 */
  since: string | null | undefined;
  /** 缺省按用时说「在想」/「还在想」。 */
  text?: string;
  still?: boolean;
  /** 指上去多说的一句（排队时「前面的任务结束后会自动启动」）。 */
  tip?: ReactNode;
}) {
  const start = since ? Date.parse(since) : Number.NaN;
  const now = useNow(true);
  const elapsed = Number.isFinite(start) ? Math.max(0, now - start) : null;
  const label = text ?? thinkWord(elapsed ?? 0);
  const hover = useHoverTip();
  return (
    <div className="live-strip" role="status" aria-live="polite" {...(tip ? hover.anchorProps : {})}>
      <span className={`live-strip-label${still ? "" : " shim"}`}>{label}</span>
      {elapsed !== null && elapsed >= 2000 && <span className="live-strip-time num">{formatDuration(elapsed)}</span>}
      {tip && <HoverTip at={hover.at}>{tip}</HoverTip>}
    </div>
  );
}
