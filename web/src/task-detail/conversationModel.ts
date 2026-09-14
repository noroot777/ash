import type { ContextUsage, ServerEvent, Session, TokenUsage } from "@ash/shared";
import { ANSWER_PREFIX, parseSessionOutput } from "@ash/shared";
import { addUsage, usageTotal } from "@ash/shared/usage";
import { normalizeSessionNoteText } from "@ash/shared/session-notes";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationEventTone, ConversationEventVariant } from "./conversationNotes.ts";
import { isVerifyNote, noteTone } from "./conversationNotes.ts";
import { applyVerifySpans, reviewerKey, reviewerKeyOf, reviewerOf, traceVerifyRound } from "./conversationReviewer.ts";
import type { AgentContentSegment, AgentTraceEvent } from "./conversationSegments.ts";
import { auxEvent, contentSegments } from "./conversationSegments.ts";
import {
  groupedTrace,
  normalizedPersistedTrace,
  splitTraceGroupAt,
  takeTraceGroup,
  traceRun,
  traceUsage,
} from "./conversationTraceGroups.ts";
export { conversationToMarkdown } from "./conversationMarkdown.ts";
// 分段那一族住在 conversationSegments:这里转出去,别处 import 的路径不用跟着改。
export type { AgentAuxEvent, AgentContentSegment } from "./conversationSegments.ts";

export type LiveAgentEvent = Extract<ServerEvent, { type: "agent.event" }>;

export type TimelineEntry =
  | { kind: "user"; id: string; text: string; attachments: string[]; at: string; isAnswer?: boolean; bySystem?: boolean; source?: "optimistic" | "server" }
  | { kind: "server"; id: string; event: LiveAgentEvent };

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
      /**
       * 这条只是**任务时间线的一条记录**（预约审查、验收阶段更新、预览起停…），不是会话
       * 里的一个回合 —— agent 从没见过这些字，它落在哪一秒也纯属偶然，多半正砸在某个回合
       * 说到一半的地方。
       *
       * 所以它**不许当回合边界用**：不切气泡（见下面的 mergeTurnChunk）、不定回合的起止
       * 时刻（见 at / endedAt 两轮）。拿它当边界的后果是一条回复被劈成两半，上半截平白得
       * 到一个「结束时刻」于是提前折叠、还挂上「派生新任务」——而那半截根本不是一条完整
       * 回复（用户 2026-09-14 反馈）。
       *
       * 来源：服务端 appendTaskTimeline 写的 `aside` 标；老会话没有这个标，落盘那一路改按
       * trace 的回合分组推（见 noteInsideTurn）。
       */
      aside?: boolean;
    };

export type PersistedConversation = { session: Session; output: string; trace?: SessionTraceEntry[] };

type ConversationEventItem = Extract<ConversationItem, { kind: "event" }>;
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

/**
 * 这条旁注落下来的时候，这条会话的某个回合**还在飞**吗。
 *
 * 判据是 trace 的回合分组：某一组的 `turnStartedAt` **严格早于**旁注、组里又还有旁注
 * 之后的事件 —— 那就是砸进了一个正在进行的回合，它上下两截 .md 正文是同一个人同一轮
 * 说的话。真正的回合起点（「继续（从中断处）」那类系统行）时刻**恰好等于**某一组的
 * `turnStartedAt`，「严格早于」这一刀就把两者分开了，不用去猜文案。
 *
 * 老会话没有服务端的 `aside` 标（2026-09-14 之前），全靠这条推断；新会话两者都有，
 * 互为印证。整条会话一条 trace 都没有时它恒为 false，于是维持老版排法。
 *
 * **必须在 splitTraceGroupAt 动手之前调用** —— 那一步会按旁注改写分组，之后再问就问不
 * 出「原本是同一组」了。
 */
function noteInsideTurn(groups: Map<string, SessionTraceEntry[]>, at: string | undefined): boolean {
  const time = Date.parse(at ?? "");
  if (!Number.isFinite(time)) return false;
  for (const [turnStartedAt, entries] of groups) {
    const start = Date.parse(turnStartedAt);
    if (!Number.isFinite(start) || start >= time) continue;
    if (entries.some((entry) => Date.parse(entry.at) >= time)) return true;
  }
  return false;
}

/**
 * 把「被旁注劈开的下半截」并回上一颗气泡 —— 它们本来就是同一回合、同一个人说的一段话。
 *
 * 只把两截**接起来**，分段一个都不动：每一截的 events / 正文早已各自跟自己那一小组
 * trace 对齐过（见 contentSegments 的 alignedSegments），接在一起就是这一回合完整的交错
 * 结构，折叠（turnLayout）也才有得切 —— 否则「最后一次动手」只能在半截里找，整轮折不出
 * 结论。分段各自渲染成独立的块，接缝处不需要补空行；补的那一下只归 `markdown`（复制、
 * 派生快照读的是它），两截之间空一行才是一段话原来的样子。
 */
function mergeTurnChunk(
  target: Extract<ConversationItem, { kind: "agent" }>,
  chunk: Extract<ConversationItem, { kind: "agent" }>,
): void {
  target.markdown = [target.markdown, chunk.markdown].filter((text) => text.trim()).join("\n\n");
  target.segments.push(...chunk.segments);
  // 收口标记跟着后一截走：回合真正结束在哪一刻，只有最后那一截知道。
  target.markerEndedAt = chunk.markerEndedAt ?? target.markerEndedAt;
  target.usage = target.usage && chunk.usage ? addUsage(target.usage, chunk.usage) : chunk.usage ?? target.usage;
  target.run = target.run ?? chunk.run;
}

/**
 * 这条时间线项目算不算「插话」—— 能给相邻回合定起止时刻的那种。
 *
 * 真人回复、系统发给 agent 的话、回合边界都算；任务时间线旁注（aside）不算：它不开也
 * 不收一个回合，拿它定起止，一条还在跑的回合会平白得到一个结束时刻（于是提前折叠、
 * 还挂上「派生新任务」）。
 */
function isTurnInterjection(item: ConversationItem | null | undefined): boolean {
  if (!item) return false;
  if (item.kind === "user") return true;
  return item.kind === "event" && !item.aside;
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
    // 先按 .md 里的 sentinel 把 trace 切成段，再逐段发放。切分必须整体跑在任何 agent 段
    // 认领之前：原生引导那一路插话前常常一个字都没吐（agent 正连着跑工具），既没有 .md
    // 正文能顺手触发切分，等上一段领走整组之后也已经晚了。
    //
    // 插话一律是切点。**系统旁注只在它后面还有 agent 正文时才是切点**：那种情形下
    // parseSessionOutput 已经在 sentinel 处把正文切成了两段 agent，trace 不跟着切，前面
    // 那截（「预约审查」这类旁注常常正好落在 agent 刚吐出一两个字的时候）就会把整组
    // trace 连同几百次工具调用一起领走，真正写正文的那一段一个事件都拿不到。
    //
    // 旁注后面没有正文时**不能**切：那一组 trace 会没人认领，落进「无正文兜底气泡」凭空
    // 多出一颗，而直播那边旁注根本不拆气泡（见 appendAgent 跨旁注回捞当前回合），刷新
    // 前后就长得不一样了。
    const splitPoints = new Set<string>();
    segments.forEach((segment, index) => {
      if (segment.kind === "agent" || !segment.at) return;
      if (segment.kind === "system" && !segments.slice(index + 1).some((later) => later.kind === "agent")) return;
      splitPoints.add(segment.at);
    });
    // 谁是「任务时间线旁注」要在切分**之前**认完：noteInsideTurn 读的正是即将被改写的
    // 那份分组。两套判据各管一头 —— 服务端的 aside 标覆盖全部 appendTaskTimeline 旁注
    // （含落在两个回合之间的，比如「第 N 轮验证开始」），它只决定「不拿它定回合起止」；
    // 而要不要把上下两截并回一颗气泡，只认 insideTurn ——「那一刻回合确实还在飞」才是
    // 同一段话的证据，否则验证轮那条旁注会把实现者和审查者的发言粘成一条。
    const asideAt = new Set<string>();
    const midTurnAt = new Set<string>();
    for (const segment of segments) {
      if (segment.kind !== "system" || !segment.at) continue;
      const inside = noteInsideTurn(traceGroups, segment.at);
      if (inside) midTurnAt.add(segment.at);
      if (inside || segment.aside) asideAt.add(segment.at);
    }
    let splitFrom = session.startedAt;
    for (const segment of segments) {
      if (segment.kind === "agent" || !segment.at || !splitPoints.has(segment.at)) continue;
      splitTraceGroupAt(traceGroups, consumedTrace, splitFrom, segment.at);
      splitFrom = segment.at;
    }
    let turnStartedAt = session.startedAt;
    // 这一回合还没说完的那颗气泡（被旁注劈开的上半截），以及「中间只隔着旁注」这件事。
    let openTurn: Extract<ConversationItem, { kind: "agent" }> | null = null;
    let acrossAside = false;
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
        openTurn = null;
        acrossAside = false;
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
          // 服务端标了 notice 就照它的，别再去猜（见 conversationNotes 的 tone 注释）。
          tone: segment.level === "notice" ? "notice" : noteTone(text),
          variant: "note",
          verify: isVerifyNote(text),
          aside: asideAt.has(segment.at ?? ""),
        });
        // 回合起点仍然跟着旁注走：trace 已经在这一刻切成了独立一组，下半截要靠它认领
        // 自己那几条事件。合并发生在气泡层面（见下面的 mergeTurnChunk），两者不冲突。
        turnStartedAt = segment.at ?? turnStartedAt;
        if (midTurnAt.has(segment.at ?? "")) acrossAside = !!openTurn;
        else { openTurn = null; acrossAside = false; }
      } else {
        const next = segments[index + 1];
        // 下一段的 trace 已经被上面切成独立一组了，这一段不许靠 ±2 秒兜底把它捞过来。
        // 判据跟切点保持同一份：agent 在切点之前一个字都没吐时，它自己那一组会被切空
        // 删掉，兜底就正好会挑中切点之后那一组。
        const boundary = next && next.kind !== "agent" && next.at && splitPoints.has(next.at)
          ? next.at
          : undefined;
        const traceEntries = takeTraceGroup(traceGroups, consumedTrace, turnStartedAt, boundary);
        const chunk: Extract<ConversationItem, { kind: "agent" }> = {
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
        };
        // 中间只隔着一条「那一刻回合还在飞」的旁注 —— 这就是同一回合的下半截，并回去。
        // 身份再核一道：同一条会话上换轮验证也算换人（reviewerKey），换了人就不是同一段
        // 话，哪怕旁注骗过了上面那道结构判据也粘不到一起。只有**自己带 run 事件**的那截
        // 才有资格报身份：回合起点才写 run，下半截通常一条都没有（就地验证的审查者在自己
        // 回合中间调 report_stage 就是这形状），拿它那份空身份去比就会把一个人的话劈成两
        // 半、后半截还丢掉模型信息。
        const ownIdentity = traceEntries.some((entry) => entry.event.kind === "run");
        const sameSpeaker = !ownIdentity || reviewerKeyOf(openTurn?.reviewer) === reviewerKeyOf(chunk.reviewer);
        if (openTurn && acrossAside && sameSpeaker) {
          mergeTurnChunk(openTurn, chunk);
        } else {
          items.push(chunk);
          openTurn = chunk;
        }
        acrossAside = false;
      }
    });
    // A failed turn can contain only tools/errors and no assistant prose. Keep
    // its execution block visible instead of dropping the persisted trace.
    //
    // 另一类没有正文的组是**同一个回合的碎片**:常驻调度台被 CLI 自己唤醒续跑(后台监控
    // 回调)时,服务端补上回合起点之前落的 trace,每条事件都拿自己的时刻当回合起点(修在
    // server/src/team/session-consumer.ts,老数据仍是碎的)。一条条渲染就是一串「1 工具」
    // 的空气泡。它们的共同特征是**没有 run 事件** —— 真回合起点一定写 run —— 所以顺着
    // 时间粘回同一条,直到下一个 run 或下一段已经有正文的回合。
    // 正文的权威来源只有 .md:兜底气泡里的 text 事件多半已经被上面某条气泡渲染过了
    // （回合边界对不上时,同一段话会同时落在 .md 段落和无人认领的 trace 组里）。原样带
    // 上就是一段话连说两遍,所以只留执行过程。
    const persistedProse = segments
      .filter((segment) => segment.kind === "agent")
      .map((segment) => compactTurnText(segment.text))
      .join("\0");
    const withoutEchoedProse = (entries: SessionTraceEntry[]): SessionTraceEntry[] => entries.filter((entry) => {
      if (entry.event.kind !== "text") return true;
      const compact = compactTurnText(entry.event.text);
      return !!compact && !persistedProse.includes(compact);
    });
    let fragment: { turn: string; entries: SessionTraceEntry[] } | null = null;
    const flushFragment = (): void => {
      const pending = fragment;
      fragment = null;
      if (!pending) return;
      const entries = withoutEchoedProse(pending.entries);
      if (!entries.some((entry) => entry.event.kind !== "run" && entry.event.kind !== "usage")) return;
      const segments = contentSegments(entries, "", `persisted:trace-segment:${session.id}:${pending.turn}`);
      items.push({
        kind: "agent",
        id: `persisted:trace:${session.id}:${pending.turn}`,
        sessionId: session.id,
        label: agentLabel(session),
        // 起点取第一条实质事件:被丢掉的复读正文往往比工具早好几分钟,拿组的 key 当起点
        // 会把「模型在写字」的时间算进这条执行过程的用时里。
        at: entries.find((entry) => entry.event.kind !== "usage")?.at ?? pending.turn,
        endedAt: null,
        markerEndedAt: null,
        session,
        run: traceRun(entries) ?? sessionRun(session),
        reviewer: reviewerOf(traceVerifyRound(entries), session?.role),
        usage: traceUsage(entries),
        markdown: segments.map((segment) => segment.markdown).join(""),
        segments,
      });
    };
    for (const [traceTurn, entries] of traceGroups) {
      if (consumedTrace.has(traceTurn) || entries.some((entry) => entry.event.kind === "run")) flushFragment();
      if (consumedTrace.has(traceTurn)) continue;
      if (fragment) fragment.entries.push(...entries);
      else fragment = { turn: traceTurn, entries: [...entries] };
    }
    flushFragment();
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
    // 任务时间线旁注整条跳过：回合的起止跟它无关（见 isTurnInterjection）。
    if (item.kind === "event" && item.aside) continue;
    const adjacentInterjectionAt = isTurnInterjection(previousItem) ? previousItem?.at ?? null : null;
    if (isTurnInterjection(item)) previousInterjectionAt = item.at ?? previousInterjectionAt;
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
  // 同一条会话里紧挨着它的下一条发言的开始时刻。没有回合结束标记时(CLI 自己唤醒续跑
  // 的那些回合就没有)拿它当上界:再往下兜底的是整条会话的 endedAt,一串气泡就会同时以
  // 会话结束时刻收尾,用时排成一列越往下越短、末条 0s 的假数据。
  let nextAgentAt: string | null = null;
  let rightSessionId: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    // 旁注不收回合：一条还在飞的回合被它按上结束时刻，就会当场折叠、还挂出「派生新任务」
    //（用户 2026-09-14 反馈）。真回合结束自有 markerEndedAt / 回合边界事件来报。
    if (item.kind === "event" && item.aside) continue;
    if (item.kind === "user" || item.kind === "event") nextInterjectionAt = item.at ?? nextInterjectionAt;
    if (item.kind !== "agent") continue;
    if (item.sessionId !== rightSessionId) {
      nextInterjectionAt = null;
      nextAgentAt = null;
      rightSessionId = item.sessionId;
    }
    item.endedAt = item.markerEndedAt
      ?? nextInterjectionAt
      ?? nextAgentAt
      ?? inferredRunEnd(item.at, runBounds.get(item.sessionId));
    nextAgentAt = item.at ?? nextAgentAt;
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
