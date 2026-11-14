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
// 删除按同一个定义指名（server/src/conversation-redact.ts 的 identityWindow / traceStepsWindow）：有正文的
// 报正文那几段，只有执行过程的报「这个回合里号落在前后两句输入之间的那几步」。
import type { ContextUsage, Session, TokenUsage, TurnInterruption, TurnOutcome } from "@ash/shared";
import { segmentFingerprint, traceKeptOnDelete, traceStepsFingerprint } from "@ash/shared/session-output";
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
import { addUsage } from "@ash/shared/usage";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationItem, TimelineEntry } from "./conversationModel.ts";
import { reviewerOf, traceVerifyRound } from "./conversationReviewer.ts";
import { contentSegments } from "./conversationSegments.ts";
import { traceRun, traceUsage } from "./conversationTraceGroups.ts";
import { agentLabel, sessionRun } from "./conversationTurnParts.ts";
import {
  appendAgentAttachment, appendAgentAux, appendAgentText, currentSegment, liveRun, liveSystemNote,
} from "./conversationLiveTurns.ts";
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
  /** 落盘那一路攒着、收尾时一次排版的；排过版（或本来就是实时开的）以后改成边到边追加。 */
  chunks: { seq: number; raw: string; index?: number; seg?: Extract<IdentityRecord, { kind: "prose" }>["seg"] }[];
  steps: StepRecord[];
  readSide: SessionTraceEntry[];
  incremental: boolean;
  /**
   * 排版时为了展示裁掉的正文末尾空白。实时增量按盘上原文的字数接（见 applyProse），所以接下一块之前
   * 先把它补回去 —— 不然 `Hello ` + `world` 会接成 `Helloworld`、标题吞掉下一段。
   */
  trimmedTail: string;
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
  let persistedPhase = true;

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
    const bubble: Bubble = { item, key, sessionId: record.sessionId, turn: record.turn, after, chunks: [], steps: [], readSide: [], incremental: !persistedPhase, trimmedTail: "" };
    bubbles.set(key, bubble);
    out.push(item);
    for (const step of pending.get(key) ?? []) addStep(bubble, step);
    pending.delete(key);
    return bubble;
  }

  /**
   * 排过版的气泡要接实时增量了：先把排版时裁掉的末尾空白补回正文（整颗与末段两处）。末段若只挂着
   * 执行过程、没有正文，那段空白落在更早一段的末尾、跟下一块之间本来就隔着段界，不补（补进去反倒让
   * 一个空段「有内容」）。
   */
  function resumeRaw(bubble: Bubble): void {
    const tail = bubble.trimmedTail;
    bubble.trimmedTail = "";
    const segment = bubble.item.segments.at(-1);
    if (!tail || !segment?.markdown) return;
    bubble.item.markdown += tail;
    segment.markdown += tail;
  }

  function addStep(bubble: Bubble, step: StepRecord): void {
    if (!bubble.incremental) { bubble.steps.push(step); return; }
    resumeRaw(bubble);
    const { item } = bubble;
    const explicit = step.envelope && liveRun(step.envelope);
    if (explicit) item.run = explicit;
    const event = step.event;
    if (event.kind === "usage") {
      item.usage = item.usage ? addUsage(item.usage, event.usage as TokenUsage) : event.usage;
      currentSegment(item).awaiting = false;
    } else if (event.kind === "attachment") {
      appendAgentAttachment(item, event);
    } else if (event.kind === "tool" || event.kind === "thinking" || event.kind === "error") {
      appendAgentAux(item, event as Parameters<typeof appendAgentAux>[1]);
    }
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
    if (bubble.incremental) {
      resumeRaw(bubble);
      if (fresh) appendAgentText(bubble.item, fresh);
      const explicit = record.envelope && liveRun(record.envelope);
      if (explicit) bubble.item.run = explicit;
      return;
    }
    bubble.chunks.push({ seq: record.seq, raw: record.raw, index: record.index, seg: record.seg });
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

  /** 落盘那一路攒着的气泡一次排版（正文与执行过程对齐、出处、回合事实），之后改为边到边追加。 */
  function layout(bubble: Bubble): void {
    const { item, sessionId, turn } = bubble;
    const session = sessionOf.get(sessionId);
    const ordered = bubble.steps.flatMap((step) => step.entry ? [step.entry] : []);
    // 读侧补出来的那几条没有号，按时刻插回去（它们只是附件和子智能体档案，位置只影响画在哪一段）。
    for (const extra of bubble.readSide) {
      const at = ordered.findIndex((entry) => entry.at > extra.at);
      ordered.splice(at < 0 ? ordered.length : at, 0, extra);
    }
    const live = bubble.chunks.filter((chunk) => !chunk.seg?.deleted);
    // 被注记劈开的几段原样接回去：它们本来就是同一股正文流，一个字不差。
    const raw = live.map((chunk) => chunk.raw).join("");
    const markdown = raw.trim();
    item.markdown = markdown;
    // 只有正文末尾那一段的空白要留着接下一块；正文整段是空白时什么都不留（也就没有可接的位置）。
    bubble.trimmedTail = markdown ? raw.slice(raw.trimEnd().length) : "";
    item.segments = contentSegments(ordered, markdown, `${item.id}:segment`);
    item.run = traceRun(ordered) ?? item.run;
    item.reviewer = reviewerOf(traceVerifyRound(ordered), session?.role);
    item.usage = traceUsage(ordered);
    if (bubble.chunks.length) {
      item.sources = bubble.chunks.flatMap((chunk) => chunk.seg && chunk.index !== undefined
        ? [{ sessionId, index: chunk.index, fingerprint: segmentFingerprint(chunk.seg) }] : []);
      if (!live.length) item.deleted = true;
    } else if (turn && ordered.some((entry) => typeof entry.seq === "number" && !traceKeptOnDelete(entry.event.kind))) {
      item.sources = [{
        sessionId,
        steps: { turnStartedAt: turn, after: bubble.after, until: inputAfter(sessionId, bubble.after)?.seq ?? null, fingerprint: traceStepsFingerprint(ordered) },
      }];
    }
    bubble.incremental = true;
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
    /** 落盘那一路铺完了：排版，之后到的都是实时增量。 */
    endPersisted(): void {
      for (const bubble of bubbles.values()) if (!bubble.incremental) layout(bubble);
      persistedPhase = false;
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
    /** 收尾：每颗气泡的起止、是不是被打断的半截、回合事实。实时增量都到齐之后跑一次。 */
    settle(): void {
      for (const bubble of bubbles.values()) settleBubble(bubble);
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
