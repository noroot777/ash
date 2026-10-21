import type { ConversationItem } from "./conversationModel.ts";

export type MonitorWakeEvent = {
  kind: "output" | "ended";
  source: string;
  monitorId: string | null;
  body: string;
};

export type MonitorWakeInput = {
  events: MonitorWakeEvent[];
  reason: string;
  source: string;
  historyTruncated: boolean;
  hasCheckpoint: boolean;
};

const HEADER = /^【哨兵(事件|结束)(?:\s*·\s*([^】]*))?】([^\n]*)/gm;
const IDENTITY = /[（(]monitorId=([^）)\s]+)[）)]/;
const TRUNCATED = /^（更早的 \d+ 个字符已略去，完整输出在哨兵的日志文件里）\r?\n/;
const CHECKPOINT = /^【你当初留下的续跑交代】/m;

export function monitorWakeInput(item: ConversationItem): MonitorWakeInput | null {
  if (item.kind !== "user" || !item.bySystem || item.isAnswer) return null;
  const text = item.text.trimStart();
  const historyTruncated = TRUNCATED.test(text);
  if (!historyTruncated && !/^【哨兵(?:事件|结束)(?:\s*·[^】]*)?】/.test(text)) return null;
  const checkpointIndex = text.search(CHECKPOINT);
  const eventText = checkpointIndex < 0 ? text : text.slice(0, checkpointIndex);
  const headers = [...eventText.matchAll(HEADER)].filter((header, index) => index === 0 || IDENTITY.test(`${header[2] ?? ""}${header[3]}`));
  if (!headers.length) return null;

  const events = headers.map((header, index): MonitorWakeEvent => {
    const description = `${header[2] ?? ""}${header[3]}`;
    const identity = IDENTITY.exec(description);
    const source = (identity ? description.slice(0, identity.index) : header[2] ?? description).trim();
    const inlineBody = identity ? description.slice(identity.index + identity[0].length).replace(/^[\s，,。:：]+/, "") : "";
    const followingBody = eventText.slice(header.index! + header[0].length, headers[index + 1]?.index ?? eventText.length).trim();
    return {
      kind: header[1] === "结束" ? "ended" : "output",
      source: source || "未标注名称的哨兵",
      monitorId: identity?.[1] ?? null,
      body: [inlineBody, followingBody].filter(Boolean).join("\n"),
    };
  });
  const sources = [...new Set(events.map((event) => event.source))];
  const latest = events.at(-1)!;
  const reason = events.length > 1
    ? `收到 ${historyTruncated ? "至少 " : ""}${events.length} 条哨兵消息，合并为一次输入。`
    : latest.kind === "ended"
      ? "哨兵已结束，唤起会话核对结果。"
      : "收到哨兵的新输出，唤起会话继续处理。";
  return {
    events,
    reason,
    source: sources.length > 1 ? `${latest.source} 等 ${sources.length} 个哨兵` : latest.source,
    historyTruncated,
    hasCheckpoint: checkpointIndex >= 0,
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
