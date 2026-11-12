// 会话里「ash 自己说的话」的那一张表：每一类事摆在哪一档、什么语气、写成哪句话。
//
// 类型由服务端写时间线时给（shared/src/timeline-notice.ts）。这里**写结果，不写机制**：
// 「已验收，合并到 main」「不再等回归测试了，它已经跑完」—— 分支名、退出码、理由这些细节
// 在原文里，点开再看（`detail`）。
//
// 四档：
//   milestone 里程碑，会话里常显一行（审查出了结论、验收了）。
//   alert     出了岔子、或者要你拍板的，留在会话明面上。
//   reply     你那条斜杠命令的回答：是你要看的东西，常显一行，点开是全文。
//   receipt   回执，记在它所属的那一回合上，平时不画（conversationSystemRows 负责归属）。
//
// 没有类型的老记录（这份类型出现之前落盘的、以及回合里那几种不走时间线的系统注记）退回老读法：
// 认原文里的几个固定说法、再按关键词猜语气。只有这一处还在读原文。
import { LEGACY_SYS_MARKER, STAGE_LABELS, type TaskStage } from "@ash/shared";
import type { TimelineNotice, TimelineReviewSource } from "@ash/shared/timeline-notice";
import { previewNoticeText } from "../lib/previewUrl.ts";
import type { ConversationEventTone, ConversationEventVariant } from "./conversationNotes.ts";
import { isWorkspaceRecoveryNote, verifyNoteOf } from "./conversationNotes.ts";
import { pendingDisputeEvent } from "./systemNoticeModel.ts";

export type NoticeTier = "milestone" | "alert" | "reply" | "receipt";
/** 颜色只落在行首那颗图标上：ok 绿、warn 琥珀、bad 红、neutral 灰。 */
export type NoticeTone = "ok" | "warn" | "bad" | "neutral";
/** 图标形状：审查用盾，其余按语气。 */
export type NoticeGlyph = "review" | "check" | "warn" | "info" | "recovery";

export type NoticeView = {
  tier: NoticeTier;
  tone: NoticeTone;
  glyph: NoticeGlyph;
  /** 摆在会话里 / 流水里的那一句。 */
  text: string;
  /** 点开再看的原文。跟 `text` 说的是同一句时为 null。 */
  detail: string | null;
  /** 「执行者驳回了审查意见，等你裁定」——这一条上挂「去裁定」。 */
  dispute: boolean;
  /** 指到才出的那半句里、排在时刻前面的话（命令的回答：是哪条命令）。 */
  meta?: string;
};

type NoticeSource = {
  text: string;
  notice?: TimelineNotice;
  tone?: ConversationEventTone;
  variant?: ConversationEventVariant;
};

const REVIEW_NOUN: Record<TimelineReviewSource, string> = { free: "审查", inline: "验证", merge: "审查" };

/** 「第 3 轮审查」「第 2 轮验证」「合并结果审查」。 */
export function reviewRoundName(source: TimelineReviewSource, round: number | null): string {
  if (source === "merge") return "合并结果审查";
  return `${round ? `第 ${round} 轮` : ""}${REVIEW_NOUN[source]}`;
}

export type ReviewVerdictWord = "passed" | "failed" | "inconclusive" | "aborted";

/** 审查轮收成的那一句：「第 3 轮审查通过」「第 2 轮审查未通过，2 条意见」。 */
export function reviewVerdictText(
  source: TimelineReviewSource,
  round: number | null,
  verdict: ReviewVerdictWord,
  findings?: number | null,
): string {
  const name = reviewRoundName(source, round);
  if (verdict === "passed") return `${name}通过`;
  if (verdict === "failed") return `${name}未通过${findings ? `，${findings} 条意见` : ""}`;
  if (verdict === "aborted") return `${name}没能开始`;
  return `${name}没有给出结论`;
}

export function reviewVerdictTone(verdict: ReviewVerdictWord): NoticeTone {
  return verdict === "passed" ? "ok" : verdict === "inconclusive" ? "warn" : "bad";
}

function stageLabel(stage: string): string {
  return (STAGE_LABELS as Record<string, string | undefined>)[stage as TaskStage] ?? stage;
}

/** 原文里摆给人看的那一份：去掉老记录的〔系统〕前缀，预览地址换成能点的说法。 */
export function noticeRawText(text: string): string {
  return previewNoticeText(text.replace(/^〔系统〕/, "").trim());
}

const SHORT = 48;

/**
 * 没有专门说法的那一大片：短的整句照登；长的只留「标题：细节」里的标题，或者第一句，
 * 剩下的点开再看。服务端的话绝大多数是「验收暂缓：……」「预览没起来（…）……」这种起头。
 */
function lead(raw: string): { text: string; detail: string | null } {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= SHORT) return { text: flat, detail: raw === flat ? null : raw };
  const colon = flat.search(/[：:]/);
  if (colon > 1 && colon <= 24) return { text: flat.slice(0, colon), detail: raw };
  const stop = flat.search(/[。；！？]/);
  if (stop > 1 && stop <= 60) return { text: flat.slice(0, stop), detail: raw };
  return { text: `${flat.slice(0, SHORT - 1)}…`, detail: raw };
}

function view(
  tier: NoticeTier,
  tone: NoticeTone,
  glyph: NoticeGlyph,
  text: string,
  raw: string,
  dispute = false,
): NoticeView {
  return { tier, tone, glyph, text, detail: raw && raw !== text ? raw : null, dispute };
}

function generic(tier: NoticeTier, tone: NoticeTone, raw: string): NoticeView {
  const head = lead(raw);
  return { tier, tone, glyph: tone === "ok" ? "check" : tone === "neutral" ? "info" : "warn", text: head.text, detail: head.detail, dispute: false };
}

/** 有类型的那一条：整张表就在这个 switch 里。 */
function typedView(notice: TimelineNotice, raw: string): NoticeView {
  switch (notice.kind) {
    case "review.verdict": {
      const text = reviewVerdictText(notice.source, notice.round, notice.verdict, notice.findings);
      // 没能开始的那一轮不算「出了结论」，是出了岔子：同样常显，只是归明面那一档。
      return view(notice.verdict === "aborted" ? "alert" : "milestone", reviewVerdictTone(notice.verdict), "review", text, raw);
    }
    case "accept.done": {
      const text = notice.tag
        ? `已验收，打上标签 ${notice.tag}`
        : notice.target
          ? `已验收，合并到 ${notice.target}${notice.noCommit ? "，等你提交" : ""}`
          : "已验收";
      return view("milestone", "ok", "check", text, raw);
    }
    // 这一张卡的样子不动（原文 + 「去裁定」），只是不再靠认「现在由你裁定」那几个字找到它。
    case "review.dispute":
      return { tier: "alert", tone: "warn", glyph: "review", text: raw, detail: null, dispute: true };
    case "review.start":
      return view("receipt", "neutral", "review", `${reviewRoundName(notice.source, notice.round)}${notice.rerun ? "接着跑" : "开始"}`, raw);
    case "review.repair":
      return view("receipt", "neutral", "review", `意见已交给执行者，按${reviewRoundName(notice.source, notice.round)}的意见改`, raw);
    case "stage":
      return view("receipt", "neutral", "info", `验收阶段：${stageLabel(notice.stage)}`, raw);
    case "review.reserved":
      return view("receipt", "neutral", "review", notice.updated ? "审查预约已更新，这一轮跑完自动开始" : "审查已预约，这一轮跑完自动开始", raw);
    case "review.unreserved":
      return view("receipt", "neutral", "review", "审查预约已取消", raw);
    case "review.launch":
      return view("receipt", "neutral", "review", "这一轮跑完，预约的审查开始", raw);
    case "monitor.started":
      return view("receipt", "neutral", "info", `开始盯：${notice.description}`, raw);
    case "monitor.finished":
      return view("receipt", "neutral", "info", `「${notice.description}」结束了`, raw);
    case "monitor.released":
      return view("receipt", "neutral", "info", `不再等「${notice.description}」了${notice.finished ? "，它已经跑完" : ""}`, raw);
    case "command.output": {
      // 是你要看的东西：输出整段摆出来（命令本身那一行拿掉，指到这一行时写在时刻前面）。
      const output = raw.split("\n")
        .filter((line) => line.trim() !== notice.command && line.trim() !== `命令：${notice.command}`)
        .join("\n")
        .trim();
      return { tier: "reply", tone: "neutral", glyph: "info", text: output || raw, detail: null, dispute: false, meta: notice.command };
    }
    case "receipt":
      return generic("receipt", "neutral", raw);
    case "alert":
      return generic("alert", "warn", raw);
  }
}

const LEGACY_ACCEPTED = /^验收完成：目标分支\s*(\S+?)(（改动已合入其工作区|；|。|$)/;
const LEGACY_FREE_MERGED = /^自由工作流合并&清理完成：已安全合并\s*\S+\s*→\s*(\S+?)(，|；|。|$)/;

/** 没有类型的老记录：认几个固定说法，其余按服务端当时标的语气（或关键词）分档。 */
function legacyView(item: NoticeSource, raw: string): NoticeView {
  if (isWorkspaceRecoveryNote(item.text)) {
    return {
      tier: "alert", tone: "neutral", glyph: "recovery", text: "工作区已恢复，会话内容都在",
      detail: "原目录已不存在，系统已重建空工作区；会话与用户消息均已保留。", dispute: false,
    };
  }
  if (pendingDisputeEvent(item.text)) return { tier: "alert", tone: "warn", glyph: "review", text: raw, detail: null, dispute: true };
  const accepted = LEGACY_ACCEPTED.exec(raw) ?? LEGACY_FREE_MERGED.exec(raw);
  if (accepted) return view("milestone", "ok", "check", `已验收，合并到 ${accepted[1]}${accepted[2]?.startsWith("（") ? "，等你提交" : ""}`, raw);
  if (/^验收通过：/.test(raw)) return view("milestone", "ok", "check", "已验收", raw);
  // 审查段外面落单的结论旁注（它那一段的开头不在这份记录里）：照样常显成一句结论。
  const mark = verifyNoteOf(raw);
  if (mark?.phase === "end" && mark.kind !== "inline") {
    if (/审查通过/.test(raw)) return view("milestone", "ok", "review", reviewVerdictText(mark.kind, mark.round, "passed"), raw);
    if (/审查(仍)?未通过/.test(raw)) return view("milestone", "bad", "review", reviewVerdictText(mark.kind, mark.round, "failed"), raw);
  }
  if (item.text.includes(LEGACY_SYS_MARKER)) return generic("receipt", "neutral", raw);
  if (item.tone === "notice") return generic("alert", "warn", raw);
  if (item.tone === "error") return generic("alert", "bad", raw);
  return generic("receipt", "neutral", raw);
}

export function noticeView(item: NoticeSource): NoticeView {
  const raw = noticeRawText(item.text);
  // 回合边界（直播那一路的「本轮执行结束」「执行异常结束 · exit 1」）不走时间线：
  // 正常收口是回执，异常收口留在明面上。
  if (item.variant === "boundary") return item.tone === "error" ? generic("alert", "bad", raw) : generic("receipt", "neutral", raw);
  return item.notice ? typedView(item.notice, raw) : legacyView(item, raw);
}
