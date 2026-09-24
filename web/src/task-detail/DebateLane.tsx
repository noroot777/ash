import { useId, useState, type ReactNode } from "react";
import { ArrowsOutSimple, Gavel } from "@phosphor-icons/react";
import { FreeReviewDebateReader } from "../free-workflow/FreeReviewDebateReader.tsx";
import { FreeReviewDebateTranscript } from "../free-workflow/FreeReviewDebateTranscript.tsx";
import { DEBATE_SIDE_LABEL, debateTotalSegments, debateVerdictBadge } from "../free-workflow/debateModel.ts";
import type { ConversationDebateRow } from "./conversationDebateRows.ts";
import { durationBetween, formatInstant } from "./utils.ts";

function timing(row: ConversationDebateRow): string | null {
  const start = formatInstant(row.startedAt);
  const end = formatInstant(row.endedAt);
  const duration = durationBetween(row.startedAt, row.endedAt);
  if (!start) return duration;
  return `${start}${end && end !== start ? `–${end}` : ""}${duration ? ` · ${duration}` : ""}`;
}

/**
 * 卡头那排小色块：一格一段发言，颜色即发言方，空心的是还没说的。
 *
 * 它替掉的是原来七条「辩论第 i/7 段：轮到 X 发言」的流水旁注——那七条讲的是进度，而
 * 进度用七个像素格就说完了，不值七行。
 */
function SegmentStrip({ row }: { row: ConversationDebateRow }) {
  const debate = row.candidate?.debate;
  if (!debate) return null;
  const total = debateTotalSegments(debate);
  const done = new Map(debate.turns.map((turn) => [turn.seq, turn]));
  return (
    <span className="debate-lane-strip" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => index + 1).map((seq) => {
        const turn = done.get(seq);
        const side = turn?.side ?? (seq % 2 === 1 ? "reviewer" : "executor");
        const state = !turn ? "pending" : turn.status === "done" ? "done" : turn.status;
        return <i key={seq} className={`is-${side} is-${state}`} />;
      })}
    </span>
  );
}

/**
 * 时间线上的一整场辩论，收成一张卡。
 *
 * 展开后列的是 `turn.statement`（双方 `debate_reply` 交卷的那份记录），**不是**各自
 * CLI 回合里随口说的那句话——照对话渲染会得到一边完整长文、一边一句「本段发言已提交」，
 * 看上去像只有一方在讨论（用户 2026-09-24 报的）。配不到落盘记录时（只读视图没传
 * reviews、或快照还没跟上）退回原始行，宁可啰嗦也不凭空少掉一段。
 */
export function DebateLane({ row, fallback }: { row: ConversationDebateRow; fallback: ReactNode }) {
  const [collapsed, setCollapsed] = useState(true);
  const [reading, setReading] = useState(false);
  const bodyId = useId();
  const debate = row.candidate?.debate ?? null;
  const badge = debate ? debateVerdictBadge(debate) : null;
  const time = timing(row);
  const reviewer = row.candidate?.reviewerName;
  const title = `第 ${row.round ?? "?"} 轮审查意见${reviewer ? ` · ${reviewer}` : ""}`;
  const sides = debate
    ? `${debateTotalSegments(debate)} 段 · ${DEBATE_SIDE_LABEL.reviewer} ↔ ${DEBATE_SIDE_LABEL.executor}`
    : `第 ${row.round ?? "?"} 轮审查意见`;

  return (
    <article className={`debate-lane${collapsed ? " is-collapsed" : ""}`} aria-label={`审查意见辩论 · ${title}`}>
      <header className="debate-lane-head">
        <span className="debate-lane-mark" aria-hidden="true"><Gavel size={12} weight="fill" /></span>
        <b>审查意见辩论{row.ordinal ? ` · 第 ${row.ordinal} 次` : ""}</b>
        <SegmentStrip row={row} />
        <span className="debate-lane-by">{sides}</span>
        {badge && <span className={`debate-lane-verdict is-${badge.tone}`}>{badge.text}</span>}
        {time && <small className="debate-lane-time">{time}</small>}
        <span className="debate-lane-actions">
          {debate && (
            <button type="button" onClick={() => setReading(true)}>
              <ArrowsOutSimple size={11} aria-hidden="true" />全宽阅读
            </button>
          )}
          <button
            type="button"
            aria-controls={bodyId}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "展开" : "收起"}
          </button>
        </span>
      </header>
      <div className="debate-lane-body" id={bodyId} hidden={collapsed}>
        {debate
          ? <FreeReviewDebateTranscript debate={debate} variant="reading" />
          : fallback}
      </div>
      {reading && debate && (
        <FreeReviewDebateReader
          debate={debate}
          title={title}
          ordinal={row.ordinal}
          onClose={() => setReading(false)}
        />
      )}
    </article>
  );
}
