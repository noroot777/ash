// 「N 条记录」里每一条前面那枚图标，以及通用档里几句换成人话的说法。
//
// 有专门类型的那几类（审查、验收、哨兵起停……）图标和说法都在 timelineNoticeCopy 的 switch 里
// 直接给；这里管的是没有专门类型的那一大片——服务端的 `receipt` / `alert` 通用档、以及类型出现
// 之前落盘的老记录。图标跟检查器里同一件事的那一格用同一枚（哨兵 = 哨兵格的那枚），看见图标
// 就知道该去哪一格看。
import type { ReviewWaitReason } from "@ash/shared/timeline-notice";

export type NoticeIcon =
  | "monitor" | "review" | "dispute" | "accept" | "gate" | "preview" | "workflow"
  | "branch" | "workspace" | "message" | "executor" | "pause" | "command" | "alert" | "info";

/**
 * 按这一句的主语认图标：几类说法谁在句子里**最先**出现就归谁（「合并结果审查……」归验收，
 * 「这一轮尚未送达审查输入」归审查）。只看句首那一截（调用方给的是短句 / 标题），引在后面的
 * 描述、命令不参与。同一位置撞上时按下表顺序（「验收前置命令」先认成门禁，不认成验收）。
 */
const SUBJECTS: readonly [NoticeIcon, RegExp][] = [
  ["monitor", /哨兵/],
  ["dispute", /辩论|驳回|裁定/],
  ["preview", /预览/],
  ["gate", /验收前置命令|门禁/],
  ["review", /审查|验证|复审|修复/],
  ["workflow", /这条线|这一站|等我点头|线上写的/],
  ["accept", /验收|合并|合入|提交|标签/],
  ["branch", /分支|基线/],
  ["workspace", /工作区|工作目录|worktree|清理|归档/],
  ["message", /消息|引导|续聊|任务书/],
  ["executor", /执行器/],
  ["pause", /暂停|停止|中断|撤回|取消/],
  ["command", /命令/],
];

export function noticeIconOf(head: string, fallback: NoticeIcon): NoticeIcon {
  let best: { icon: NoticeIcon; at: number } | null = null;
  for (const [icon, pattern] of SUBJECTS) {
    const at = head.search(pattern);
    if (at >= 0 && (!best || at < best.at)) best = { icon, at };
  }
  return best?.icon ?? fallback;
}

// ── 哨兵与收工 ──

export const monitorStartedText = (description: string) => `派了哨兵在后台等：${description}`;
export const monitorFinishedText = (description: string) => `哨兵等完了：${description}`;
export const monitorReleasedText = (description: string, finished: boolean) =>
  `不再等哨兵「${description}」了${finished ? "，它已经跑完" : ""}`;

/** 想收工却被哨兵拦下、这一轮改成暂停（complete.held）。 */
export function completeHeldText(after: "pending" | "new-monitor"): string {
  return after === "new-monitor" ? "收工之后又派了哨兵，先暂停等它回来" : "哨兵的结果还没收到，先不收工，暂停等它";
}

// ── 预约的审查在等什么 ──

const WAITING_FOR: Record<ReviewWaitReason, string> = {
  monitor: "哨兵还没把结果带回来",
  question: "任务在等你答复",
  checkpoint: "任务停在半路等续跑",
  queued: "还有排队消息没发完",
  busy: "这一轮还在跑",
  unsettled: "上一轮没有正常收尾",
  dispute: "驳回还在等你裁定",
};

export const reviewWaitingText = (why: ReviewWaitReason) => `预约的审查先不开始：${WAITING_FOR[why]}`;

/** 老记录只有原文里那半句原因：按它认回是哪一种，认不出就照登那半句。 */
const LEGACY_WAIT: readonly [ReviewWaitReason, RegExp][] = [
  ["monitor", /哨兵/],
  ["dispute", /驳回|裁定/],
  ["question", /答复/],
  ["checkpoint", /检查点/],
  ["queued", /排队消息/],
  ["busy", /有回合在进行/],
  ["unsettled", /没有正常结束|被停止|异常结束|未确认完成|等待执行或暂停/],
];

function legacyWaiting(reason: string): string {
  const why = LEGACY_WAIT.find(([, pattern]) => pattern.test(reason))?.[0];
  return why ? reviewWaitingText(why) : `预约的审查先不开始：${reason}`;
}

// ── 通用档里换成人话的那几句 ──

type Plain = { icon: NoticeIcon; text: string };

/**
 * 原文是写给 agent / 排障看的（「终态」「检查点」「门禁交接」），摆给人看要换一句。只认句首，
 * 认不出的交回调用方按原文截一句。
 */
const PLAIN: readonly [RegExp, (match: RegExpExecArray) => Plain][] = [
  [/^(本回合要落的终态被拦下|完成确认当时因 MCP 通道中断没能送达，补录时被哨兵闸拦下)/,
    () => ({ icon: "monitor", text: completeHeldText("pending") })],
  [/^已撤掉本回合的完成确认：挂上哨兵/, () => ({ icon: "monitor", text: completeHeldText("new-monitor") })],
  [/^本回合撤掉 (\d+) 个哨兵后确认完成/, (m) => ({ icon: "monitor", text: `撤掉 ${m[1]} 个哨兵后收工` })],
  [/^(续跑交代没能放回任务行|那条哨兵事件带走的续跑交代没有放回任务行)/,
    () => ({ icon: "monitor", text: "哨兵叫醒它之后要接着做什么，没能记回任务上" })],
  [/^哨兵已起：(.+?)（/, (m) => ({ icon: "monitor", text: monitorStartedText(m[1]!) })],
  [/^哨兵结束：(.+?)[。（]/, (m) => ({ icon: "monitor", text: monitorFinishedText(m[1]!) })],
  [/^预约审查仍在等待：(.+?)。预约已保留/, (m) => ({ icon: "review", text: legacyWaiting(m[1]!) })],
  [/^门禁交接失败/, () => ({ icon: "gate", text: "验收前置命令没过，但修复要求没能交给任务" })],
  [/^门禁交接：已叫醒/, () => ({ icon: "gate", text: "验收前置命令没过，已叫醒任务去修" })],
  [/^门禁交接：修复输入已持久入队/, () => ({ icon: "gate", text: "验收前置命令没过，修复要求排队等着交给任务" })],
  [/^门禁交接/, () => ({ icon: "gate", text: "验收前置命令没过，修复要求不确定送到没有" })],
  [/^冲突交接失败/, () => ({ icon: "accept", text: "合并有冲突，但没能叫醒任务去解" })],
  [/^冲突交接/, () => ({ icon: "accept", text: "合并有冲突，已叫醒任务去解" })],
];

export function plainPhrase(raw: string): Plain | null {
  const flat = raw.replace(/\s+/g, " ").trim();
  for (const [pattern, say] of PLAIN) {
    const match = pattern.exec(flat);
    if (match) return say(match);
  }
  return null;
}
