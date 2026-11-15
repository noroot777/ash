import { useId, type ReactNode } from "react";
import type { FreeReviewDebate, FreeReviewDebateTurn } from "@ash/shared";
import { Quotes } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { DEBATE_SIDE_LABEL, debateSpeaking, turnGist } from "./debateModel.ts";

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

/**
 * 一场辩论的概览：一段一行，左边写谁，右边是那一段的一句话（发言方交卷时写的那句摘要；老记录没有就拿
 * 完整发言的开头顶上）。会话里那颗气泡就地摊开的、审查格那一轮下面的辩论那一段，是这同一个组件。
 *
 * - `onOpen`：点某一行，左侧抽屉打开并停在那一段（读完整发言）；
 * - `onQuote`：这条驳回还等你裁定时才给，指到某一行出一颗「用这段作要点」。
 */
export function DebateOverview({ debate, onOpen, onQuote }: {
  debate: FreeReviewDebate;
  onOpen?: (seq: number) => void;
  onQuote?: (turn: FreeReviewDebateTurn) => void;
}) {
  const id = useId();
  const running = debate.status === "running";
  const waiting = running && !debate.turns.some((turn) => turn.status === "speaking") ? debateSpeaking(debate) : null;
  const row = (key: string | number, who: string, say: ReactNode, quote: ReactNode = null) => (
    <li key={key} className="debate-row">
      <span className="debate-row-who">{who}</span>
      <div>{say}</div>
      {quote}
    </li>
  );
  return (
    <ol className="debate-overview" aria-label="辩论概览">
      {debate.turns.map((turn) => {
        const who = DEBATE_SIDE_LABEL[turn.side];
        if (turn.status === "speaking") return row(turn.seq, who, <SpeakingLine className="debate-row-gist is-live" />);
        const gist = turnGist(turn);
        const say = onOpen && turn.statement ? (
          <button
            type="button"
            className="debate-row-gist"
            aria-describedby={`${id}-${turn.seq}`}
            onClick={() => onOpen(turn.seq)}
          >
            {gist}<em id={`${id}-${turn.seq}`}>全文 {turn.statement.length} 字</em>
          </button>
        ) : <p className="debate-row-gist">{gist}</p>;
        return row(turn.seq, who, say, onQuote && turn.statement ? <QuoteKey onQuote={() => onQuote(turn)} /> : null);
      })}
      {waiting && row("waiting", DEBATE_SIDE_LABEL[waiting.side], <SpeakingLine className="debate-row-gist is-live" />)}
    </ol>
  );
}
