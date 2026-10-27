// 一个回合**最终送进模型**的那串字是怎么拼起来的。
//
// 为什么单独一个文件：原先这段拼装是 `orchestrator.ts` 里的一个长表达式，于是「这条消息
// 到底有多大、里面有没有同一段话的两份拷贝」这件事没有任何地方量得到 —— 体积闸只量得到
// 各个片段（任务书、提醒、完成协议各自都压着预算），而真正发出去的那一条是它们相加。
// 第 1 轮审查 F2 实测：首次派审那条消息 13407B，「报告开头必须」「回归测试统一在验收时」
// 和证据清单引用**各出现两遍**，三段都在预算内、拼起来翻倍。
//
// 所以拼装改成一个纯函数，体积闸直接调它量**投递态**（`delivered/*` 样本）。下面那条
// 去重不变量也住在这里，不住在调用方：调用方漏判一次，就又是一条没人看得见的双份消息。
import {
  REGRESSION_MANIFEST_READING,
  REVIEW_VALIDATION_REQUIREMENT,
  REVIEWER_REGRESSION_CLAUSE,
  regressionManifestEntryOf,
} from "@ash/shared/free-workflow";
import { REPORT_SUMMARY_FORMAT, REPORT_SUMMARY_REMINDER } from "./review-report-format.js";
import { REVIEW_SWEEP_PROTOCOL, REVIEW_SWEEP_REMINDER } from "./review-sweep.js";

/**
 * 每回合提醒里**可能和正文撞车**的那几段，以及「正文里出现什么才算讲过它」。
 *
 * 这张表是**白名单**：只有列在这里的段落会被去掉，其余一律原样留下。方向是刻意的 ——
 * 上一版的判据是「正文里出现了报告格式契约，就把整条提醒丢掉」，而提醒里还带着**这一轮
 * 才有的**东西：证据清单到底可不可用、路径是哪一条、续跑正文从来没讲过的清单读法。
 * 第 2 轮审查 F2 实测：把证据目录弄成不可读之后，提醒明写「清单不可用，把回归面写成
 * 留白」，而首次派审与续跑两条投递消息里这句话都不见了，正文里那句「照常读清单」反而
 * 还在。「有报告格式」证明不了「有当前这份协议」。
 *
 * 每一段配一组 `coveredBy`：正文带的是**更完整的那一版**时也算讲过（缩略版报告格式被
 * 完整版覆盖、缩略扫描义务被扫描协议覆盖、审查者面一句话口径被完整验证义务覆盖）。
 * `coveredBy` 为空 = 只有逐字出现才算。
 */
const DEDUPABLE: ReadonlyArray<{ what: string; text: string; coveredBy: readonly string[] }> = [
  { what: "报告格式契约（缩略版）", text: REPORT_SUMMARY_REMINDER, coveredBy: [REPORT_SUMMARY_FORMAT] },
  { what: "扫描义务（缩略版）", text: REVIEW_SWEEP_REMINDER, coveredBy: [REVIEW_SWEEP_PROTOCOL] },
  { what: "回归口径（审查者面一句话）", text: REVIEWER_REGRESSION_CLAUSE, coveredBy: [REVIEW_VALIDATION_REQUIREMENT] },
  { what: "回归证据清单的读法", text: REGRESSION_MANIFEST_READING, coveredBy: [] },
];

/**
 * 去掉提醒里**正文已经逐字讲过**的那几段静态契约，其余一律留下。
 *
 * 清单入口那一句（`执行者回归证据清单：<路径>。`）单独判：它是**动态**的，路径一样才算
 * 重复 —— 状态变了（清单不可用）、轮次变了（路径变了）都必须跟着提醒发出去。
 */
export function dedupeReminder(reminder: string, userText: string): string {
  if (!reminder) return "";
  let out = reminder;
  for (const { text, coveredBy } of DEDUPABLE) {
    if (!text || !out.includes(text)) continue;
    if (userText.includes(text) || coveredBy.some((full) => full && userText.includes(full))) {
      out = out.split(text).join("");
    }
  }
  const entry = regressionManifestEntryOf(out);
  if (entry && userText.includes(entry)) out = out.split(entry).join("");
  return out.trim() ? out : "";
}

/** 拼装一个回合正文的各片段，顺序即投递顺序。空串表示这一轮没有这一段。 */
export interface TurnPromptParts {
  /** 新面孔被拉进任务时的开场（`COLLAB_INVITE`）。 */
  invite: string;
  /** 任务需求抬头（`invitedTaskBrief`）。 */
  brief: string;
  /** 「你被搬过机器了」的一次性前言。 */
  handoffNotice: string;
  /** 「本任务里还有别人」。 */
  peerNotice: string;
  /** 这一轮真正要说的话（已过技能处理、已拼附件）。 */
  userText: string;
  /** 工作目录被重建时的说明。 */
  workspaceReset: string;
  /** 完成协议 / 续聊提醒（`COMPLETION_REMINDER` 或 `FOLLOW_UP_REMINDER`）。 */
  completion: string;
  /** 当前方向身份。 */
  direction: string;
  /** 由任务状态派生的审查/验证提醒；正文已逐字讲过的那几段静态契约会被摘掉（见上）。 */
  reviewReminder: string;
}

export function assembleTurnPrompt(parts: TurnPromptParts): string {
  const reminder = dedupeReminder(parts.reviewReminder, parts.userText);
  return parts.invite +
    parts.brief +
    (parts.handoffNotice ? `${parts.handoffNotice}\n\n` : "") +
    parts.peerNotice +
    parts.userText +
    parts.workspaceReset +
    parts.completion +
    parts.direction +
    (reminder ? `\n${reminder}` : "");
}
