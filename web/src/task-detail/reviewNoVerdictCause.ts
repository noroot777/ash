// 一轮审查没给出结论时，会话里「第 N 轮审查没有给出结论」那颗气泡**紧贴下面那一句**：为什么断的，
// 后面挂「继续本轮审查」（能续时）。
//
// 用户 2026-11-13 第三次问同一件事：原因和按钮都得在说这件事的地方，而且要看得到出了什么错。之前
// 两样都挂在服务端写的那条 `review.no_verdict` 旁注上，于是 ① 那份记录上线之前断掉的轮次（会话里
// 只有一条没带 runId 的结论旁注、外加一句推断错了的「报告可能写完了…report_stage…」）什么都没有；
// ② 新记录那一句是「其余要你知道的」那一档，结论之后再来一句别的提醒（「重跑上一回合没有执行」）
// 就把它挤出了尾注，按钮跟着没了。
//
// 所以原因不从旁注里读，按**轮次身份**从审查状态里取（`FreeReviewRound.noVerdict`：服务端存过的，
// 或者按盘上的事实现算的）：卡上的 runId（「开始」那条写的，老记录由 attachReports 按时间窗口配）+
// 轮号，对上那一场那一轮。同一场同一轮在会话里有几张卡（续过、中间隔着你的话），原因只给最后那张：
// 服务端那一份说的是这一轮**最近那一回合**。那一句自己算一件事（topic=review），不跟别的提醒抢位置。
// 同一个位置上原来那两种说法（新记录的旁注、老记录那句推断）随之不再单独说，记录里照旧都在。
import type { FreeReviewRun } from "@ash/shared";
import type { ReviewNoVerdict } from "@ash/shared/timeline-notice";
import { noVerdictCauseText, noVerdictSaidText } from "../free-workflow/freeReviewRounds.ts";
import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationFeedRow, ConversationReviewLane } from "./conversationReviewLanes.ts";
import { CHANNEL_GAP_GUESS } from "./legacyNoticeTable.ts";
import { noticeRawText, type NoticeView } from "./timelineNoticeCopy.ts";

type EventItem = Extract<ConversationItem, { kind: "event" }>;

/** 某一张卡对上的那一场那一轮，以及服务端给的原因。 */
export type LaneNoVerdict = { runId: string; round: number; cause: ReviewNoVerdict };

/** 尾注里那一句的 id：按轮次身份起，「继续本轮审查」据它认挂在哪一句后面。 */
export function noVerdictPartId(runId: string, round: number): string {
  return `no-verdict:${runId}:${round}`;
}

/** 收了口、却没出结论的卡（没上报、中断、没能开始都算）。 */
function concludedNothing(lane: ConversationReviewLane): boolean {
  return lane.complete && lane.conclusion !== "verified" && lane.conclusion !== "verify_failed";
}

/** 卡 id → 它那一轮的原因。只给每一场每一轮最后那张卡。 */
export function laneNoVerdicts(rows: readonly ConversationFeedRow[], reviews: readonly FreeReviewRun[] | null | undefined): Map<string, LaneNoVerdict> {
  const last = new Map<string, { laneId: string; value: LaneNoVerdict | null }>();
  for (const row of rows) {
    if (row.kind !== "review-lane" || !row.complete || !row.runId) continue;
    const run = reviews?.find((candidate) => candidate.id === row.runId);
    if (!run) continue;
    // 合并结果审查的卡没有轮号（一次就是一次），对的是那一场的当前轮。
    const number = row.round ?? run.currentRound;
    const round = (run.rounds ?? []).find((candidate) => candidate.round === number);
    const value = round?.noVerdict && concludedNothing(row) ? { runId: run.id, round: number, cause: round.noVerdict } : null;
    last.set(`${run.id}\u0000${number}`, { laneId: row.id, value });
  }
  const out = new Map<string, LaneNoVerdict>();
  for (const { laneId, value } of last.values()) if (value) out.set(laneId, value);
  return out;
}

/**
 * 那一句怎么说。类型明确：那半句就是原因，原话点开看；类型不明（只说得出退出码）：原话直接摆在
 * 那半句后面 —— 是什么错只有它说得出。没上报的那一类没有原话，点开是服务端那段说明（见 `absorbs`）。
 */
export function noVerdictCauseView(cause: ReviewNoVerdict): NoticeView {
  const head = noVerdictCauseText(cause);
  const said = noVerdictSaidText(cause);
  const inline = cause.vague && cause.said;
  return {
    tier: "alert", tone: "warn", topic: "review", icon: "review",
    text: inline ? `${head}：「${cause.said}」` : head,
    detail: inline ? null : said,
    dispute: false,
  };
}

/**
 * 同一个位置上原来说这件事的那一条，这一句出现以后它就不再单独说：这一轮自己那条带类型的原因旁注；
 * 老服务端那句「报告可能写完了…report_stage」（回合中断时它是错的，没上报时它的说明还在理，点开看）。
 * 返回 null = 不是它；`detail` = 它的原文能不能拿来当点开的说明。
 */
export function absorbs(entry: LaneNoVerdict, event: EventItem): { detail: string | null } | null {
  const notice = event.notice;
  const raw = noticeRawText(event.text);
  if (notice?.kind === "review.no_verdict") {
    if (notice.runId !== entry.runId || notice.round !== entry.round) return null;
    return { detail: entry.cause.kind === "unreported" ? raw : null };
  }
  if ((!notice || notice.kind === "alert") && CHANNEL_GAP_GUESS.test(raw)) {
    return { detail: entry.cause.kind === "unreported" ? raw : null };
  }
  return null;
}
