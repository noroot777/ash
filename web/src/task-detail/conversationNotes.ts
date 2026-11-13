// 会话流里那些不是「谁说的话」的行：预约审查、验收阶段更新、合并&清理完成、
// 验证轮开始/结束、预览起停…… 服务端有 70 多处 appendTaskTimeline 写它们，文案各写各的，
// 所以这里**只按关键词判语气，不判结构**——判错了最多是颜色不对，不会把会话切错段。
//
// 结构由 conversationModel 统一决定：
//   note     旁注,贴着上一段说话继续,不重复头像/执行器名(system 时间线通告都归这档)
//   boundary 回合边界(本轮执行结束 / 执行异常结束 / 本回合结束),保留整宽横线
import { SESSION_POISON_DIAGNOSIS_PREFIX, stripSessionNotes } from "@ash/shared/session-notes";
import type { TimelineNotice } from "@ash/shared/timeline-notice";
import { legacyReviewMark } from "./legacyNoticeTable.ts";

// notice = 结算说明（「这一轮为什么落成这个状态」）。它由服务端**显式标记**（事件和落盘
// 行上的 level:"notice"），不参与下面的关键词推断 —— 这类说明里天然带着「未完成」，猜出
// 来永远是红的，而一条红字对第一次用 ash 的人只有一个读法：它崩了。
export type ConversationEventTone = "neutral" | "error" | "notice";
export type ConversationEventVariant = "note" | "boundary";
// 只收「这件事没办成」的词。「未通过」是审查结论、也确实要显眼,归红;
// 「通过」「完成」「开始」这类正常推进不进表。
const FAILED_HINTS = [
  "失败",
  "异常",
  "未通过",
  "没通过",
  "未完成",
  "打回",
  "暂缓",
  "已取消",
  "没起来",
  "起不来",
  "用完了",
  "警告",
  "错误",
];

export function noteTone(text: string): ConversationEventTone {
  // poisoned 诊断整条都在**转述** Codex 报的 rollout/world-state 异常,自己带着「异常」
  // 二字,讲的却是「为什么判这条会话坏了」——不是这一轮失败。它的正文由 stderr 指纹拼
  // 出来、以后还会加新指纹,摘不干净,所以认前缀先拦一道(@ash/shared/session-notes)。
  if (text.includes(SESSION_POISON_DIAGNOSIS_PREFIX)) return "neutral";
  // 会话轮换旁注（「这条 CLI 会话接不回了，下次开新的」）是中性事实，不是本回合失败：
  // 它照样会出现在一个 exit 0 的成功回合、甚至用户自己点的「停止全组」上。文案里带着
  // 「异常」这类词，蹭上关键词表就成了红的。判据用 @ash/shared/session-notes 那份**同一
  // 源文本**，不靠「写文案时记得绕开那几个词」。
  // 摘掉再判、而不是「含轮换旁注就中性」：收尾那句是拼出来的，后半段可能正是「恢复字段
  // 写入数据库失败」这类真失败，整句判中性会把它一起洗白。
  return FAILED_HINTS.some((hint) => stripSessionNotes(text).includes(hint)) ? "error" : "neutral";
}

// 「这条旁注在讲一轮审查的事吗，是开头还是结尾，第几轮」—— 会话里验证段的起止就是
// 这两条旁注，跟审查者的气泡同一套青色，读者才看得出它们是一段；轮次号还要拿来补给
// 气泡上的徽标。
//
// 两种审查在时间线上各写各的话：就地验证写「第 N 轮验证…」（review.ts），自由派审写
// 「自由工作流第 N 轮审查…」（free-workflow.ts）。两边分开认，因为它们能推出的东西不
// 一样：就地验证是搭在被验任务自己会话上的，区间内说话的那个人**就是**审查者；自由
// 派审另开一条 reviewer 会话，区间只能用来补轮次，不能拿来改别人的身份。
export type VerifyNoteMark = {
  kind: "inline" | "free" | "merge";
  round: number | null;
  phase: "start" | "end";
  /** 开始那一条带着的「哪一场」（服务端写在 review.start 上；老记录、就地验证没有）。 */
  runId?: string;
  /**
   * 开始那一条是不是同一轮的重跑。带类型的旁注里服务端一定会说（重跑才标 `rerun`，所以不标
   * = 不是重跑）；只有原文的老旁注不知道，为 undefined。
   */
  rerun?: boolean;
};

/**
 * 没有类型的老记录：只认句首那几句服务端写死的说法（legacyNoticeTable 的 REVIEW_ROUND_LEADS，
 * 跟认提醒的那张起头表放在一处）。辩论旁注（「开始辩论第 1 轮审查意见：…」）、引了哨兵描述或命令的
 * 回执，开头都不是这几句，自然不算。
 */
export function verifyNoteOf(text: string): VerifyNoteMark | null {
  return legacyReviewMark(text);
}

export function isVerifyNote(text: string, notice?: TimelineNotice): boolean {
  return !!verifyMark(text, notice);
}

/**
 * 同上，但先认服务端给的类型（shared/src/timeline-notice.ts）：带类型的旁注**不再看原文**，
 * 原文只是给没有类型的老记录兜底的。审查段的起止只有这三类：开始、出了结论、按意见修复。
 */
export function verifyMark(text: string, notice?: TimelineNotice): VerifyNoteMark | null {
  if (!notice) return verifyNoteOf(text);
  if (notice.kind === "review.start") {
    return {
      kind: notice.source, round: notice.round, phase: "start", rerun: notice.rerun === true,
      ...(typeof notice.runId === "string" && notice.runId ? { runId: notice.runId } : {}),
    };
  }
  if (notice.kind === "review.verdict" || notice.kind === "review.repair") {
    return { kind: notice.source, round: notice.round, phase: "end" };
  }
  return null;
}

/** 条目版：会话条目上带着 text 与 notice 两样。 */
export function verifyMarkOf(item: { text: string; notice?: TimelineNotice }): VerifyNoteMark | null {
  return verifyMark(item.text, item.notice);
}

const STAGE_UPDATE = /验收阶段更新：.*（([a-z_]+)）/;

/** 这条旁注是不是一次「验收阶段翻档」，翻到了哪一档（verified / verify_failed / merged / accepted …）。 */
export function stageOf(item: { text: string; notice?: TimelineNotice }): string | null {
  if (item.notice) return item.notice.kind === "stage" ? item.notice.stage : null;
  return STAGE_UPDATE.exec(item.text)?.[1] ?? null;
}

/**
 * 旁注的语气（这个字段别处也在读：审查卡里的旁注、辩论条的兜底排版）。带类型的按类型给，
 * 没有类型的老记录才按关键词猜（noteTone）；结算说明一律是 notice。
 */
export function eventTone(text: string, notice?: TimelineNotice, level?: "notice"): ConversationEventTone {
  if (level === "notice") return "notice";
  if (!notice) return noteTone(text);
  if (notice.kind === "alert") return "error";
  if (notice.kind === "review.verdict") return notice.verdict === "failed" || notice.verdict === "aborted" ? "error" : "neutral";
  return "neutral";
}

// worktree 被验收清理后，用户继续追问会触发这一条持久系统回执。它不是警告，也不是
// 新的一段对话；渲染层只把这条已知文案收成一行中性恢复记录，其他系统旁注保持原样。
export function isWorkspaceRecoveryNote(text: string): boolean {
  return text.includes("原工作目录(worktree 与分支)已不存在")
    && text.includes("已重建为空目录");
}
