import type { ScheduledMessage } from "@ash/shared";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";

export type ScheduledMessageFilter = "all" | "mine" | "monitor" | "managed" | "system" | "attention";

/**
 * 这条待发送输入是谁放进队列的 —— 托盘的图标、标签、措辞和「能对它做什么」全看这一个判定。
 *
 * `origin` 不是「是不是哨兵」的同义词:这个字段早期只有哨兵唤醒在写,后来审查结算的修复
 * 交接、检查点续跑也开始写它。原先的 `!!message.origin` 于是把一条审查交接标成了哨兵,
 * 还给它配上「取消这次唤醒 / 不执行停止哨兵操作」的措辞(2026-10-31 实例:任务 CKjeps4QSRTE
 * 的 review-repair-dde14804…,origin=review-settlement:…)。
 *
 * 真哨兵一律走后端同一个 `monitorIdFromOrigin`(`server/src/pending-dispatch.ts` 就是用它判的),
 * 前端不再自己拼前缀。**认不出来的 origin 落到中性的 `system`**,而不是沿用哨兵那一套:
 * 下一种 origin 加进来时托盘最多少说一句,不会再说错。
 */
export type ScheduledMessageSource = "mine" | "monitor" | "managed" | "system";

export function scheduledMessageSource(message: ScheduledMessage): ScheduledMessageSource {
  if (monitorIdFromOrigin(message.origin) !== null) return "monitor";
  // sessionRole 排在泛化的 origin 之前:它是前端认得的具体语义(投进审查会话),
  // 而剩下的 origin 按定义是「这里不认识的来源」。
  if (message.sessionRole) return "managed";
  return message.origin ? "system" : "mine";
}

export function bySendTime(messages: ScheduledMessage[]): ScheduledMessage[] {
  return [...messages].sort((left, right) => left.sendAt.localeCompare(right.sendAt)
    || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function scheduledMessageText(message: ScheduledMessage): string {
  return annotationBatchDisplayText(message.text) ?? message.text;
}

export function scheduledMessageSummary(message: ScheduledMessage): string {
  const text = scheduledMessageText(message).trim();
  // 用户自己打的字整条压成一行;机器排进来的那几种是整段提示词/日志,只摘第一行。
  if (!message.origin) return text.replace(/\s+/g, " ");
  const first = text.split(/\r?\n/, 1)[0]!;
  // 下面这几刀是哨兵事件的格式,只许用在真哨兵上 —— 别的来源第一行里凑巧出现
  // 「(monitorId=…)」或「退出码 N」时不该被当成哨兵格式切掉。
  if (scheduledMessageSource(message) !== "monitor") return first.trim();
  return first
    .replace(/^【哨兵(?:事件|结束|已起)】\s*/, "")
    .replace(/\s*[（(]monitorId=[^）)]+[）)].*$/, "")
    .replace(/[，,]\s*退出码\s+-?\d+.*$/, "")
    .trim();
}

export function scheduledMessageExitCode(message: ScheduledMessage): number | null {
  // 退出码是哨兵独有的概念。审查交接这类消息正文里也可能引着一段 REGRESSION_FINISHED
  // 日志,按它给出「exit N」会凭空多出一条「需留意」。
  if (scheduledMessageSource(message) !== "monitor") return null;
  const regression = message.text.matchAll(/^REGRESSION_FINISHED\b[^\n]*\bexitCode=(-?\d+)\b/gm);
  const ended = message.text.matchAll(/^【哨兵结束】[^\n]*[，,]\s*退出码\s+(-?\d+)(?=[。，,\s]|$)/gm);
  const codes = [...regression, ...ended].map((match) => Number(match[1]));
  return codes.find((code) => code !== 0) ?? codes[0] ?? null;
}

export function scheduledMessageMatches(message: ScheduledMessage, filter: ScheduledMessageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") {
    const exitCode = scheduledMessageExitCode(message);
    return exitCode !== null && exitCode !== 0;
  }
  return scheduledMessageSource(message) === filter;
}

export function scheduledMessageCounts(messages: ScheduledMessage[]): Record<ScheduledMessageFilter, number> {
  return {
    all: messages.length,
    mine: messages.filter((message) => scheduledMessageMatches(message, "mine")).length,
    monitor: messages.filter((message) => scheduledMessageMatches(message, "monitor")).length,
    managed: messages.filter((message) => scheduledMessageMatches(message, "managed")).length,
    system: messages.filter((message) => scheduledMessageMatches(message, "system")).length,
    attention: messages.filter((message) => scheduledMessageMatches(message, "attention")).length,
  };
}
