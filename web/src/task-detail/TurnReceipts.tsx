import { createContext, useContext, useId, useState, type ReactNode } from "react";
import type { ReviewTarget } from "../review/reviewTarget.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import type { TurnReceipt } from "./conversationSystemRows.ts";
import { LaneBody } from "./ReviewVerdict.tsx";
import { DeleteMessageButton } from "./MessageDelete.tsx";
import { NoticeIconGlyph } from "./NoticeIconGlyph.tsx";
import { laneReviewTarget } from "./reviewLaneLinks.ts";
import { formatInstant } from "./utils.ts";

/**
 * 记录里那一轮审查点开去哪儿：跟审查结论那颗气泡同一套（ReviewVerdict 的 onOpenRound / renderLane）。
 * 会话那一层给一份；没给的地方（团队时间线、单测里单摆的记录）那一条就只是一句字。
 */
export type ReceiptReview = {
  taskId?: string;
  reviewOpener?: (lane: ConversationReviewLane) => ((target: ReviewTarget) => void) | undefined;
  renderLane?: (lane: ConversationReviewLane) => ReactNode;
};

export const ReceiptReviewContext = createContext<ReceiptReview | null>(null);

/**
 * 一条回执的时刻：同一天的只写「15:16」，跨了天（或第一条就不是今天）才带上日期。
 * 读屏拿到的是完整日期时刻。
 */
function clock(at: string | undefined, previous: string | undefined): string {
  const full = formatInstant(at);
  if (!full) return "";
  const day = new Date(at!).toDateString();
  const sameDay = previous ? new Date(previous).toDateString() === day : day === new Date().toDateString();
  return sameDay ? full.slice(6) : full;
}

function ReceiptEntry({ receipt, previousAt }: { receipt: TurnReceipt; previousAt?: string }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const review = useContext(ReceiptReviewContext);
  const { view, lane } = receipt;
  const time = clock(receipt.at, previousAt);
  const text = <span className="turn-receipt-text">{view.text}</span>;
  // 被同一回合后来那一轮盖过的审查：会话里不再画它的气泡，这一条就是它的入口——去审查格的那一轮，
  // 认不出去哪儿就在下面摊开那一轮的经过。
  const go = lane && review ? review.reviewOpener?.(lane) : undefined;
  return (
    <li className={`turn-receipt tone-${view.tone}`}>
      {time && <time dateTime={receipt.at} aria-label={formatInstant(receipt.at)}>{time}</time>}
      <NoticeIconGlyph icon={view.icon} />
      {lane && review ? (
        <button
          type="button"
          className="turn-receipt-more"
          aria-label={go ? `${view.text}，在右侧审查格里打开这一轮` : undefined}
          aria-expanded={go ? undefined : open}
          aria-controls={go ? undefined : detailId}
          onClick={() => (go ? go(laneReviewTarget(lane)) : setOpen((value) => !value))}
        >
          {text}
        </button>
      ) : view.detail ? (
        <button
          type="button"
          className="turn-receipt-more"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((value) => !value)}
        >
          {text}
        </button>
      ) : text}
      {receipt.item && <DeleteMessageButton item={receipt.item} />}
      {lane && review && !go && open && (
        <div className="turn-receipt-lane">
          <LaneBody lane={lane} id={detailId} taskId={review.taskId} renderLane={review.renderLane} />
        </div>
      )}
      {!(lane && review) && view.detail && open && <p className="turn-receipt-detail" id={detailId}>{view.detail}</p>}
    </li>
  );
}

/**
 * 记在一回合上的回执：一颗「N 条记录」，点开是一份带时刻的流水（时刻排在每一条最前面）。
 *
 * 平时不画——指到这一回合才出（样式见 system-turn.css 的 `.turn-receipts`：外层回合
 * `:hover` / `:focus-within` 时显形，触屏上常显，点开以后一直在）。每一条说的是结果；
 * 原文（分支名、退出码、理由）点那一条再看。
 *
 * 两半可以分开摆：`TurnReceiptsToggle` 是那颗键（放进回合尾那一排操作里），`TurnReceiptLog`
 * 是摊开的流水（放在回合正文下面）。不想拆就用 `TurnReceipts`，两样排在一起。
 */
export function useTurnReceipts() {
  const [open, setOpen] = useState(false);
  const logId = useId();
  return { open, toggle: () => setOpen((value) => !value), logId };
}

export function TurnReceiptsToggle({ count, open, onToggle, logId }: {
  count: number;
  open: boolean;
  onToggle: () => void;
  logId: string;
}) {
  if (!count) return null;
  return (
    <button
      type="button"
      className="turn-receipts-toggle"
      aria-expanded={open}
      aria-controls={logId}
      onClick={onToggle}
    >
      {count} 条记录
    </button>
  );
}

export function TurnReceiptLog({ receipts, open, logId }: { receipts: readonly TurnReceipt[]; open: boolean; logId: string }) {
  if (!open || !receipts.length) return null;
  return (
    <ol className="turn-receipt-log" id={logId} aria-label="这一回合的记录">
      {receipts.map((receipt, index) => (
        <ReceiptEntry key={receipt.id} receipt={receipt} previousAt={receipts[index - 1]?.at} />
      ))}
    </ol>
  );
}

export function TurnReceipts({ receipts, standalone = false }: {
  receipts: readonly TurnReceipt[];
  /** 没有所属回合、在会话里单独占一行的那一份（常显，不等指到）。 */
  standalone?: boolean;
}) {
  const { open, toggle, logId } = useTurnReceipts();
  if (!receipts.length) return null;
  return (
    <div className={`turn-receipts${open ? " is-open" : ""}${standalone ? " is-standalone" : ""}`}>
      <TurnReceiptsToggle count={receipts.length} open={open} onToggle={toggle} logId={logId} />
      <TurnReceiptLog receipts={receipts} open={open} logId={logId} />
    </div>
  );
}
