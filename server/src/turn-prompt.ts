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
} from "@ash/shared/free-workflow";
import { craftRulesFor, type CraftContext } from "./craft-rules.js";
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
 * 由任务状态派生的每回合提醒，连同它里面那条**动态入口**。
 *
 * 入口单独作为字段传过来，不让拼装层从正文里去找：只有产生它的那一层才真知道路径到哪儿
 * 为止。见 `manifestEntry` 的注释。
 */
export interface TurnReminder {
  /** 提醒正文。空串 = 这一轮没有提醒。 */
  text: string;
  /**
   * 这一轮清单入口**完整**的那一句（`执行者回归证据清单：<路径>。`）；没有清单就是 null。
   *
   * 为什么必须结构化传、不能从正文里反解：上一版用「前缀之后第一个『。』」把它切出来，
   * 目录名里带一个「。」就塌 —— 切出来的是路径前半截，于是两条只共享前缀的不同路径被
   * 判成同一个入口，当前这一轮的地址被当成重复删掉，留下的是用户消息里引的旧地址
   * （第 1 轮审查在真实目录上复现，三个提醒入口全中）。自然语言里的句号不是地址边界。
   */
  manifestEntry: string | null;
}

/** 这一轮没有审查/验证提醒。 */
export const NO_REMINDER: TurnReminder = { text: "", manifestEntry: null };

/**
 * 去掉提醒里**正文已经逐字讲过**的那几段静态契约，其余一律留下。
 *
 * 清单入口那一句单独判，判据是**整串相等**：路径一模一样才算重复 —— 状态变了（清单不
 * 可用）、轮次变了（路径变了）都必须跟着提醒发出去。拿不准的一律保留。
 */
export function dedupeReminder(reminder: TurnReminder, userText: string): string {
  if (!reminder.text) return "";
  let out = reminder.text;
  for (const { text, coveredBy } of DEDUPABLE) {
    if (!text || !out.includes(text)) continue;
    if (userText.includes(text) || coveredBy.some((full) => full && userText.includes(full))) {
      out = out.split(text).join("");
    }
  }
  const { manifestEntry } = reminder;
  if (manifestEntry && out.includes(manifestEntry) && userText.includes(manifestEntry)) {
    out = out.split(manifestEntry).join("");
  }
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
  /**
   * 产出质量规则**这一轮的事实**（`craft-rules.ts`）。收的是判据而不是渲染好的字符串，
   * 理由见 `craftRulesFor`。走这条路的回合里它多半是空的：真正的 `--resume` 续跑手上
   * 已经有那段上下文了，只有「没有旧上下文的首条消息」（首次被 @ 进来、旧会话接不上、
   * `/clear` 之后新开）才非空。
   */
  craft: CraftContext;
  /** 这一轮真正要说的话（已过技能处理、已拼附件）。 */
  userText: string;
  /** 工作目录被重建时的说明。 */
  workspaceReset: string;
  /** 完成协议 / 续聊提醒（`COMPLETION_REMINDER` 或 `FOLLOW_UP_REMINDER`）。 */
  completion: string;
  /** 当前方向身份。 */
  direction: string;
  /** 由任务状态派生的审查/验证提醒；正文已逐字讲过的那几段静态契约会被摘掉（见上）。 */
  reviewReminder: TurnReminder;
}

export function assembleTurnPrompt(parts: TurnPromptParts): string {
  const reminder = dedupeReminder(parts.reviewReminder, parts.userText);
  return parts.invite +
    parts.brief +
    (parts.handoffNotice ? `${parts.handoffNotice}\n\n` : "") +
    parts.peerNotice +
    // 紧挨正文，和 fresh 那条同一个落位。不必补前导空行：它前面那几段（邀请语、需求抬头、
    // 接力前言、同伴告知）都自带尾部空行，全空时它就是整条消息的开头。
    //
    // **新增一段只许插在片段之间，不许顶掉任何一个 `parts.*`。**第 1 轮审查 F1 就是这么
    // 来的：这一段当初是替换 `parts.peerNotice +` 加进去的，于是「本任务还有其他智能体
    // 参与」在首次被 @ 进来、普通续聊、审查三条路上一起消失 —— 类型里它仍必填、调用方
    // 照样算了传了，只有拼装这一行不再读它，编译和当时的样本（同伴字段一律传空）全绿。
    // 这条不变量现在由体积闸的「片段保留」断言机械钉住，见 test-prompt-budget.ts。
    craftRulesFor(parts.craft) +
    parts.userText +
    parts.workspaceReset +
    parts.completion +
    parts.direction +
    (reminder ? `\n${reminder}` : "");
}

/**
 * fresh run（全新会话的第一条消息）各片段，顺序即投递顺序。
 *
 * 和上面那个续聊/续跑的拼装分开住，因为两条路带的东西不是一个集合：fresh 多了自主性前言、
 * 团队前言、审查任务书，少了工作目录重建告警和每回合审查提醒。抽成函数的理由跟本文件头
 * 那一段一样 —— 原先它是 `task-run.ts` 里的一个长表达式，于是「每个任务开场真正发出去的
 * 那一条有多大、里面有没有某一段」在任何地方都量不到，而那恰恰是往开场加字时最该量的一条。
 */
export interface FreshPromptParts {
  /** 无人值守前言（`AUTONOMY`）。 */
  autonomy: string;
  /**
   * 产出质量规则这一轮的事实。fresh run 必然是一条全新 CLI 会话，所以 `freshContext`
   * 恒真；交结论还是交代码由审查任务那一位定。
   */
  craft: CraftContext;
  /** 完成协议长版（`COMPLETION_PROTOCOL`）。 */
  completion: string;
  /** 当前方向身份。 */
  direction: string;
  /** 团队执行者前言。 */
  teamPreamble: string;
  /** 历史独立审查任务的审查协议。 */
  reviewProtocol: string;
  /** 「你被搬过机器了」的一次性前言。 */
  handoffNotice: string;
  /** 「本任务里还有别人」。 */
  peerNotice: string;
  /** 任务目标正文（含 autoTitle 的标题提示）。 */
  objective: string;
}

export function assembleFreshPrompt(parts: FreshPromptParts): string {
  return parts.autonomy +
    // 落在自主性前言之后：两段都是「怎么干活」的开场，而且 `AUTONOMY` 自带尾部空行，
    // 这个位置不需要任何额外的分隔处理。
    craftRulesFor(parts.craft) +
    parts.completion +
    parts.direction +
    parts.teamPreamble +
    parts.reviewProtocol +
    (parts.handoffNotice ? `${parts.handoffNotice}\n\n` : "") +
    parts.peerNotice +
    parts.objective;
}
