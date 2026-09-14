// 直播那一路:把 SSE 到达的事件增量追加进已经排好的落盘时间线。
// 从 conversationModel 拆出来的一块 —— 那边管「落盘 → 气泡」和最后几轮收口,这里只管
// 「一条事件到了,写进哪颗气泡」。两边共用的小件在 conversationTurnParts。
import type { ContextUsage, Session } from "@ash/shared";
import { addUsage } from "@ash/shared/usage";
import { normalizeSessionNoteText } from "@ash/shared/session-notes";
import { isVerifyNote, noteTone } from "./conversationNotes.ts";
import { reviewerKey, reviewerKeyOf, reviewerOf } from "./conversationReviewer.ts";
import type { AgentContentSegment, AgentTraceEvent } from "./conversationSegments.ts";
import { auxEvent } from "./conversationSegments.ts";
import type { ConversationEventItem, ConversationItem, TimelineEntry } from "./conversationModel.ts";
import type { AgentRun, LiveAgentEvent, PersistedTurnTimes } from "./conversationTurnParts.ts";
import { agentLabel, latestTurnStart, sessionRun, turnKey } from "./conversationTurnParts.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;

const SNAPSHOT_DUPLICATE_WINDOW_MS = 30_000;

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

function liveRun(event: LiveAgentEvent): AgentRun | undefined {
  if (event.model === undefined && event.reasoningEffort === undefined) return undefined;
  return {
    model: event.model?.trim() || null,
    reasoningEffort: event.reasoningEffort?.trim() || null,
  };
}

function currentSegment(agent: AgentItem): AgentContentSegment {
  const existing = agent.segments.at(-1);
  if (existing) return existing;
  const created = { id: `${agent.id}:segment:0`, markdown: "", events: [], attachments: [] };
  agent.segments.push(created);
  return created;
}

function appendAgentText(agent: AgentItem, text: string): void {
  agent.markdown += text;
  currentSegment(agent).markdown += text;
}

function appendAgentAux(agent: AgentItem, event: AgentTraceEvent): void {
  let segment = currentSegment(agent);
  if (segment.markdown) {
    segment = { id: `${agent.id}:segment:${agent.segments.length}`, markdown: "", events: [], attachments: [] };
    agent.segments.push(segment);
  }
  segment.events.push(auxEvent(event));
}

function appendAgentAttachment(agent: AgentItem, path: string): void {
  let segment = currentSegment(agent);
  if (segment.markdown) {
    segment = { id: `${agent.id}:segment:${agent.segments.length}`, markdown: "", events: [], attachments: [] };
    agent.segments.push(segment);
  }
  if (!segment.attachments.includes(path)) segment.attachments.push(path);
}

function appendAgent(items: ConversationItem[], event: LiveAgentEvent, sessions: Session[]): AgentItem {
  const session = sessions.find((candidate) => candidate.id === event.sessionId);
  const last = items[items.length - 1];
  const explicitRun = liveRun(event);
  // 同一条会话**且同一个身份**才算「还是刚才那条气泡」。少了身份这一半，用户在验证
  // 回合中途打开任务页时（快照的末尾还是上一轮实现正文，「第 N 轮验证开始」在订阅前
  // 就播完了），接着到的审查正文会直接写进实现者的气泡里 —— 正是这个功能要治的病。
  const reviewer = reviewerOf(event.verifyRound, event.role ?? session?.role);
  const sameSpeaker = (item: ConversationItem): item is AgentItem => (
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
  const item: AgentItem = {
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

/**
 * 把直播到达的事件追加到 `items` 末尾，返回各会话此刻的上下文水位。
 *
 * 落盘那一路必须已经排完序：直播是「按到达顺序往后接」，不再参与排序。
 */
export function appendLiveTimeline(
  items: ConversationItem[],
  timeline: TimelineEntry[],
  sessions: Session[],
  persistedTurns: PersistedTurnTimes,
): Map<string, ContextUsage> {
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
        tone: event.level === "notice" ? "notice" : noteTone(text),
        variant: "note",
        verify: isVerifyNote(text),
        // 直播这一路认服务端的标就够了：旁注本来就不拆气泡（见 appendAgent 跨旁注回捞
        // 当前回合），带上它只是为了同样别去定这一回合的结束时刻。
        aside: event.aside === true,
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
  return liveContext;
}
