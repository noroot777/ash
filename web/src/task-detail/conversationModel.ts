import type { AgentEvent, ContextUsage, ServerEvent, Session, TokenUsage } from "@ash/shared";
import { ANSWER_PREFIX, parseSessionOutput } from "@ash/shared";
import { addUsage, sumUsage, usageTotal } from "@ash/shared/usage";
import { normalizeSessionNoteText } from "@ash/shared/session-notes";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ExecutionEvent } from "../lib/executionTrace.ts";
import type { ConversationEventTone, ConversationEventVariant } from "./conversationNotes.ts";
import { isVerifyNote, noteTone } from "./conversationNotes.ts";
import { applyVerifySpans, reviewerKey, reviewerKeyOf, reviewerOf, traceVerifyRound } from "./conversationReviewer.ts";
export { conversationToMarkdown } from "./conversationMarkdown.ts";

export type LiveAgentEvent = Extract<ServerEvent, { type: "agent.event" }>;

export type TimelineEntry =
  | { kind: "user"; id: string; text: string; attachments: string[]; at: string; isAnswer?: boolean; bySystem?: boolean; source?: "optimistic" | "server" }
  | { kind: "server"; id: string; event: LiveAgentEvent };

// 「执行过程」块里的一行(工具 / 思考 / 异常)。形状与渲染都归 lib/executionTrace,
// 普通任务、团队、辩论共用同一份 —— 这里只保留旧名字的别名。
export type AgentAuxEvent = ExecutionEvent;

export type AgentContentSegment = {
  id: string;
  markdown: string;
  events: AgentAuxEvent[];
  attachments: string[];
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
      /** 上一条说话的还是同一个会话、中间只隔着旁注：接着上一段说，不再重报头像和执行器名。 */
      continuation?: boolean;
      session?: Session;
      run?: { model: string | null; reasoningEffort: string | null };
      /**
       * 这一回合是**审查者**在说话：就地验证轮带轮次号（`{ round: 2 }`），自由派审的
       * 独立审查回合没有轮次（`{ round: null }`，靠会话的 reviewer 身份认出来）。
       * undefined = 普通执行回合。
       *
       * 就地验证是搭在被验任务自己身上的旁路回合、还常复用同一条会话，所以它跟上一条
       * 「我在做需求」的气泡本来长得一模一样（同执行器自审时连名字都一样）。
       */
      reviewer?: { round: number | null };
      /** 这一回合的 token 用量。null = 这家 CLI 不报账、或这轮跑在本功能之前。 */
      usage?: TokenUsage | null;
      /** 整条会话至今的累计用量。只挂在本会话最后一条气泡上（尾栏显示会话信息的那条）。 */
      sessionUsage?: TokenUsage | null;
      /** 整条会话此刻的上下文水位（跟累计用量是两回事）。同样只挂在那条气泡上。 */
      sessionContext?: ContextUsage | null;
      markdown: string;
      segments: AgentContentSegment[];
    }
  | { kind: "user"; id: string; text: string; attachments: string[]; at?: string; isAnswer?: boolean; bySystem?: boolean }
  | {
      kind: "event";
      id: string;
      text: string;
      at?: string;
      /** 这条旁注是写在哪条会话上的。验证区间靠它认「时间线走到别人家了」（见 conversationReviewer）。 */
      sessionId?: string;
      tone?: ConversationEventTone;
      variant?: ConversationEventVariant;
      /** 这条旁注在讲验证轮的事（开始 / 未通过 / 打回修复）：跟审查者的气泡同一套配色。 */
      verify?: boolean;
    };

export type PersistedConversation = { session: Session; output: string; trace?: SessionTraceEntry[] };

type ConversationEventItem = Extract<ConversationItem, { kind: "event" }>;
type AgentTraceEvent = Extract<AgentEvent, { kind: "thinking" | "tool" | "error" }>;
type TracedContentEntry = SessionTraceEntry & {
  event: Exclude<SessionTraceEntry["event"], { kind: "usage" | "run" }>;
};
type TracedAttachmentEntry = TracedContentEntry & {
  event: Extract<SessionTraceEntry["event"], { kind: "attachment" }>;
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
// whose event time is close to that exact persisted sentinel. The timestamp
// guard matters because idle-recycle notices legitimately repeat every 30 min.
function timelineAfterPersistedTurns(
  timeline: TimelineEntry[],
  persistedTurns: PersistedTurnTimes,
): TimelineEntry[] {
  const remaining = new Map([...persistedTurns].map(([key, times]) => [key, [...times]]));
  return timeline.filter((entry) => {
    const marker = entry.kind === "user"
      ? { key: turnKey("user", entry.text), at: entry.at }
      : entry.event.event.kind === "system"
        ? { key: turnKey("system", entry.event.event.text, entry.event.sessionId), at: entry.event.event.at }
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

function legacyCodexUsageDelta(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  const reset = !!previous && (
    current.input < previous.input
    || current.output < previous.output
    || current.cacheRead < previous.cacheRead
    || current.cacheWrite < previous.cacheWrite
    || current.reasoning < previous.reasoning
  );
  if (!previous || reset) return { ...current, turns: 1 };
  return {
    input: current.input - previous.input,
    output: current.output - previous.output,
    cacheRead: current.cacheRead - previous.cacheRead,
    cacheWrite: current.cacheWrite - previous.cacheWrite,
    reasoning: current.reasoning - previous.reasoning,
    costUsd: null,
    turns: 1,
  };
}

// 7c274c0 之前的 Codex trace 保存的是 turn.completed 的线程累计快照。sessions 汇总
// 虽已由启动迁移校正，旧气泡若仍把这些快照相加，刷新后又会显示虚高。新 trace 带
// accounting=incremental；只有无标记的 Codex 历史事件需要在读侧求差。
function normalizedPersistedTrace(trace: SessionTraceEntry[], session: Session): SessionTraceEntry[] {
  if (session.agentType !== "codex") return trace;
  let previous: TokenUsage | null = null;
  return trace.map((entry) => {
    if (entry.event.kind !== "usage" || entry.event.accounting === "incremental") return entry;
    const usage = legacyCodexUsageDelta(entry.event.usage, previous);
    previous = entry.event.usage;
    return { ...entry, event: { ...entry.event, usage, accounting: "incremental" } };
  });
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

function traceRun(entries: SessionTraceEntry[]): { model: string | null; reasoningEffort: string | null } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event;
    if (event?.kind === "run") return { model: event.model, reasoningEffort: event.reasoningEffort };
  }
  return undefined;
}

function liveRun(event: LiveAgentEvent): { model: string | null; reasoningEffort: string | null } | undefined {
  if (event.model === undefined && event.reasoningEffort === undefined) return undefined;
  return {
    model: event.model?.trim() || null,
    reasoningEffort: event.reasoningEffort?.trim() || null,
  };
}

function sessionRun(session: Session | undefined): { model: string | null; reasoningEffort: string | null } | undefined {
  if (!session || (session.model === undefined && session.reasoningEffort === undefined)) return undefined;
  return {
    model: session.model?.trim() || null,
    reasoningEffort: session.reasoningEffort?.trim() || null,
  };
}

function contentSegments(
  traced: SessionTraceEntry[],
  fallbackMarkdown: string,
  idPrefix: string,
): AgentContentSegment[] {
  // usage 只是这一回合的账,不是执行过程的一步 —— 漏掉这道过滤它会被 auxEvent
  // 当成未知事件渲染成一行异常。
  const entries = traced.filter((entry): entry is TracedContentEntry => (
    entry.event.kind !== "usage" && entry.event.kind !== "run"
  ));
  const auxEntries = entries.filter((entry) => entry.event.kind !== "text" && entry.event.kind !== "attachment");
  const attachmentEntries = entries.filter(
    (entry): entry is TracedAttachmentEntry => entry.event.kind === "attachment",
  );
  if (!entries.some((entry) => entry.event.kind === "text")) {
    return [{
      id: `${idPrefix}:0`,
      markdown: fallbackMarkdown,
      events: auxEntries.map((entry) => auxEvent(entry.event as AgentTraceEvent)),
      attachments: attachmentEntries.map((entry) => entry.event.path),
    }];
  }

  const segments: AgentContentSegment[] = [];
  let current: AgentContentSegment = { id: `${idPrefix}:0`, markdown: "", events: [], attachments: [] };
  const pushCurrent = () => {
    if (!current.markdown && !current.events.length && !current.attachments.length) return;
    segments.push(current);
    current = { id: `${idPrefix}:${segments.length}`, markdown: "", events: [], attachments: [] };
  };
  for (const entry of entries) {
    if (entry.event.kind === "text") {
      current.markdown += entry.event.text;
      continue;
    }
    if (entry.event.kind === "attachment") {
      if (current.markdown) pushCurrent();
      if (!current.attachments.includes(entry.event.path)) current.attachments.push(entry.event.path);
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
    attachments: attachmentEntries.map((entry) => entry.event.path),
  }];
}

function currentSegment(agent: Extract<ConversationItem, { kind: "agent" }>): AgentContentSegment {
  const existing = agent.segments.at(-1);
  if (existing) return existing;
  const created = { id: `${agent.id}:segment:0`, markdown: "", events: [], attachments: [] };
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
    segment = { id: `${agent.id}:segment:${agent.segments.length}`, markdown: "", events: [], attachments: [] };
    agent.segments.push(segment);
  }
  segment.events.push(auxEvent(event));
}

function appendAgentAttachment(agent: Extract<ConversationItem, { kind: "agent" }>, path: string): void {
  let segment = currentSegment(agent);
  if (segment.markdown) {
    segment = { id: `${agent.id}:segment:${agent.segments.length}`, markdown: "", events: [], attachments: [] };
    agent.segments.push(segment);
  }
  if (!segment.attachments.includes(path)) segment.attachments.push(path);
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
  const explicitRun = liveRun(event);
  // 同一条会话**且同一个身份**才算「还是刚才那条气泡」。少了身份这一半，用户在验证
  // 回合中途打开任务页时（快照的末尾还是上一轮实现正文，「第 N 轮验证开始」在订阅前
  // 就播完了），接着到的审查正文会直接写进实现者的气泡里 —— 正是这个功能要治的病。
  const reviewer = reviewerOf(event.verifyRound, event.role ?? session?.role);
  const sameSpeaker = (item: ConversationItem): item is Extract<ConversationItem, { kind: "agent" }> => (
    item.kind === "agent" && item.sessionId === event.sessionId && reviewerKey(item) === reviewerKeyOf(reviewer)
  );
  let current = last && sameSpeaker(last) ? last : undefined;
  const turnStartedAt = session ? latestTurnStart(session) ?? session.startedAt : null;
  // 旁注可能在当前回合仍流式输出时插进来；只跨过同会话旁注找“本回合起点一致”的气泡。
  // 这样工具、用量和后续正文仍写回当前回合，而新一轮的系统起始提示不会吞掉上一回合。
  if (!current && turnStartedAt) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const candidate = items[index]!;
      if (candidate.kind === "event" && candidate.variant === "note" && candidate.sessionId === event.sessionId) continue;
      if (sameSpeaker(candidate) && candidate.at === turnStartedAt && !candidate.markerEndedAt) current = candidate;
      break;
    }
  }
  if (current) {
    if (explicitRun) current.run = explicitRun;
    return current;
  }
  const run = explicitRun ?? sessionRun(session);
  const item: Extract<ConversationItem, { kind: "agent" }> = {
    kind: "agent",
    id: `live:${event.sessionId}:${items.length}`,
    sessionId: event.sessionId,
    label: agentLabel(session, event),
    at: turnStartedAt,
    endedAt: null,
    markerEndedAt: null,
    session,
    run,
    reviewer,
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
    const traceGroups = groupedTrace(normalizedPersistedTrace(trace, session));
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
        // 旧版轮换文案落在用户 .md 里的原文带 Markdown 标记、措辞也不一样；旁注是纯文本
        // 渲染，不归一就会把星号原样露出来（@ash/shared/session-notes）。
        const text = normalizeSessionNoteText(segment.text);
        items.push({
          kind: "event",
          id: `persisted:system:${session.id}:${index}`,
          text,
          at: segment.at,
          sessionId: session.id,
          tone: noteTone(text),
          variant: "note",
          verify: isVerifyNote(text),
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
          run: traceRun(traceEntries) ?? sessionRun(session),
          reviewer: reviewerOf(traceVerifyRound(traceEntries), session?.role),
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
      if (!entries.some((entry) => entry.event.kind !== "run" && entry.event.kind !== "usage")) continue;
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
        run: traceRun(entries) ?? sessionRun(session),
        reviewer: reviewerOf(traceVerifyRound(entries), session?.role),
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
        bySystem: entry.bySystem,
      });
      continue;
    }
    const event = entry.event.event;
    if (event.kind === "system") {
      const text = normalizeSessionNoteText(event.text);
      appendEvent(items, {
        kind: "event",
        id: entry.id,
        text,
        at: event.at,
        sessionId: entry.event.sessionId,
        tone: noteTone(text),
        variant: "note",
        verify: isVerifyNote(text),
      });
      continue;
    }
    // 会话轮换信号（`scope:"session"`，见 server 的 session-notice.ts）不是本回合的
    // 失败：服务端已经把它转成持久 system 注记，这里再兜一道，免得任何漏转的直播事件
    // 把一次 exit 0 的健康回合渲染成红色「异常」。
    if (event.kind === "error" && event.scope === "session") {
      appendEvent(items, {
        kind: "event",
        id: entry.id,
        text: event.message,
        sessionId: entry.event.sessionId,
        tone: noteTone(event.message),
        variant: "note",
      });
      continue;
    }
    if (event.kind === "done") {
      appendEvent(items, {
        kind: "event",
        id: entry.id,
        text: event.exitStatus === 0 ? "本轮执行结束" : `执行异常结束 · exit ${event.exitStatus}`,
        tone: event.exitStatus === 0 ? "neutral" : "error",
        variant: "boundary",
      });
      continue;
    }
    if (event.kind === "turnEnd") {
      appendEvent(items, { kind: "event", id: entry.id, text: "本回合结束，等待下一条消息", variant: "boundary" });
      continue;
    }
    // session 是执行器的内部簿记事件(心跳/回合结束都会重发),旧 UI 就不渲染;
    // cliSessionId 已经在会话详情/恢复按钮那里可查,会话流里不展示。
    if (event.kind === "session") continue;
    const agent = appendAgent(items, entry.event, sessions);
    if (event.kind === "text") appendAgentText(agent, event.text);
    if (event.kind === "attachment") appendAgentAttachment(agent, event.path);
    // 用量恒在本回合的 turnEnd/done 之前到，所以它落在的就是刚说完话的那条气泡。
    if (event.kind === "usage") agent.usage = agent.usage ? addUsage(agent.usage, event.usage) : event.usage;
    // 水位是覆盖不是累加：后到的那条就是此刻，跟它前面报过什么无关。
    if (event.kind === "context") liveContext.set(entry.event.sessionId, event.context);
    if (event.kind === "tool" || event.kind === "thinking" || event.kind === "error") {
      appendAgentAux(agent, event);
    }
  }

  // 时间线到这里才排完（落盘排好序 + 直播按到达追加），身份也才补得齐。必须排在下面
  // 那轮 continuation 判定之前：那一轮拿 reviewer 当断点用。
  applyVerifySpans(items);

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
  let previousItem: ConversationItem | null = null;
  const seenSessions = new Set<string>();
  for (const item of items) {
    const adjacentInterjectionAt = previousItem?.kind === "user" || previousItem?.kind === "event"
      ? previousItem.at ?? null
      : null;
    if (item.kind === "user" || item.kind === "event") previousInterjectionAt = item.at ?? previousInterjectionAt;
    if (item.kind !== "agent") { previousItem = item; continue; }
    const firstTurn = !seenSessions.has(item.sessionId);
    seenSessions.add(item.sessionId);
    const turnStartedAt = item.session ? latestTurnStart(item.session) : null;
    item.at = firstTurn
      ? item.session?.startedAt ?? item.at
      : adjacentInterjectionAt
        ?? (item.at && item.at !== item.session?.startedAt ? item.at : null)
        ?? turnStartedAt
        ?? previousInterjectionAt
        ?? item.session?.startedAt;
    previousItem = item;
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

  // 旁注（预约审查、验收阶段更新、合并&清理完成…）不该把一段连续的发言劈成两半：
  // 后面那截还是同一个会话在说话，就接着上一段排版，不再重报头像、执行器名和模型。
  // 打断续接的只有四种真断点：真人插话、回合边界事件、换了会话，以及**换了身份**。
  //
  // 身份那一条是给就地验证用的：验证轮是搭在被验任务身上的旁路回合、常复用同一条
  // 会话，中间只隔着一条「第 N 轮验证开始」的旁注 —— 按前三条判就成了「同一个人接着
  // 说」，于是审查者的发言连头像和名字都不重报，反而比不区分更糟。
  let continuedSessionId: string | null = null;
  let continuedReviewer: string | null = null;
  for (const item of items) {
    if (item.kind === "user") { continuedSessionId = null; continue; }
    if (item.kind === "event") {
      if (item.variant === "boundary") continuedSessionId = null;
      continue;
    }
    item.continuation = continuedSessionId === item.sessionId && continuedReviewer === reviewerKey(item);
    continuedSessionId = item.sessionId;
    continuedReviewer = reviewerKey(item);
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
