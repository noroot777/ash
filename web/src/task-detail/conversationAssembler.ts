// 带身份的记录 → 气泡：落盘重建与实时增量**同一套**归并（conversationIdentity 把两路都拆成记录）。
//
// 一颗气泡 = 一条会话里、一个回合里、两句输入之间的全部记录（键：会话 + 回合 + 前一句输入的号）。
// - 归属只认身份：记录带着回合，号说明它在哪两句输入之间。中间隔着多少条注记、哨兵叫醒了几次、
//   刷新前后，都落回同一颗。
// - 去重只认号：同一个号只进一次（正文按「那段正文已经有了几个字」裁，见 applyProse）。
// - 一句输入落在同一回合里（原生引导）：前半截就是被打断的半截，收口时刻是那句输入的时刻。
// - 用量、执行器参数这类记账记录不开气泡；正文、思考、工具、异常、附件才开 —— 两路开气泡的时机一样，
//   位置才一样。
// - 收口（agentEnd / 实时的 done）不是一条记录，是这一回合的事实：结束时刻、结局、怎么断的挂在气泡上。
//   有回合行的，结束时刻就是回合行上那一刻（`Session.turnEnds`）。
//
// - 正文只有一份原文（不裁空白），执行过程记着各自落在原文第几个字之后；落盘那一路、实时那一路都只往
//   这里攒，所有气泡在收尾时（settle）一次排版成整颗正文与展示分段（conversationBubbleText）。没有「排过版
//   以后往展示分段上边到边追加」那一步 —— 那样展示分段裁过的空白、切过的段界就会改写后到的字。
//
// 删除按同一个定义指名（server/src/conversation-redact.ts 的 identityWindow / traceStepsWindow）：有正文的
// 报正文那几段，只有执行过程的报「这个回合里号落在前后两句输入之间的那几步」。
import type { ContextUsage, Session, TurnInterruption, TurnOutcome } from "@ash/shared";
import { segmentFingerprint, traceKeptOnDelete, traceStepsFingerprint } from "@ash/shared/session-output";
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationItem, TimelineEntry } from "./conversationModel.ts";
import { reviewerOf, traceVerifyRound } from "./conversationReviewer.ts";
import { bubbleText, type PlacedStep } from "./conversationBubbleText.ts";
import { auxEvent, awaitingAfterEvent, markSegmentsAwaiting, type AgentAuxEvent } from "./conversationSegments.ts";
import { traceRun, traceUsage } from "./conversationTraceGroups.ts";
import { agentLabel, sessionRun, type LiveAgentEvent } from "./conversationTurnParts.ts";
import { liveRun, liveSystemNote } from "./conversationLiveTurns.ts";
import { liveInput, recordId, type IdentityRecord, type SplitSession, type StepRecord } from "./conversationIdentity.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;
type Input = { seq: number; at?: string; turn: string | null };
type Close = { at?: string; outcome?: TurnOutcome | null; interruption?: TurnInterruption };

type Bubble = {
  item: AgentItem;
  key: string;
  sessionId: string;
  turn: string | null;
  /** 前一句输入的号（这颗气泡从它之后起）。null = 这条会话上还没有过输入。 */
  after: number | null;
  /** 这颗气泡的原文，按正文的号一段一段（盘上那段的原样字符，后面接实时到的增量）。 */
  chunks: { seq: number; raw: string; index?: number; seg?: Extract<IdentityRecord, { kind: "prose" }>["seg"] }[];
  /** 执行过程，各自落在原文第几个字之后（见 conversationBubbleText）。 */
  steps: PlacedStep[];
  /** 这颗气泡里盘上 trace 的全部条目（含正文条目）连同实时到的步骤：删除时按号核对的那一份。 */
  traced: SessionTraceEntry[];
  /** 盘上 trace 的正文条目累计到第几个字：落盘的那几步按它定位置。 */
  tracedText: number;
  readSide: SessionTraceEntry[];
  /** 实时那一路带来的：执行器参数、审查轮次、此刻还在不在等上游（按事件顺序，最后一条说了算）。 */
  live: { run?: AgentItem["run"]; verifyRound?: number; awaiting?: boolean };
};

// 开气泡的那几种（记账的 run / usage、跟 .md 重复的 trace 正文不开）。
const OPENS = new Set(["thinking", "tool", "error", "attachment"]);

export function createAssembler(sessions: readonly Session[]) {
  const sessionOf = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const proseLength = new Map<string, number>();
  const inputs = new Map<string, Input[]>();
  const bubbles = new Map<string, Bubble>();
  const pending = new Map<string, StepRecord[]>();
  const closes = new Map<string, Close>();
  const clientKeys = new Set<string>();

  const inputsOf = (sessionId: string) => inputs.get(sessionId) ?? [];
  const inputBefore = (sessionId: string, seq: number): Input | null =>
    inputsOf(sessionId).findLast((input) => input.seq < seq) ?? null;
  const inputAfter = (sessionId: string, seq: number | null): Input | null =>
    inputsOf(sessionId).find((input) => seq === null || input.seq > seq) ?? null;
  const keyOf = (sessionId: string, turn: string | null, after: number | null) => `${sessionId}\0${turn ?? ""}\0${after ?? ""}`;

  function open(record: Extract<IdentityRecord, { kind: "prose" | "step" }>, out: ConversationItem[]): Bubble {
    const prior = inputBefore(record.sessionId, record.seq);
    const after = prior?.seq ?? null;
    const session = sessionOf.get(record.sessionId);
    const envelope = record.envelope;
    const item: AgentItem = {
      kind: "agent",
      id: `turn:${record.sessionId}:${record.turn ?? ""}:${after ?? "-"}`,
      sessionId: record.sessionId,
      label: agentLabel(session, envelope),
      agentType: envelope?.agentType ?? session?.agentType ?? null,
      sessionRole: envelope?.role ?? session?.role ?? null,
      // 同一回合里被一句输入切开的后半截从那句输入起；否则从回合起点起。
      at: prior && prior.turn === record.turn ? prior.at ?? record.turn : record.turn ?? (record.kind === "prose" ? record.at : record.entry?.at) ?? null,
      turnStartedAt: record.turn,
      endedAt: null,
      markerEndedAt: null,
      recorded: true,
      session,
      run: (envelope && liveRun(envelope)) ?? sessionRun(session),
      reviewer: reviewerOf(envelope?.verifyRound, envelope?.role ?? session?.role),
      usage: null,
      markdown: "",
      segments: [],
    };
    const key = keyOf(record.sessionId, record.turn, after);
    const bubble: Bubble = { item, key, sessionId: record.sessionId, turn: record.turn, after, chunks: [], steps: [], traced: [], tracedText: 0, readSide: [], live: {} };
    bubbles.set(key, bubble);
    out.push(item);
    for (const step of pending.get(key) ?? []) addStep(bubble, step);
    pending.delete(key);
    return bubble;
  }

  const textLength = (bubble: Bubble) => bubble.chunks.reduce((sum, chunk) => sum + chunk.raw.length, 0);

  /** 实时那一路带来的气泡事实（盘上那一路这些从 trace 里读，见 layout）。 */
  function noteLive(bubble: Bubble, envelope: LiveAgentEvent, awaiting: boolean | undefined): void {
    const explicit = liveRun(envelope);
    if (explicit) bubble.live.run = explicit;
    if (envelope.verifyRound) bubble.live.verifyRound = envelope.verifyRound;
    if (awaiting !== undefined) bubble.live.awaiting = awaiting;
  }

  function addStep(bubble: Bubble, step: StepRecord): void {
    const event = step.event;
    if (step.entry) {
      bubble.traced.push(step.entry);
      // 盘上 trace 的正文条目只用来给步骤定位置：正文本身以 .md 那份为准。
      if (event.kind === "text") bubble.tracedText += event.text.length;
      else bubble.steps.push({ entry: step.entry, at: bubble.tracedText });
      return;
    }
    const entry = { at: "", turnStartedAt: step.turn ?? "", seq: step.seq, event } as SessionTraceEntry;
    bubble.traced.push(entry);
    bubble.steps.push({ entry, at: textLength(bubble) });
    // 此刻还在不在等上游：跟老读法实时那一路同一个口径（conversationLiveTurns 的 appendAgentAux 等）。
    const awaiting = event.kind === "usage" || event.kind === "attachment" ? false
      : event.kind === "tool" || event.kind === "thinking" || event.kind === "error"
        ? awaitingAfterEvent(auxEvent(event as Parameters<typeof auxEvent>[0]) as AgentAuxEvent) : undefined;
    if (step.envelope) noteLive(bubble, step.envelope, awaiting);
  }

  /** 一段正文（或它的一小块增量）。盘上那份已经有了的字不再追加。 */
  function applyProse(record: Extract<IdentityRecord, { kind: "prose" }>, out: ConversationItem[]): void {
    const lengthKey = `${record.sessionId}\0${record.seq}`;
    const had = proseLength.get(lengthKey) ?? 0;
    const fresh = record.raw.slice(Math.max(0, had - record.offset));
    proseLength.set(lengthKey, Math.max(had, record.offset + record.raw.length));
    if (!fresh && had) return;
    const key = keyOf(record.sessionId, record.turn, inputBefore(record.sessionId, record.seq)?.seq ?? null);
    const bubble = bubbles.get(key) ?? open(record, out);
    const chunk = bubble.chunks.find((candidate) => candidate.seq === record.seq);
    if (chunk) chunk.raw += fresh;
    else bubble.chunks.push({ seq: record.seq, raw: fresh, index: record.index, seg: record.seg });
    if (record.envelope) noteLive(bubble, record.envelope, false);
  }

  function apply(record: IdentityRecord, out: ConversationItem[]): void {
    if (record.kind === "prose") { applyProse(record, out); return; }
    if (record.kind === "end") {
      const after = inputBefore(record.sessionId, record.seq ?? Number.POSITIVE_INFINITY)?.seq ?? null;
      const key = keyOf(record.sessionId, record.turn, after);
      closes.set(key, { ...closes.get(key), at: record.at, ...(record.outcome ? { outcome: record.outcome } : {}), ...(record.interruption ? { interruption: record.interruption } : {}) });
      return;
    }
    const seenKey = `${record.sessionId}\0${record.seq}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    if (record.kind === "input") {
      const list = inputsOf(record.sessionId);
      const at = list.findIndex((input) => input.seq > record.seq);
      list.splice(at < 0 ? list.length : at, 0, { seq: record.seq, at: record.at, turn: record.turn });
      inputs.set(record.sessionId, list);
      if (record.clientKey) clientKeys.add(record.clientKey);
      out.push(record.item);
      return;
    }
    if (record.kind === "note") { out.push(record.item); return; }
    const key = keyOf(record.sessionId, record.turn, inputBefore(record.sessionId, record.seq)?.seq ?? null);
    const bubble = bubbles.get(key) ?? (OPENS.has(record.event.kind) ? open(record, out) : null);
    if (bubble) addStep(bubble, record);
    else pending.set(key, [...pending.get(key) ?? [], record]);
  }

  /** 一颗气泡一次排版：整颗正文与展示分段（同一份原文）、出处、执行器参数、用量。 */
  function layout(bubble: Bubble, awaitingSnapshot: boolean): void {
    const { item, sessionId, turn } = bubble;
    const session = sessionOf.get(sessionId);
    const steps = [...bubble.steps];
    // 读侧补出来的那几条没有号，按时刻插回去、跟前一步落在同一个位置（它们只是附件和子智能体档案，位置
    // 只影响画在哪一段）。
    for (const extra of bubble.readSide) {
      const at = steps.findIndex((step) => step.entry.at !== "" && step.entry.at > extra.at);
      const index = at < 0 ? steps.length : at;
      steps.splice(index, 0, { entry: extra, at: steps[index - 1]?.at ?? 0 });
    }
    const entries = steps.map((step) => step.entry);
    const kept = bubble.chunks.filter((chunk) => !chunk.seg?.deleted);
    // 被注记劈开的几段原样接回去：它们本来就是同一股正文流，一个字不差。
    const { markdown, segments } = bubbleText(kept.map((chunk) => chunk.raw).join(""), steps, `${item.id}:segment`);
    item.markdown = markdown;
    item.segments = segments;
    item.run = bubble.live.run ?? traceRun(entries) ?? item.run;
    item.reviewer = reviewerOf(traceVerifyRound(entries) ?? bubble.live.verifyRound, item.sessionRole ?? session?.role);
    item.usage = traceUsage(entries);
    // 此刻还在不在等上游：实时那一路后来说过的照它；没说过的，照快照里服务端给的那一位（见 conversationTimeline）。
    const last = segments.at(-1);
    if (last && bubble.live.awaiting !== undefined) last.awaiting = bubble.live.awaiting;
    else if (awaitingSnapshot) markSegmentsAwaiting(segments);
    if (bubble.chunks.length) {
      item.sources = bubble.chunks.flatMap((chunk) => chunk.seg && chunk.index !== undefined
        ? [{ sessionId, index: chunk.index, fingerprint: segmentFingerprint(chunk.seg) }] : []);
      if (!kept.length) item.deleted = true;
    } else if (turn && bubble.traced.some((entry) => typeof entry.seq === "number" && !traceKeptOnDelete(entry.event.kind))) {
      item.sources = [{
        sessionId,
        steps: { turnStartedAt: turn, after: bubble.after, until: inputAfter(sessionId, bubble.after)?.seq ?? null, fingerprint: traceStepsFingerprint(bubble.traced) },
      }];
    }
  }

  return {
    /**
     * 一条落盘会话带身份的那一截（会话之间按时刻排序由调用方做，这里只往 `out` 里按号铺）。`early`：实时那一路
     * 已经到了、号却落在这份快照里面的输入（output 与 trace 不是同一刻读的，中间来的那句插话快照里没有，trace
     * 里却已经有它之后的步骤）—— 跟快照一起按号铺，气泡的切分才由完整的输入集合决定，跟整份重新读一样。
     */
    persisted(split: SplitSession, out: ConversationItem[], early: IdentityRecord[] = []): void {
      // 稳定排序：同一个号盘上那份在前（实时那份随后按号去重）。
      const records = [...split.records, ...early].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
      for (const record of records) apply(record, out);
      for (const extra of split.readSide) {
        const candidates = [...bubbles.values()].filter((bubble) => bubble.sessionId === split.session.id && bubble.turn === extra.turnStartedAt);
        const owner = candidates.findLast((bubble) => (bubble.item.at ?? "") <= extra.at) ?? candidates[0];
        owner?.readSide.push(extra);
      }
    },
    /**
     * 实时事件的分派判据：归身份这一路（true）还是交回老读法。只判不做 —— 调用方先把整串分好（老读法那一路
     * 要先整体筛掉重复拷贝），再按到达顺序逐条交给 `live` / 老读法，两路交错的先后不变。
     * 判据是事件自己说的：带号的、或信封上标着出自带身份回合（`identityTurn`）的归这一路；都没有的是老样子
     * 写的回合，不管这条会话以前有没有过带号的记录。唯一看前文的是先画出来的那句（乐观回显）：它带着的
     * 凭据已经被服务端那份认领过，就归这一路（在这一路里不再画第二遍）。
     */
    router(): (entry: TimelineEntry) => boolean {
      const knownKeys = new Set(clientKeys);
      return (entry) => {
        if (entry.kind === "user") {
          if (entry.seq !== undefined && entry.sessionId) {
            if (entry.clientKey) knownKeys.add(entry.clientKey);
            return true;
          }
          return !!entry.clientKey && knownKeys.has(entry.clientKey);
        }
        return entry.event.seq !== undefined || entry.event.identityTurn === true;
      };
    },
    /** 一条归身份这一路的实时事件（`router` 认下的），就地处理掉。 */
    live(entry: TimelineEntry, out: ConversationItem[], liveContext: Map<string, ContextUsage>): void {
      if (entry.kind === "user") {
        const record = liveInput(entry, sessions);
        if (record) apply(record, out);
        return;
      }
      const envelope = entry.event;
      const event = envelope.event;
      const sessionId = envelope.sessionId;
      const seq = envelope.seq;
      if (event.kind === "context") { liveContext.set(sessionId, event.context); return; }
      if (event.kind === "session") return;
      const turn = envelope.turnStartedAt ?? null;
      if (seq === undefined) {
        // 带身份的回合里没带号的不是记录：回合收口记成事实；别的（执行器簿记）盘上没有，刷新以后也不会有，不画。
        if (event.kind === "done" || event.kind === "turnEnd") {
          const failed = event.kind === "done"
            ? turnEndedAbnormally({ exitStatus: event.exitStatus, turnOutcome: event.turnOutcome })
            : event.turnOutcome === "failed";
          apply({
            kind: "end", sessionId, turn, at: event.endedAt,
            outcome: event.turnOutcome ?? (failed ? "failed" : null),
            ...(event.kind === "done" && failed && event.interruption ? { interruption: event.interruption } : {}),
          }, out);
        }
        return;
      }
      if (event.kind === "system") {
        apply({ kind: "note", sessionId, turn, seq, item: liveSystemNote(recordId(sessionId, seq), sessionId, event) }, out);
      } else if (event.kind === "text") {
        apply({ kind: "prose", sessionId, turn, seq, raw: event.text, offset: envelope.textOffset ?? 0, envelope }, out);
      } else if (event.kind !== "done" && event.kind !== "turnEnd") {
        apply({ kind: "step", sessionId, turn, seq, event: event as StepRecord["event"], envelope }, out);
      }
    },
    /**
     * 收尾：每颗气泡排版，再定起止、是不是被打断的半截、回合事实。实时增量都到齐之后跑一次。
     * `awaiting`：快照里服务端说「此刻还在等上游」的那几颗（conversationTimeline 挑出来的，每条会话最后那颗）。
     */
    settle(awaiting: ReadonlySet<ConversationItem> = new Set()): void {
      for (const bubble of bubbles.values()) {
        layout(bubble, awaiting.has(bubble.item));
        settleBubble(bubble);
      }
    },
  };

  function settleBubble(bubble: Bubble): void {
    const { item, sessionId, turn } = bubble;
    const session = sessionOf.get(sessionId);
    const next = inputAfter(sessionId, bubble.after);
    const close = closes.get(bubble.key);
    // undefined = 这一回合没有回合行；null = 有，还没收口。
    const rowEnd = turn ? session?.turnEnds?.[turn] : undefined;
    const steered = !!next && next.turn === turn;
    let closedAt: string | null = null;
    let endedAt: string | null = null;
    if (close) closedAt = rowEnd ?? close.at ?? null;
    else if (steered) endedAt = next.at ?? null;
    else if (rowEnd) closedAt = rowEnd;
    else if (rowEnd === undefined && next) endedAt = next.at ?? null;
    item.endedAt = closedAt ?? endedAt;
    item.markerEndedAt = closedAt;
    item.interrupted = !close && steered;
    if (turn) {
      item.turnKey = turn;
      item.turnOutcome = session?.turnOutcomes?.[turn] ?? close?.outcome ?? null;
      const interruption = session?.turnInterruptions?.[turn] ?? close?.interruption;
      if (interruption) item.turnInterruption = interruption;
    }
  }
}

export type Assembler = ReturnType<typeof createAssembler>;
