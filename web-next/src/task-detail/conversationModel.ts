import type { AgentEvent, ContextUsage, ServerEvent, Session, Task, TokenUsage } from "@harness/shared";
import { ANSWER_PREFIX, parseSessionOutput } from "@harness/shared";
import { addUsage, sumUsage, usageTotal } from "@harness/shared/usage";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ExecutionEvent } from "../lib/executionTrace.ts";
import { formatInstant, parseAttachmentText } from "./utils.ts";

export type LiveAgentEvent = Extract<ServerEvent, { type: "agent.event" }>;

export type TimelineEntry =
  | { kind: "user"; id: string; text: string; attachments: string[]; at: string; isAnswer?: boolean }
  | { kind: "server"; id: string; event: LiveAgentEvent; receivedAt?: string };

// 「执行过程」块里的一行(工具 / 思考 / 异常)。形状与渲染都归 lib/executionTrace,
// 普通任务、团队、辩论共用同一份 —— 这里只保留旧名字的别名。
export type AgentAuxEvent = ExecutionEvent;

export type AgentContentSegment = {
  id: string;
  markdown: string;
  events: AgentAuxEvent[];
};

export type ConversationItem =
  | {
      kind: "agent";
      id: string;
      sessionId: string;
      label: string;
      at?: string | null;
      endedAt?: string | null;
      markerEndedAt?: string | null;
      showSessionMeta?: boolean;
      session?: Session;
      /** 这一回合的 token 用量。null = 这家 CLI 不报账、或这轮跑在本功能之前。 */
      usage?: TokenUsage | null;
      /** 整条会话至今的累计用量。只挂在显示 SessionMeta 的那条气泡上。 */
      sessionUsage?: TokenUsage | null;
      /** 整条会话此刻的上下文水位（跟累计用量是两回事）。同样只挂在那条气泡上。 */
      sessionContext?: ContextUsage | null;
      markdown: string;
      segments: AgentContentSegment[];
    }
  | { kind: "user"; id: string; text: string; attachments: string[]; at?: string; isAnswer?: boolean; bySystem?: boolean }
  | { kind: "event"; id: string; text: string; at?: string; tone?: "neutral" | "error" };

export type PersistedConversation = { session: Session; output: string; trace?: SessionTraceEntry[] };

type ConversationEventItem = Extract<ConversationItem, { kind: "event" }>;
type AgentTraceEvent = Extract<AgentEvent, { kind: "thinking" | "tool" | "error" }>;
type TracedContentEntry = SessionTraceEntry & {
  event: Exclude<SessionTraceEntry["event"], { kind: "usage" }>;
};
type PersistedTurnTimes = Map<string, number[]>;
type SessionRunBounds = {
  endedAt: string | null;
  nextStartedAt: string | null;
  turnStartedAt: string | null;
};

const SNAPSHOT_DUPLICATE_WINDOW_MS = 30_000;
const compactTurnText = (text: string) => text.replace(/\s+/g, "");

function turnKey(kind: "user" | "system", text: string, sessionId?: string): string {
  return `${kind}\0${sessionId ?? ""}\0${compactTurnText(text)}`;
}

function recordPersistedTurn(
  turns: PersistedTurnTimes,
  kind: "user" | "system",
  text: string,
  at: string | undefined,
  sessionId?: string,
): void {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return;
  const key = turnKey(kind, text, sessionId);
  turns.set(key, [...(turns.get(key) ?? []), time]);
}

// A settled-status refresh can finish just after the same system/user turn was
// received over SSE. Keep the persisted copy and discard only the live copy
// whose arrival time is close to that exact persisted sentinel. The timestamp
// guard matters because idle-recycle notices legitimately repeat every 30 min.
function timelineAfterPersistedTurns(
  timeline: TimelineEntry[],
  persistedTurns: PersistedTurnTimes,
): TimelineEntry[] {
  const remaining = new Map([...persistedTurns].map(([key, times]) => [key, [...times]]));
  return timeline.filter((entry) => {
    const marker = entry.kind === "user"
      ? { key: turnKey("user", entry.text), at: entry.at }
      : entry.event.event.kind === "system" && entry.receivedAt
        ? { key: turnKey("system", entry.event.event.text, entry.event.sessionId), at: entry.receivedAt }
        : null;
    if (!marker) return true;
    const liveTime = Date.parse(marker.at);
    const candidates = remaining.get(marker.key);
    if (!Number.isFinite(liveTime) || !candidates?.length) return true;
    let nearest = 0;
    for (let index = 1; index < candidates.length; index += 1) {
      if (Math.abs(candidates[index]! - liveTime) < Math.abs(candidates[nearest]! - liveTime)) nearest = index;
    }
    if (Math.abs(candidates[nearest]! - liveTime) > SNAPSHOT_DUPLICATE_WINDOW_MS) return true;
    candidates.splice(nearest, 1);
    return false;
  });
}

function auxEvent(event: AgentTraceEvent): AgentAuxEvent {
  if (event.kind === "tool") return { kind: "tool", label: event.name, detail: event.detail };
  if (event.kind === "thinking") return { kind: "thinking", label: "思考过程", detail: event.text };
  return { kind: "error", label: event.message };
}

function groupedTrace(trace: SessionTraceEntry[]): Map<string, SessionTraceEntry[]> {
  const groups = new Map<string, SessionTraceEntry[]>();
  for (const entry of trace) {
    const current = groups.get(entry.turnStartedAt) ?? [];
    current.push(entry);
    groups.set(entry.turnStartedAt, current);
  }
  return groups;
}

function takeTraceGroup(
  groups: Map<string, SessionTraceEntry[]>,
  consumed: Set<string>,
  turnStartedAt: string,
): SessionTraceEntry[] {
  if (groups.has(turnStartedAt) && !consumed.has(turnStartedAt)) {
    consumed.add(turnStartedAt);
    return groups.get(turnStartedAt) ?? [];
  }
  // Older in-flight sessions may have written the user sentinel and run start a
  // few milliseconds apart. A small nearest-time fallback keeps that trace on
  // the correct turn without merging genuinely separate replies.
  const target = Date.parse(turnStartedAt);
  const nearest = [...groups.keys()]
    .filter((key) => !consumed.has(key))
    .map((key) => ({ key, distance: Math.abs(Date.parse(key) - target) }))
    .filter(({ distance }) => Number.isFinite(distance) && distance <= 2_000)
    .sort((left, right) => left.distance - right.distance)
    .at(0)?.key;
  if (!nearest) return [];
  consumed.add(nearest);
  return groups.get(nearest) ?? [];
}

// 这一回合报了多少 token。同一回合理论上只有一条(执行器每轮至多推一次),多条时
// 按累计处理,免得将来某家 CLI 分批报账时这里悄悄少算。
function traceUsage(entries: SessionTraceEntry[]): TokenUsage | null {
  return sumUsage(entries.map((entry) => (entry.event.kind === "usage" ? entry.event.usage : null)));
}

function contentSegments(
  traced: SessionTraceEntry[],
  fallbackMarkdown: string,
  idPrefix: string,
): AgentContentSegment[] {
  // usage 只是这一回合的账,不是执行过程的一步 —— 漏掉这道过滤它会被 auxEvent
  // 当成未知事件渲染成一行异常。
  const entries = traced.filter((entry): entry is TracedContentEntry => entry.event.kind !== "usage");
  const auxEntries = entries.filter((entry) => entry.event.kind !== "text");
  if (!entries.some((entry) => entry.event.kind === "text")) {
    return [{
      id: `${idPrefix}:0`,
      markdown: fallbackMarkdown,
      events: auxEntries.map((entry) => auxEvent(entry.event as AgentTraceEvent)),
    }];
  }

  const segments: AgentContentSegment[] = [];
  let current: AgentContentSegment = { id: `${idPrefix}:0`, markdown: "", events: [] };
  const pushCurrent = () => {
    if (!current.markdown && !current.events.length) return;
    segments.push(current);
    current = { id: `${idPrefix}:${segments.length}`, markdown: "", events: [] };
  };
  for (const entry of entries) {
    if (entry.event.kind === "text") {
      current.markdown += entry.event.text;
      continue;
    }
    if (current.markdown) pushCurrent();
    current.events.push(auxEvent(entry.event));
  }
  pushCurrent();

  const structuredMarkdown = segments.map((segment) => segment.markdown).join("");
  if (structuredMarkdown.trim() === fallbackMarkdown.trim()) return segments;
  // Partially written/legacy trace is still useful, but it cannot safely split
  // the body. Keep one process block with the intact Markdown rather than drop or
  // duplicate text.
  return [{
    id: `${idPrefix}:fallback`,
    markdown: fallbackMarkdown || structuredMarkdown,
    events: auxEntries.map((entry) => auxEvent(entry.event as AgentTraceEvent)),
  }];
}

function currentSegment(agent: Extract<ConversationItem, { kind: "agent" }>): AgentContentSegment {
  const existing = agent.segments.at(-1);
  if (existing) return existing;
  const created = { id: `${agent.id}:segment:0`, markdown: "", events: [] };
  agent.segments.push(created);
  return created;
}

function appendAgentText(agent: Extract<ConversationItem, { kind: "agent" }>, text: string): void {
  agent.markdown += text;
  currentSegment(agent).markdown += text;
}

function appendAgentAux(agent: Extract<ConversationItem, { kind: "agent" }>, event: AgentTraceEvent): void {
  let segment = currentSegment(agent);
  if (segment.markdown) {
    segment = { id: `${agent.id}:segment:${agent.segments.length}`, markdown: "", events: [] };
    agent.segments.push(segment);
  }
  segment.events.push(auxEvent(event));
}

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
    endedAt: null,
    markerEndedAt: null,
    session,
    usage: null,
    markdown: "",
    segments: [],
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

function inferredRunEnd(itemAt: string | null | undefined, bounds?: SessionRunBounds): string | null {
  if (!bounds) return null;
  if (bounds.endedAt) return bounds.endedAt;
  // A reusable session can resume after another @-mentioned agent opened a
  // later session. Its current turn must stay live; the later session start is
  // only a safe legacy end fallback for older turns on this session row.
  const itemTime = itemAt ? Date.parse(itemAt) : Number.NaN;
  const turnTime = bounds.turnStartedAt ? Date.parse(bounds.turnStartedAt) : Number.NaN;
  if (Number.isFinite(itemTime) && Number.isFinite(turnTime) && itemTime >= turnTime) return null;
  return bounds.nextStartedAt;
}

function latestTurnStart(session: Session): string | null {
  if (!("turnStartedAt" in session)) return null;
  return typeof session.turnStartedAt === "string" ? session.turnStartedAt : null;
}

function conversationItemTime(item: ConversationItem): number {
  const parsed = item.at ? Date.parse(item.at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function buildConversationItems(
  persisted: PersistedConversation[],
  sessions: Session[],
  timeline: TimelineEntry[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const persistedTurns: PersistedTurnTimes = new Map();
  const ordered = [...persisted].sort((left, right) =>
    left.session.startedAt.localeCompare(right.session.startedAt));

  for (const { session, output, trace = [] } of ordered) {
    const segments = parseSessionOutput(output);
    const traceGroups = groupedTrace(trace);
    const consumedTrace = new Set<string>();
    let turnStartedAt = session.startedAt;
    segments.forEach((segment, index) => {
      if (segment.kind === "user") {
        recordPersistedTurn(persistedTurns, "user", segment.text, segment.at);
        items.push({
          kind: "user",
          id: `persisted:user:${session.id}:${index}`,
          text: segment.text,
          attachments: [],
          at: segment.at,
          isAnswer: segment.text.startsWith(ANSWER_PREFIX),
          // 后端代写、占着真人回合的那种（验证打回、验收冲突）。照常渲染成 user 气泡，
          // 但「后续追问」不收它 —— 判据统一在 shared 的 isUserFollowUp。
          bySystem: segment.bySystem,
        });
        turnStartedAt = segment.at ?? turnStartedAt;
      } else if (segment.kind === "system") {
        recordPersistedTurn(persistedTurns, "system", segment.text, segment.at, session.id);
        items.push({
          kind: "event",
          id: `persisted:system:${session.id}:${index}`,
          text: segment.text,
          at: segment.at,
        });
        turnStartedAt = segment.at ?? turnStartedAt;
      } else {
        const traceEntries = takeTraceGroup(traceGroups, consumedTrace, turnStartedAt);
        items.push({
          kind: "agent",
          id: `persisted:agent:${session.id}:${index}`,
          sessionId: session.id,
          label: agentLabel(session),
          at: turnStartedAt,
          endedAt: null,
          markerEndedAt: segment.endedAt ?? null,
          session,
          usage: traceUsage(traceEntries),
          markdown: segment.text,
          segments: contentSegments(traceEntries, segment.text, `persisted:segment:${session.id}:${index}`),
        });
      }
    });
    // A failed turn can contain only tools/errors and no assistant prose. Keep
    // its execution block visible instead of dropping the persisted trace.
    for (const [traceTurn, entries] of traceGroups) {
      if (consumedTrace.has(traceTurn)) continue;
      const segments = contentSegments(entries, "", `persisted:trace-segment:${session.id}:${traceTurn}`);
      items.push({
        kind: "agent",
        id: `persisted:trace:${session.id}:${traceTurn}`,
        sessionId: session.id,
        label: agentLabel(session),
        at: traceTurn,
        endedAt: null,
        markerEndedAt: null,
        session,
        usage: traceUsage(entries),
        markdown: segments.map((segment) => segment.markdown).join(""),
        segments,
      });
    }
  }

  // Sessions are reusable and can overlap: an older Claude session may resume
  // after a newer @codex session has already finished. Grouping by session would
  // pin that new Claude turn above Codex forever after refresh, so establish the
  // persisted timeline by each turn's own timestamp before live arrivals append.
  items.sort((left, right) => conversationItemTime(left) - conversationItemTime(right));

  // 直播里报上来的上下文水位，按会话取最后一条（覆盖语义，见 shared/src/usage.ts）。
  const liveContext = new Map<string, ContextUsage>();
  for (const entry of timelineAfterPersistedTurns(timeline, persistedTurns)) {
    if (entry.kind === "user") {
      items.push({
        kind: "user",
        id: entry.id,
        text: entry.text,
        attachments: entry.attachments,
        at: entry.at,
        isAnswer: entry.isAnswer,
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
    // session 是执行器的内部簿记事件(心跳/回合结束都会重发),旧 UI 就不渲染;
    // cliSessionId 已经在会话详情/恢复按钮那里可查,会话流里不展示。
    if (event.kind === "session") continue;
    const agent = appendAgent(items, entry.event, sessions);
    if (event.kind === "text") appendAgentText(agent, event.text);
    // 用量恒在本回合的 turnEnd/done 之前到，所以它落在的就是刚说完话的那条气泡。
    if (event.kind === "usage") agent.usage = agent.usage ? addUsage(agent.usage, event.usage) : event.usage;
    // 水位是覆盖不是累加：后到的那条就是此刻，跟它前面报过什么无关。
    if (event.kind === "context") liveContext.set(entry.event.sessionId, event.context);
    if (event.kind === "tool" || event.kind === "thinking" || event.kind === "error") {
      appendAgentAux(agent, event);
    }
  }

  const orderedSessions = [...sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const runBounds = new Map<string, SessionRunBounds>();
  orderedSessions.forEach((session, index) => {
    runBounds.set(session.id, {
      endedAt: session.endedAt,
      nextStartedAt: orderedSessions[index + 1]?.startedAt ?? null,
      turnStartedAt: latestTurnStart(session),
    });
  });

  let previousInterjectionAt: string | null = null;
  const seenSessions = new Set<string>();
  for (const item of items) {
    if (item.kind === "user" || item.kind === "event") previousInterjectionAt = item.at ?? previousInterjectionAt;
    if (item.kind !== "agent") continue;
    const firstTurn = !seenSessions.has(item.sessionId);
    seenSessions.add(item.sessionId);
    const turnStartedAt = item.session ? latestTurnStart(item.session) : null;
    item.at = firstTurn
      ? item.session?.startedAt ?? item.at
      : item.at === item.session?.startedAt && turnStartedAt
        ? turnStartedAt
        : previousInterjectionAt ?? item.session?.startedAt ?? item.at;
  }

  let nextInterjectionAt: string | null = null;
  let rightSessionId: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "user" || item.kind === "event") nextInterjectionAt = item.at ?? nextInterjectionAt;
    if (item.kind !== "agent") continue;
    if (item.sessionId !== rightSessionId) {
      nextInterjectionAt = null;
      rightSessionId = item.sessionId;
    }
    item.endedAt = item.markerEndedAt
      ?? nextInterjectionAt
      ?? inferredRunEnd(item.at, runBounds.get(item.sessionId));
  }

  // 会话累计有两个来源：sessions 行是服务端账本（权威、跨刷新），但它要等下一次
  // 拉取才带上刚结束的这一轮；直播时客户端手上的"各轮之和"反而更新。取总量大的
  // 那个，数字就只会往前走，不会在回合结束的那一瞬先缩回去。
  const sessionTurnTotals = new Map<string, TokenUsage>();
  for (const item of items) {
    if (item.kind !== "agent" || !item.usage) continue;
    const previous = sessionTurnTotals.get(item.sessionId);
    sessionTurnTotals.set(item.sessionId, previous ? addUsage(previous, item.usage) : item.usage);
  }

  const sessionMetaSeen = new Set<string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "agent") continue;
    item.showSessionMeta = !sessionMetaSeen.has(item.sessionId);
    sessionMetaSeen.add(item.sessionId);
    if (!item.showSessionMeta) continue;
    const persisted = item.session?.usage ?? null;
    const live = sessionTurnTotals.get(item.sessionId) ?? null;
    item.sessionUsage = !persisted || (live && usageTotal(live) > usageTotal(persisted)) ? live : persisted;
    // 水位不比大小：直播时刚报的那条就是最新，会话行上那份要等下次拉取才跟上。
    item.sessionContext = liveContext.get(item.sessionId) ?? item.session?.context ?? null;
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
