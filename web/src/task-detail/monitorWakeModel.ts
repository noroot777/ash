import { readMonitorWake, type MonitorWakeEvent } from "@ash/shared/monitor-wake";
import type { ConversationItem } from "./conversationModel.ts";

export type { MonitorWakeEvent } from "@ash/shared/monitor-wake";

export type MonitorWakeInput = {
  events: MonitorWakeEvent[];
  eventCount: number | null;
  reason: string;
  source: string | null;
  historyTruncated: boolean;
  hasCheckpoint: boolean;
};

export function monitorWakeInput(item: ConversationItem): MonitorWakeInput | null {
  if (item.kind !== "user" || !item.bySystem || item.isAnswer) return null;
  const data = readMonitorWake(item.monitorWake);
  if (!data) {
    if (!/^(?:（更早的 \d+ 个字符已略去，完整输出在哨兵的日志文件里）\r?\n)?【哨兵(?:事件|结束)(?:\s*·[^】]*)?】/.test(item.text.trimStart())) return null;
    return {
      events: [], eventCount: null, source: null, historyTruncated: false, hasCheckpoint: false,
      reason: "系统消息已作为新输入写入会话。",
    };
  }
  const sources = [...new Map(data.events.map((event) => [event.monitorId, event])).values()];
  const latest = data.events.at(-1)!;
  const sameName = sources.filter((event) => event.source === latest.source).length > 1;
  const name = sameName ? `${latest.source} [${latest.monitorId}]` : latest.source;
  const eventCount = data.events.length + data.omittedEvents;
  return {
    events: data.events,
    eventCount,
    reason: eventCount > 1
      ? `收到 ${eventCount} 条哨兵消息，合并为一次输入。`
      : latest.kind === "ended" ? "哨兵已结束，唤起会话核对结果。" : "收到哨兵的新输出，唤起会话继续处理。",
    source: sources.length > 1 ? `${name} 等${data.omittedEvents ? "至少" : ""} ${sources.length} 个哨兵` : name,
    historyTruncated: data.omittedEvents > 0 || data.events.some((event) => event.bodyTruncated),
    hasCheckpoint: !!data.checkpoint,
  };
}

export function monitorWakePreview(body: string): string {
  const lines = body.trim().split(/\r?\n/);
  const preview = lines.slice(0, 3).join("\n");
  return preview.length > 420 ? `${preview.slice(0, 420)}…` : `${preview}${lines.length > 3 ? "\n…" : ""}`;
}

export function monitorWakeReplyIds(items: readonly ConversationItem[]): Set<string> {
  const replies = new Set<string>();
  let pending = false;
  for (const item of items) {
    if (item.kind === "user") {
      pending = monitorWakeInput(item) !== null;
    } else if (item.kind === "event") {
      if (item.variant === "boundary" || item.verify) pending = false;
    } else if (pending) {
      replies.add(item.id);
      pending = false;
    }
  }
  return replies;
}
