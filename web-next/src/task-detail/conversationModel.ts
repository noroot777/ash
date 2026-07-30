import type { ServerEvent, Session, Task } from "@harness/shared";
import { parseSessionOutput } from "@harness/shared";
import { formatInstant, parseAttachmentText } from "./utils.ts";

export type LiveAgentEvent = Extract<ServerEvent, { type: "agent.event" }>;

export type TimelineEntry =
  | { kind: "user"; id: string; text: string; attachments: string[]; at: string }
  | { kind: "server"; id: string; event: LiveAgentEvent };

export type AgentAuxEvent = {
  kind: "tool" | "thinking" | "error";
  label: string;
  detail?: string;
};

export type ConversationItem =
  | {
      kind: "agent";
      id: string;
      sessionId: string;
      label: string;
      at?: string | null;
      endedAt?: string | null;
      session?: Session;
      markdown: string;
      events: AgentAuxEvent[];
    }
  | { kind: "user"; id: string; text: string; attachments: string[]; at?: string }
  | { kind: "event"; id: string; text: string; at?: string; tone?: "neutral" | "error" };

export type PersistedConversation = { session: Session; output: string };

type ConversationEventItem = Extract<ConversationItem, { kind: "event" }>;

function agentLabel(session: Session | undefined, event?: LiveAgentEvent): string {
  if (session?.executor) return session.executor;
  return event?.agentType ?? session?.agentType ?? "执行者";
}

function appendAgent(
  items: ConversationItem[],
  event: LiveAgentEvent,
  sessions: Session[],
): Extract<ConversationItem, { kind: "agent" }> {
  const session = sessions.find((candidate) => candidate.id === event.sessionId);
  const last = items[items.length - 1];
  if (last?.kind === "agent" && last.sessionId === event.sessionId) return last;
  const item: Extract<ConversationItem, { kind: "agent" }> = {
    kind: "agent",
    id: `live:${event.sessionId}:${items.length}`,
    sessionId: event.sessionId,
    label: agentLabel(session, event),
    at: session?.startedAt,
    endedAt: session?.endedAt,
    session,
    markdown: "",
    events: [],
  };
  items.push(item);
  return item;
}

function appendEvent(items: ConversationItem[], item: ConversationEventItem): void {
  const last = items[items.length - 1];
  if (
    last?.kind === "event"
    && last.text === item.text
    && last.at === item.at
    && last.tone === item.tone
  ) return;
  items.push(item);
}

export function buildConversationItems(
  persisted: PersistedConversation[],
  sessions: Session[],
  timeline: TimelineEntry[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const cliSessionIds = new Map<string, string>();
  const ordered = [...persisted].sort((left, right) =>
    left.session.startedAt.localeCompare(right.session.startedAt));

  for (const { session, output } of ordered) {
    const segments = parseSessionOutput(output);
    segments.forEach((segment, index) => {
      if (segment.kind === "user") {
        items.push({
          kind: "user",
          id: `persisted:user:${session.id}:${index}`,
          text: segment.text,
          attachments: [],
          at: segment.at,
        });
      } else if (segment.kind === "system") {
        items.push({
          kind: "event",
          id: `persisted:system:${session.id}:${index}`,
          text: segment.text,
          at: segment.at,
        });
      } else {
        items.push({
          kind: "agent",
          id: `persisted:agent:${session.id}:${index}`,
          sessionId: session.id,
          label: agentLabel(session),
          at: session.startedAt,
          endedAt: segment.endedAt ?? session.endedAt,
          session,
          markdown: segment.text,
          events: [],
        });
      }
    });
  }

  for (const entry of timeline) {
    if (entry.kind === "user") {
      items.push({
        kind: "user",
        id: entry.id,
        text: entry.text,
        attachments: entry.attachments,
        at: entry.at,
      });
      continue;
    }
    const event = entry.event.event;
    if (event.kind === "system") {
      appendEvent(items, { kind: "event", id: entry.id, text: event.text });
      continue;
    }
    if (event.kind === "done") {
      appendEvent(items, {
        kind: "event",
        id: entry.id,
        text: event.exitStatus === 0 ? "本轮执行结束" : `执行异常结束 · exit ${event.exitStatus}`,
        tone: event.exitStatus === 0 ? "neutral" : "error",
      });
      continue;
    }
    if (event.kind === "turnEnd") {
      appendEvent(items, { kind: "event", id: entry.id, text: "本回合结束，等待下一条消息" });
      continue;
    }
    if (event.kind === "session") {
      if (cliSessionIds.get(entry.event.sessionId) === event.cliSessionId) continue;
      cliSessionIds.set(entry.event.sessionId, event.cliSessionId);
      items.push({ kind: "event", id: entry.id, text: `会话已连接 · ${event.cliSessionId}` });
      continue;
    }
    const agent = appendAgent(items, entry.event, sessions);
    if (event.kind === "text") agent.markdown += event.text;
    if (event.kind === "tool") agent.events.push({ kind: "tool", label: event.name, detail: event.detail });
    if (event.kind === "thinking") agent.events.push({ kind: "thinking", label: "思考过程", detail: event.text });
    if (event.kind === "error") agent.events.push({ kind: "error", label: event.message });
  }
  return items;
}

export function conversationToMarkdown(items: ConversationItem[], task: Task): string {
  const parts = [`# ${task.title || "未命名任务"}`];
  if (task.body.trim()) parts.push(`> ${task.body.trim().replace(/\n/g, "\n> ")}`);
  for (const item of items) {
    if (item.kind === "event") {
      parts.push(`_${item.text}${item.at ? ` · ${formatInstant(item.at)}` : ""}_`);
      continue;
    }
    if (item.kind === "user") {
      const parsed = parseAttachmentText(item.text);
      const paths = [...parsed.paths, ...item.attachments];
      const body = [parsed.body, ...paths.map((path) => `- ${path}`)].filter(Boolean).join("\n");
      if (body) parts.push(`## 你${item.at ? ` · ${formatInstant(item.at)}` : ""}\n\n${body}`);
      continue;
    }
    const body = item.markdown.trim();
    if (body) parts.push(`## ${item.label}${item.at ? ` · ${formatInstant(item.at)}` : ""}\n\n${body}`);
  }
  return `${parts.join("\n\n")}\n`;
}
