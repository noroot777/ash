// 会话里「ash 自己说的话」的那一张表：每一类事摆在哪一档、说的是哪件事、写成哪句话。
//
// 类型由服务端写时间线时给（shared/src/timeline-notice.ts）。这里**写结果，不写机制**：
// 「已验收，合并到 main」「不再等回归测试了，它已经跑完」—— 分支名、退出码、理由这些细节
// 在原文里，点开再看（`detail`）。
//
// 四档：
//   milestone 里程碑：审查出了结论、验收了。
//   alert     出了岔子、或者要你拍板的。
//   reply     你那条斜杠命令的回答：是你要看的东西，在原处常显，点开是全文。
//   receipt   回执，记在它所属的那一回合上，平时不画。
// 前两档是所属回合的尾注（回合正文下面那一句小灰字），归属与「并成一句」见
// conversationSystemRows / turnFootnote。
//
// 没有类型的老记录（这份类型出现之前落盘的、线上老服务端写的、以及回合里那几种不走时间线的
// 系统注记）退回老读法：认原文里的几个固定说法，再按起头表（legacyNoticeTable）认要你知道的
// 那几句，其余一律是回执。只有这一处还在读原文。
import { LEGACY_SYS_MARKER, STAGE_LABELS, type TaskStage } from "@ash/shared";
import type { TimelineNotice, TimelineReviewSource } from "@ash/shared/timeline-notice";
import { previewNoticeText } from "../lib/previewUrl.ts";
import type { ConversationEventTone, ConversationEventVariant } from "./conversationNotes.ts";
import { isWorkspaceRecoveryNote, verifyNoteOf } from "./conversationNotes.ts";
import { pendingDisputeEvent } from "./systemNoticeModel.ts";
import { legacyAlert, settlementAlert } from "./legacyNoticeTable.ts";

export type NoticeTier = "milestone" | "alert" | "reply" | "receipt";
/**
 * 这句话报的是好消息还是坏消息。尾注默认全灰；只有它还是现在的事（见 turnFootnote）时，
 * warn / bad 两种在字前面多一颗小圆点：bad 红 = 没办成，warn 琥珀 = 要你知道或要你拍板。
 * ok / neutral 不带任何颜色。
 */
export type NoticeTone = "ok" | "warn" | "bad" | "neutral";
/**
 * 说的是哪件事。同一回合的尾注每件事只留最近一句（见 turnFootnote）：review 审查结论、
 * accept 验收了、failure 这一轮异常结束、other 其余要你知道的。
 */
export type NoticeTopic = "review" | "accept" | "failure" | "other";

export type NoticeView = {
  tier: NoticeTier;
  tone: NoticeTone;
  topic: NoticeTopic;
  /** 摆在会话里 / 流水里的那一句。 */
  text: string;
  /** 句子里要换成等宽字的那一截（分支名、标签名）。 */
  mono?: string;
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
  topic: NoticeTopic,
  text: string,
  raw: string,
  extra: Partial<Pick<NoticeView, "dispute" | "mono">> = {},
): NoticeView {
  return { tier, tone, topic, text, detail: raw && raw !== text ? raw : null, dispute: false, ...extra };
}

function generic(tier: NoticeTier, tone: NoticeTone, raw: string): NoticeView {
  const head = lead(raw);
  return { tier, tone, topic: "other", text: head.text, detail: head.detail, dispute: false };
}

/** 「已验收，合并到 feat/x」：分支名换成等宽字。 */
function accepted(raw: string, target: string | null, noCommit: boolean, tag?: string | null): NoticeView {
  if (tag) return view("milestone", "ok", "accept", `已验收，打上标签 ${tag}`, raw, { mono: tag });
  if (!target) return view("milestone", "ok", "accept", "已验收", raw);
  return view("milestone", "ok", "accept", `已验收，合并到 ${target}${noCommit ? "，等你提交" : ""}`, raw, { mono: target });
}

/** 「第 2 轮审查意见被驳回，等你裁定」：原文（驳回理由、几条出路）点开再看。 */
function disputed(raw: string, round: number | null): NoticeView {
  return view("alert", "warn", "other", `${round ? `第 ${round} 轮` : ""}审查意见被驳回，等你裁定`, raw, { dispute: true });
}

/** 有类型的那一条：整张表就在这个 switch 里。 */
function typedView(notice: TimelineNotice, raw: string): NoticeView {
  switch (notice.kind) {
    case "review.verdict": {
      const text = reviewVerdictText(notice.source, notice.round, notice.verdict, notice.findings);
      // 没能开始的那一轮不算「出了结论」，是出了岔子：同样进尾注，只是归明面那一档。
      return view(notice.verdict === "aborted" ? "alert" : "milestone", reviewVerdictTone(notice.verdict), "review", text, raw);
    }
    case "accept.done":
      return accepted(raw, notice.target, !!notice.noCommit, notice.tag);
    // 不再靠认「现在由你裁定」那几个字找到它。
    case "review.dispute":
      return disputed(raw, notice.round);
    case "review.start":
      return view("receipt", "neutral", "other", `${reviewRoundName(notice.source, notice.round)}${notice.rerun ? "接着跑" : "开始"}`, raw);
    case "review.repair":
      return view("receipt", "neutral", "other", `意见已交给执行者，按${reviewRoundName(notice.source, notice.round)}的意见改`, raw);
    case "stage":
      return view("receipt", "neutral", "other", `验收阶段：${stageLabel(notice.stage)}`, raw);
    case "review.reserved":
      return view("receipt", "neutral", "other", notice.updated ? "审查预约已更新，这一轮跑完自动开始" : "审查已预约，这一轮跑完自动开始", raw);
    case "review.unreserved":
      return view("receipt", "neutral", "other", "审查预约已取消", raw);
    case "review.launch":
      return view("receipt", "neutral", "other", "这一轮跑完，预约的审查开始", raw);
    case "monitor.started":
      return view("receipt", "neutral", "other", `开始盯：${notice.description}`, raw);
    case "monitor.finished":
      return view("receipt", "neutral", "other", `「${notice.description}」结束了`, raw);
    case "monitor.released":
      return view("receipt", "neutral", "other", `不再等「${notice.description}」了${notice.finished ? "，它已经跑完" : ""}`, raw);
    case "command.output": {
      // 是你要看的东西：输出整段摆出来（命令本身那一行拿掉，指到这一行时写在时刻前面）。
      const output = raw.split("\n")
        .filter((line) => line.trim() !== notice.command && line.trim() !== `命令：${notice.command}`)
        .join("\n")
        .trim();
      return { tier: "reply", tone: "neutral", topic: "other", text: output || raw, detail: null, dispute: false, meta: notice.command };
    }
    case "receipt":
      return generic("receipt", "neutral", raw);
    case "alert":
      return generic("alert", "warn", raw);
  }
}

const LEGACY_ACCEPTED = /^验收完成：目标分支\s*(\S+?)(（改动已合入其工作区|；|。|$)/;
const LEGACY_FREE_MERGED = /^自由工作流合并&清理完成：已安全合并\s*\S+\s*→\s*(\S+?)(，|；|。|$)/;
const LEGACY_DISPUTE_ROUND = /（第\s*(\d+)\s*轮/;

/**
 * 没有类型的老记录：认几个固定说法（验收了、审查结论、等你裁定、工作区重建），再按起头表认
 * 要你知道的那几句；其余一律是回执。**不按关键词猜语气**：原文里带「失败」「错误」的多半只是
 * 引了一段描述或命令（「哨兵已起：等回归跑完（npm test || echo FAILED）」），据此升成常显
 * 的红字，回执就成了警报。服务端标了 `level:"notice"` 的结算说明也照同一个办法认，不一律升档。
 */
function legacyView(item: NoticeSource, raw: string): NoticeView {
  if (isWorkspaceRecoveryNote(item.text)) {
    return {
      tier: "alert", tone: "neutral", topic: "other", text: "工作区已恢复，会话内容都在",
      detail: "原目录已不存在，系统已重建空工作区；会话与用户消息均已保留。", dispute: false,
    };
  }
  if (pendingDisputeEvent(item.text)) {
    const round = LEGACY_DISPUTE_ROUND.exec(raw)?.[1];
    return disputed(raw, round ? Number(round) : null);
  }
  const merged = LEGACY_ACCEPTED.exec(raw) ?? LEGACY_FREE_MERGED.exec(raw);
  if (merged) return accepted(raw, merged[1]!, !!merged[2]?.startsWith("（"));
  if (/^验收通过：/.test(raw)) return accepted(raw, null, false);
  // 审查段外面落单的结论旁注（它那一段的开头不在这份记录里）：照样是一句结论。
  const mark = verifyNoteOf(raw);
  if (mark?.phase === "end" && mark.kind !== "inline") {
    if (/审查通过/.test(raw)) return view("milestone", "ok", "review", reviewVerdictText(mark.kind, mark.round, "passed"), raw);
    if (/审查(仍)?未通过/.test(raw)) return view("milestone", "bad", "review", reviewVerdictText(mark.kind, mark.round, "failed"), raw);
    if (/启动失败/.test(raw)) return view("alert", "bad", "review", reviewVerdictText(mark.kind, mark.round, "aborted"), raw);
    if (/未能正常给出结论/.test(raw)) return view("milestone", "warn", "review", reviewVerdictText(mark.kind, mark.round, "inconclusive"), raw);
  }
  if (item.text.includes(LEGACY_SYS_MARKER)) return generic("receipt", "neutral", raw);
  const alert = item.tone === "notice" ? settlementAlert(raw) : legacyAlert(raw);
  return generic(alert ? "alert" : "receipt", alert ? "warn" : "neutral", raw);
}

export function noticeView(item: NoticeSource): NoticeView {
  const raw = noticeRawText(item.text);
  // 回合边界（直播那一路的「本轮执行结束」「执行异常结束 · exit 1」）不走时间线：
  // 正常收口是回执，异常收口是那一回合尾注里的一句。
  // 异常收口落定成一句「这一轮异常结束」，退出码点开再看（run-8）。
  if (item.variant === "boundary") return item.tone === "error" ? turnFailureView(raw) : generic("receipt", "neutral", raw);
  return item.notice ? typedView(item.notice, raw) : legacyView(item, raw);
}

/** 一轮异常结束的那一句（直播那一路的回合边界、刷新以后从会话行认出来的都用它）。 */
export function turnFailureView(raw: string): NoticeView {
  return view("alert", "bad", "failure", "这一轮异常结束", raw);
}
