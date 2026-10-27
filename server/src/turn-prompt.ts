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
import { REPORT_SUMMARY_FORMAT, REPORT_SUMMARY_REMINDER } from "./review-report-format.js";

/**
 * 正文**自己已经把那份契约讲过了**吗？
 *
 * 会跟每回合提醒撞车的正文有两类，判据各取它带的那一版报告格式契约：
 * - **整份协议**（自由派审 `freeReviewPrompt`、就地验证 `verifyProtocolFor`、历史独立
 *   审查 `reviewProtocolFor`）带完整版 `REPORT_SUMMARY_FORMAT`；
 * - **断线续跑那句话**（`freeReviewResumeMessage`）带缩略版 `REPORT_SUMMARY_REMINDER`，
 *   跟提醒几乎逐字相同（实测首次派审与续跑两条投递消息里，报告格式、扫描义务各出现
 *   两遍 —— 第 1 轮审查 F2）。
 *
 * 判据取「正文里有没有这份契约」，而不是给每个投递点加一个布尔开关：开关会被下一个新
 * 投递点忘掉（`server/CLAUDE.md`「对称端点只改了一个」那一类），而这条判据对任何自带
 * 契约的正文自动成立。
 *
 * 丢的只是**那段文字**：提醒仍照常被算出来（它顺带刷新本轮的回归证据清单），所以这条
 * 去重不改变任何落盘副作用。
 */
export function protocolAlreadyInBody(userText: string): boolean {
  return userText.includes(REPORT_SUMMARY_FORMAT) || userText.includes(REPORT_SUMMARY_REMINDER);
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
  /** 由任务状态派生的审查/验证提醒；正文已自带整份协议时**整条丢掉**。 */
  reviewReminder: string;
}

export function assembleTurnPrompt(parts: TurnPromptParts): string {
  const reminder = protocolAlreadyInBody(parts.userText) ? "" : parts.reviewReminder;
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
