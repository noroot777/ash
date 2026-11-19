import { useId, type ReactNode } from "react";
import { Quotes } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { turnGist } from "./debateModel.ts";

/** 「用这段作要点」那颗图标键：指到那一行才出（触屏常显），读屏念得出它是什么。 */
export function QuoteKey({ onQuote, className = "debate-quote" }: { onQuote: () => void; className?: string }) {
  const tip = useHoverTip({ placement: "above" });
  return (
    <>
      <button type="button" className={className} aria-label="用这段作要点" onClick={onQuote} {...tip.anchorProps}>
        <Quotes size={13} weight="fill" aria-hidden="true" />
      </button>
      <HoverTip at={tip.at}>用这段作要点</HoverTip>
    </>
  );
}

/** 正在说的那一段：一颗在动的点 + 「正在组织发言…」。 */
export function SpeakingLine({ className }: { className: string }) {
  return (
    <p className={className}>
      <span className="workspace-status-dot workspace-status-dot--run" aria-hidden="true" />正在组织发言…
    </p>
  );
}

/** 一段：谁说的、说到哪了、交卷时那一句和完整发言。辩论和讨论各自把记录换成这个形状。 */
export type TalkSegment = {
  seq: number;
  who: string;
  status: "speaking" | "done" | "error";
  summary: string | null;
  /** 完整发言；还没交卷时为空串。 */
  statement: string;
};

/**
 * 几方交替说几段的概览：一段一行，左边写谁，右边是那一段的一句话（交卷时写的那句摘要；老记录没有就拿
 * 完整发言的开头顶上）。审查意见的辩论（DebateOverview）和讨论用的是这同一个组件——会话里气泡就地摊开的、
 * 右侧「审议」格里那一段，都是它。
 *
 * - `waiting`：上一段说完、下一段还没起头的那一下，照样有一行「正在组织发言…」，不让列表看着像停了；
 * - `onOpen`：点某一行，左侧抽屉打开并停在那一段（读完整发言）；
 * - `onQuote`：辩论那一条还等你裁定时才给，指到某一行出一颗「用这段作要点」。
 */
export function TalkOverview({ label, className, segments, waiting, onOpen, onQuote }: {
  label: string;
  /** 讨论那边左列写的是执行器名（比「审查者」长），给 `is-named` 放宽那一列。 */
  className?: string;
  segments: readonly TalkSegment[];
  waiting?: { seq: number; who: string } | null;
  onOpen?: (seq: number) => void;
  onQuote?: (seq: number) => void;
}) {
  const id = useId();
  const row = (key: string | number, who: string, say: ReactNode, quote: ReactNode = null) => (
    <li key={key} className="debate-row">
      <span className="debate-row-who">{who}</span>
      <div>{say}</div>
      {quote}
    </li>
  );
  return (
    <ol className={`debate-overview${className ? ` ${className}` : ""}`} aria-label={label}>
      {segments.map((segment) => {
        if (segment.status === "speaking") return row(segment.seq, segment.who, <SpeakingLine className="debate-row-gist is-live" />);
        const gist = turnGist(segment);
        const say = onOpen && segment.statement ? (
          <button
            type="button"
            className="debate-row-gist"
            aria-describedby={`${id}-${segment.seq}`}
            onClick={() => onOpen(segment.seq)}
          >
            {gist}<em id={`${id}-${segment.seq}`}>全文 {segment.statement.length} 字</em>
          </button>
        ) : <p className="debate-row-gist">{gist}</p>;
        return row(segment.seq, segment.who, say, onQuote && segment.statement ? <QuoteKey onQuote={() => onQuote(segment.seq)} /> : null);
      })}
      {waiting && row("waiting", waiting.who, <SpeakingLine className="debate-row-gist is-live" />)}
    </ol>
  );
}
