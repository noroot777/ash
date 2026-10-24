import type { ScheduledMessage } from "@ash/shared";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";

export type ScheduledMessageFilter = "all" | "mine" | "monitor" | "managed" | "attention";

export function bySendTime(messages: ScheduledMessage[]): ScheduledMessage[] {
  return [...messages].sort((left, right) => left.sendAt.localeCompare(right.sendAt)
    || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function scheduledMessageText(message: ScheduledMessage): string {
  return annotationBatchDisplayText(message.text) ?? message.text;
}

export function scheduledMessageExitCode(message: ScheduledMessage): number | null {
  if (!message.origin) return null;
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
  if (filter === "monitor") return !!message.origin;
  if (filter === "managed") return !message.origin && !!message.sessionRole;
  return !message.origin && !message.sessionRole;
}

export function scheduledMessageCounts(messages: ScheduledMessage[]): Record<ScheduledMessageFilter, number> {
  return {
    all: messages.length,
    mine: messages.filter((message) => scheduledMessageMatches(message, "mine")).length,
    monitor: messages.filter((message) => scheduledMessageMatches(message, "monitor")).length,
    managed: messages.filter((message) => scheduledMessageMatches(message, "managed")).length,
    attention: messages.filter((message) => scheduledMessageMatches(message, "attention")).length,
  };
}
