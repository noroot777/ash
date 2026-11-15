import type { FreeReviewDebate, FreeReviewDebateSide, FreeReviewDebateTurn, FreeReviewRun } from "@ash/shared";

/**
 * 辩论的读取侧模型：会话里那颗辩论气泡、审查格那一轮下面的辩论那一段、左侧抽屉里的完整记录，三处共用。
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

/** 这一段的一句话：交卷时写的那句摘要；老记录没有就拿完整发言的开头顶上，不空着。 */
export function turnGist(turn: Pick<FreeReviewDebateTurn, "summary" | "statement" | "status">): string {
  if (turn.summary?.trim()) return turn.summary.trim();
  const plain = (turn.statement ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain) return plain.length > GIST_LIMIT ? `${plain.slice(0, GIST_LIMIT)}…` : plain;
  if (turn.status === "speaking") return "正在组织发言…";
  return "这一段没能发言";
}
const GIST_LIMIT = 80;

const said = (debate: FreeReviewDebate) => debate.turns.filter((turn) => turn.status === "done");

/** 正在说的（或该轮到的）那一段：第几段、谁。 */
export function debateSpeaking(debate: FreeReviewDebate): { seq: number; side: FreeReviewDebateSide } {
  const speaking = debate.turns.find((turn) => turn.status === "speaking");
  if (speaking) return { seq: speaking.seq, side: speaking.side };
  const seq = debate.turns.length + 1;
  return { seq, side: debate.currentSide ?? (seq % 2 === 1 ? "reviewer" : "executor") };
}

/** 中途断了：断在哪一段、哪一方没能发言。 */
function debateBreak(debate: FreeReviewDebate): { seq: number; side: FreeReviewDebateSide } {
  const broken = debate.turns.find((turn) => turn.status !== "done");
  if (broken) return { seq: broken.seq, side: broken.side };
  const seq = debate.turns.length + 1;
  return { seq, side: seq % 2 === 1 ? "reviewer" : "executor" };
}

/** 收尾那一段（审查者自述立场的那段）；没说到那儿就是 null。 */
export function closingTurn(debate: FreeReviewDebate): FreeReviewDebateTurn | null {
  const total = debateTotalSegments(debate);
  return debate.turns.find((turn) => turn.seq === total && turn.status === "done") ?? said(debate).at(-1) ?? null;
}

export type DebateBubbleState = "live" | "awaiting" | "settled" | "failed";

/**
 * 会话里那颗辩论气泡此刻写什么：
 * - 辩论中（live）：谁 + 刚说完的那一段的一句话；一段都还没说完时「审查者在组织第 1 段」；
 * - 辩完、还等裁定（awaiting）：「审查者收尾 · 部分成立」+ 它收尾那一段的一句话——这是用户据以裁定的；
 * - 裁完以后、历史上的（settled）：缩成一句「辩了 3 段，审查者收尾：部分成立」；
 * - 中途断了（failed）：断在哪一段、哪一方没能发言。
 *
 * 审查者自述的立场**不是**裁定：措辞不能写成「结论是…」，那会让用户以为已经有人替他签过字了。
 */
export function debateBubbleText(debate: FreeReviewDebate, state: DebateBubbleState): { lead: string | null; text: string } {
  const last = said(debate).at(-1) ?? null;
  if (state === "live") {
    if (!last) return { lead: null, text: `${DEBATE_SIDE_LABEL.reviewer}在组织第 1 段` };
    return { lead: DEBATE_SIDE_LABEL[last.side], text: turnGist(last) };
  }
  if (state === "failed") {
    const broken = debateBreak(debate);
    return { lead: null, text: `辩论断在第 ${broken.seq} 段：${DEBATE_SIDE_LABEL[broken.side]}没能发言${last ? `，前 ${said(debate).length} 段都在` : ""}` };
  }
  const closing = closingTurn(debate);
  const stance = debate.verdict ? DEBATE_VERDICT_LABEL[debate.verdict] : "没给立场";
  if (state === "awaiting") {
    return { lead: `${DEBATE_SIDE_LABEL.reviewer}收尾 · ${stance}`, text: closing ? turnGist(closing) : "" };
  }
  return { lead: null, text: `辩了 ${said(debate).length} 段，${DEBATE_SIDE_LABEL.reviewer}收尾：${stance}` };
}

/** 辩论中收着时气泡下面那一行小灰字：此刻谁在说第几段。 */
export function debateNowText(debate: FreeReviewDebate): string {
  const speaking = debateSpeaking(debate);
  return `${DEBATE_SIDE_LABEL[speaking.side]}在说第 ${speaking.seq} / ${debateTotalSegments(debate)} 段`;
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
