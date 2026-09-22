import type { FreeReviewDebate, FreeReviewDebateTurn } from "@ash/shared";
import { SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";

const SIDE_LABEL: Record<FreeReviewDebateTurn["side"], string> = {
  reviewer: "审查者",
  executor: "执行者",
};

const VERDICT_LABEL: Record<NonNullable<FreeReviewDebate["verdict"]>, string> = {
  upheld: "维持原意见",
  withdrawn: "撤回原意见",
  partial: "部分成立",
};

export function debateStatusText(debate: FreeReviewDebate): string {
  const total = debate.exchanges * 2 + 1;
  if (debate.status === "running") {
    const speaking = debate.turns.find((turn) => turn.status === "speaking");
    const who = debate.currentSide ? SIDE_LABEL[debate.currentSide] : "双方";
    return `${who}发言中 · 第 ${speaking?.seq ?? debate.turns.length} / ${total} 段`;
  }
  if (debate.status === "failed") return "辩论中断 · 有一段没能发言";
  // 审查者自述的立场**不是**裁定：措辞不能写成「结论是…」，那会让用户以为已经有人
  // 替他签过字了。仍然由他在卡片上按下采纳或维持。
  return debate.verdict ? `已结束 · 审查者自述：${VERDICT_LABEL[debate.verdict]}` : "已结束";
}

/** 一条驳回上那几段发言的逐段回放。发言正文是 agent 写的 Markdown，按报告同样的方式渲染。 */
export function FreeReviewDebateTranscript({
  debate,
  ordinal = null,
}: {
  debate: FreeReviewDebate;
  /** 同一条驳回上辩过多次时的第几次（只有一次就传 null，不摆序号）。 */
  ordinal?: number | null;
}) {
  return (
    <div className="free-review-debate" aria-label="审查意见辩论">
      <header>
        <b>{ordinal ? `第 ${ordinal} 次辩论` : "辩论"}</b>
        <small>{debateStatusText(debate)}</small>
      </header>
      <ol>
        {debate.turns.map((turn) => (
          <li key={turn.seq} className={`is-${turn.side}${turn.status === "speaking" ? " is-speaking" : ""}`}>
            <span>
              <b>{SIDE_LABEL[turn.side]}</b>
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
