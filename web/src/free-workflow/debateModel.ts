import type { FreeReviewDebate, FreeReviewDebateSide, FreeReviewRun } from "@ash/shared";

/**
 * 辩论的读取侧模型：时间线上那张折叠卡、审查面板里的驳回卡、全宽阅读态，三处共用。
 *
 * 只有一件事值得说清楚：**一场辩论的记录是 `turn.statement`，不是 agent 在对话里说
 * 了什么。** 两侧发言都由 `debate_reply` 交卷落库（server/src/free-review-debate.ts），
 * 而它们各自的 CLI 回合在任务/审查会话里还会留下一段随口的交代——那段长短全看执行器
 * 脾气：claude 会把整段论证又讲一遍，codex 只写一句「本段发言已提交」。照着对话渲染，
 * 就会得到用户 2026-09-24 报的那个样子：一边完整长文、一边一句话，看上去像 codex 没
 * 参与讨论（实际上 debatePrompt 每一段都把对方的完整 statement 重发了一遍）。
 */

export const DEBATE_SIDE_LABEL: Record<FreeReviewDebateSide, string> = {
  reviewer: "审查者",
  executor: "执行者",
};

export const DEBATE_VERDICT_LABEL: Record<NonNullable<FreeReviewDebate["verdict"]>, string> = {
  upheld: "维持原意见",
  withdrawn: "撤回原意见",
  partial: "部分成立",
};

/** 总发言段数 = 来回数 × 2 + 1（末尾多一段审查者收尾）。与服务端 totalSegments 同式。 */
export function debateTotalSegments(debate: Pick<FreeReviewDebate, "exchanges">): number {
  return debate.exchanges * 2 + 1;
}

export function debateStatusText(debate: FreeReviewDebate): string {
  const total = debateTotalSegments(debate);
  if (debate.status === "running") {
    const speaking = debate.turns.find((turn) => turn.status === "speaking");
    const who = debate.currentSide ? DEBATE_SIDE_LABEL[debate.currentSide] : "双方";
    return `${who}发言中 · 第 ${speaking?.seq ?? debate.turns.length} / ${total} 段`;
  }
  if (debate.status === "failed") return "辩论中断 · 有一段没能发言";
  // 审查者自述的立场**不是**裁定：措辞不能写成「结论是…」，那会让用户以为已经有人
  // 替他签过字了。仍然由他在卡片上按下采纳或维持。
  return debate.verdict ? `已结束 · 审查者自述：${DEBATE_VERDICT_LABEL[debate.verdict]}` : "已结束";
}

/** 卡头那颗状态胶囊：结论一眼可读，不用先数到第几段。 */
export function debateVerdictBadge(debate: FreeReviewDebate): { text: string; tone: "running" | "failed" | "verdict" | "done" } {
  if (debate.status === "running") return { text: debateStatusText(debate), tone: "running" };
  if (debate.status === "failed") return { text: "辩论中断", tone: "failed" };
  return debate.verdict
    ? { text: `审查者自述：${DEBATE_VERDICT_LABEL[debate.verdict]}`, tone: "verdict" }
    : { text: "已结束", tone: "done" };
}

export type DebateCandidate = {
  debate: FreeReviewDebate;
  /** 这场辩论辩的是第几轮审查意见 —— 时间线上的旁注只报得出轮号，靠它配对。 */
  round: number;
  runId: string;
  reviewerName: string | null;
};

/**
 * 把 `reviews` 里所有落盘的辩论摊平，按开始时间升序 —— 时间线要拿轮号 + 出现次序去配。
 *
 * 同一条驳回上可能辩过多次（中断的那条可以重开），所以配对必须「第 k 场第 N 轮」对
 * 「第 k 条第 N 轮」，不能「找到就用」。
 */
export function debateCandidatesOf(reviews: readonly FreeReviewRun[] | null | undefined): DebateCandidate[] {
  return (reviews ?? [])
    .flatMap((run) => (run.rounds ?? []).flatMap((round) => (round.dispute?.debates ?? []).map((debate) => ({
      debate,
      round: round.round,
      runId: run.id,
      reviewerName: run.reviewerName || null,
    }))))
    .sort((left, right) => left.debate.startedAt.localeCompare(right.debate.startedAt));
}
