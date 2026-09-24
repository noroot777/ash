import type { FreeReviewDebate } from "@ash/shared";
import { SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { DEBATE_SIDE_LABEL, debateStatusText, debateTotalSegments } from "./debateModel.ts";

export { debateStatusText };

/**
 * 一条驳回上那几段发言的逐段回放。发言正文是 agent 写的 Markdown，按报告同样的方式渲染。
 *
 * 两种宽度：`panel` 是审查面板里那一栏（窄，只求「看得见」），`reading` 是全宽阅读态
 * （宽，求「读得完」）。同一份数据两套排版，是因为面板那一栏只有 ~540px，七段发言在
 * 里面会被压成一根一万像素高的细条（用户 2026-09-24 实测反馈）。
 */
export function FreeReviewDebateTranscript({
  debate,
  ordinal = null,
  variant = "panel",
  action,
}: {
  debate: FreeReviewDebate;
  /** 同一条驳回上辩过多次时的第几次（只有一次就传 null，不摆序号）。 */
  ordinal?: number | null;
  variant?: "panel" | "reading";
  /** 卡头右边挂的东西（面板里是「全宽阅读」，阅读态里没有）。 */
  action?: ReactNode;
}) {
  const total = debateTotalSegments(debate);
  return (
    <div className={`free-review-debate is-${variant}`} aria-label="审查意见辩论">
      <header>
        <b>{ordinal ? `第 ${ordinal} 次辩论` : "辩论"}</b>
        <small>{debateStatusText(debate)}</small>
        {action}
      </header>
      <ol>
        {debate.turns.map((turn) => (
          <li key={turn.seq} className={`is-${turn.side}${turn.status === "speaking" ? " is-speaking" : ""}`}>
            <span>
              <b>{DEBATE_SIDE_LABEL[turn.side]}</b>
              <em>第 {turn.seq}/{total} 段{turn.seq === total ? " · 收尾" : ""}</em>
              {turn.status === "speaking" && <SpinnerGap size={10} className="is-spinning" />}
              {turn.status === "error" && <WarningCircle size={10} weight="fill" />}
            </span>
            {turn.statement
              ? <MarkdownBody text={turn.statement} />
              : <p className="free-review-debate__pending">{turn.status === "speaking" ? "正在组织发言…" : "这一段没有留下发言。"}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
