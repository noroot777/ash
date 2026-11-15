import type { FreeReviewDebate, FreeReviewDebateTurn } from "@ash/shared";
import { DEBATE_SIDE_LABEL, debateSpeaking } from "./debateModel.ts";
import { TalkOverview } from "./TalkOverview.tsx";

export { QuoteKey, SpeakingLine } from "./TalkOverview.tsx";

/**
 * 一场辩论的概览：会话里那颗气泡就地摊开的、审查格那一轮下面的辩论那一段，是这同一个组件；画法是
 * 讨论那边也在用的 TalkOverview，这里只把辩论的记录换成它的形状。
 *
 * - `onOpen`：点某一行，左侧抽屉打开并停在那一段（读完整发言）；
 * - `onQuote`：这条驳回还等你裁定时才给，指到某一行出一颗「用这段作要点」。
 */
export function DebateOverview({ debate, onOpen, onQuote }: {
  debate: FreeReviewDebate;
  onOpen?: (seq: number) => void;
  onQuote?: (turn: FreeReviewDebateTurn) => void;
}) {
  const running = debate.status === "running";
  const next = running && !debate.turns.some((turn) => turn.status === "speaking") ? debateSpeaking(debate) : null;
  return (
    <TalkOverview
      label="辩论概览"
      segments={debate.turns.map((turn) => ({ ...turn, who: DEBATE_SIDE_LABEL[turn.side] }))}
      waiting={next && { seq: next.seq, who: DEBATE_SIDE_LABEL[next.side] }}
      onOpen={onOpen}
      onQuote={onQuote && ((seq) => {
        const turn = debate.turns.find((item) => item.seq === seq);
        if (turn) onQuote(turn);
      })}
    />
  );
}
