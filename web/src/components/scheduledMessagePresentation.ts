import type { ScheduledMessage, TaskListItem } from "@ash/shared";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { isUserAuthoredMessage } from "@ash/shared/scheduled-message-author";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";
import { scheduledWaitText } from "@ash/shared/scheduled-message-wait";
import { sendAfterState } from "../lib/sendAfter.ts";
import { formatInstant } from "../task-detail/utils.ts";

/**
 * 这条待发送输入是谁放进队列的 —— 托盘那一行的来源、措辞和「能对它做什么」全看这一个判定。
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
  // 「mine」跟服务端引导找队首用的是同一个判定,托盘挂按钮的那条服务端一定认。
  if (isUserAuthoredMessage(message)) return "mine";
  if (monitorIdFromOrigin(message.origin) !== null) return "monitor";
  // sessionRole 排在泛化的 origin 之前:它是前端认得的具体语义(投进审查会话),
  // 而剩下的 origin 按定义是「这里不认识的来源」。
  return message.sessionRole ? "managed" : "system";
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

/** 退出码非零的哨兵输入:托盘那一行上「N 条要留意」数的就是这些。 */
export function scheduledMessageNeedsAttention(message: ScheduledMessage): boolean {
  const exitCode = scheduledMessageExitCode(message);
  return exitCode !== null && exitCode !== 0;
}

/**
 * 这一条自己在等什么,写在它那一行的「什么时候发」一格:定时的写时刻,等前置任务的写在等谁,
 * 排在这一轮后面的照服务端下发的 `wait` 说(server/src/pending-wait.ts)。说不出原因(没有挡着它
 * 的东西、旧服务端没带)就空着,不拿「等待当前一轮结束」顶上。
 */
export function scheduledMessageWhen(message: ScheduledMessage, tasks?: TaskListItem[]): { text: string | null; stuck: boolean } {
  if (message.mode === "timed") return { text: `${formatInstant(message.sendAt)} 发`, stuck: false };
  if (message.mode === "after") {
    const after = sendAfterState(tasks ? tasks.find((task) => task.id === message.afterTaskId)
      : { title: "前置任务", status: "running", archived: false }, message.afterDoneAt);
    return { text: after.label, stuck: after.stuck };
  }
  return { text: scheduledWaitText(message.wait), stuck: false };
}
