// 带身份的会话记录 → 归并器（conversationAssembler）吃的一条条记录。两条来路：落盘重建（.md 的段、
// agentEnd、trace）与实时到达（SSE 事件）。同一条记录两路带的是同一个身份（服务端发的号，见
// shared/src/session-output.ts 的 RecordIdentity），归并器只认身份，不问它是从哪一路来的。
//
// 分路**逐条**按记录自己说的算（见 shared/src/session-output.ts 文件头）：带号的进身份这一路，没号的是
// 老样子写的（升级之前、团队调度台、duet、接不回号段的那一回合），交给老读法（conversationPersistedTurns）。
// 不看这条会话别处有没有号、这份快照里有没有正文 —— 一回合刚开头只动了手还没说话时，快照里只有带号的
// 执行过程，它照样归身份这一路。没号的 trace 条目同样归老读法；服务端读的时候补出来的那几条（`origin`）
// 例外：它们说的是带身份那几个回合的事，挂回那几个回合的气泡上。
import { ANSWER_PREFIX, type Session } from "@ash/shared";
import { parseSessionTranscript, segmentFingerprint, type ConvSeg } from "@ash/shared/session-output";
import { normalizeSessionNoteText } from "@ash/shared/session-notes";
import type { TurnInterruption, TurnOutcome } from "@ash/shared";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationEventItem, ConversationItem, PersistedOrigin, TimelineEntry } from "./conversationModel.ts";
import { eventTone, isVerifyNote } from "./conversationNotes.ts";
import type { LiveAgentEvent, PersistedTurnTimes } from "./conversationTurnParts.ts";
import { recordPersistedTurn } from "./conversationTurnParts.ts";
import { resumeNoteOf } from "./turnCause.ts";

type UserItem = Extract<ConversationItem, { kind: "user" }>;
type AgentSeg = Extract<ConvSeg, { kind: "agent" }>;
type Base = { sessionId: string; turn: string | null };

/** 一步执行过程：落盘那一路是 trace 条目，实时那一路是事件本身（连同它的信封：模型、轮次）。 */
export type StepRecord = Base & { kind: "step"; seq: number; event: SessionTraceEntry["event"]; entry?: SessionTraceEntry; envelope?: LiveAgentEvent };

export type IdentityRecord =
  // 一句输入（真人的、系统代写的）：把这条会话上的气泡切开 —— 它之后的记录归下一颗。
  | Base & { kind: "input"; seq: number; at?: string; clientKey?: string; item: UserItem }
  // 系统注记：排在它发生的位置，不切气泡（同一回合的记录不管隔着几条注记都归同一颗）。
  | Base & { kind: "note"; seq: number; item: ConversationEventItem }
  // 一段正文：落盘那一路是整段（带它在 .md 里的序号，删除拿它指名）；实时那一路是一小块增量，`offset` 是
  // 它在那段正文里从第几个字起（盘上那份已经有了的字据此裁掉）。
  | Base & { kind: "prose"; seq: number; raw: string; offset: number; at?: string; seg?: AgentSeg; index?: number; envelope?: LiveAgentEvent }
  | StepRecord
  // 回合收口：落盘那一路是 agentEnd，实时那一路是结尾的 done / turnEnd（不带号，认最新那颗）。
  | Base & { kind: "end"; seq?: number; at?: string; outcome?: TurnOutcome | null; interruption?: TurnInterruption };

/** 落盘那一路的条目 id：一条记录一个，跟实时那一路起的同一个（刷新前后同一个 React 身份）。 */
export const recordId = (sessionId: string, seq: number) => `rec:${sessionId}:${seq}`;

/** 一条落盘会话拆成两路：老样子写的交给老读法，带身份的拆成记录。 */
export type SplitSession = {
  session: Session;
  /** 老样子写的那几段（.md 里没号的，按原来的先后；整条会话都没有号就是全部）。 */
  legacySegments: ConvSeg[];
  /** 它们各自在整份 .md 里的序号（删除按它指名，不能拿 legacySegments 的下标代替）。 */
  legacyIndices: number[];
  legacyTrace: SessionTraceEntry[];
  /** 带身份的，按号排好。 */
  records: IdentityRecord[];
  /** 读的时候补出来的、说的是带身份那几个回合的条目（没有号，按时刻挂回那一回合的气泡）。 */
  readSide: SessionTraceEntry[];
};

const sourceOf = (sessionId: string, index: number, seg: ConvSeg): PersistedOrigin => ({
  sources: [{ sessionId, index, fingerprint: segmentFingerprint(seg) }],
  ...(seg.deleted ? { deleted: true as const } : {}),
});

function persistedInput(session: Session, index: number, seg: Extract<ConvSeg, { kind: "user" }>, seq: number): UserItem {
  return {
    kind: "user",
    id: recordId(session.id, seq),
    text: seg.text,
    attachments: [],
    at: seg.at,
    isAnswer: seg.text.startsWith(ANSWER_PREFIX),
    sessionId: session.id,
    sessionRole: session.role,
    bySystem: seg.bySystem,
    monitorWake: seg.monitorWake,
    answerIds: seg.answerIds,
    ...sourceOf(session.id, index, seg),
  };
}

function persistedNote(session: Session, index: number, seg: Extract<ConvSeg, { kind: "system" }>, seq: number): ConversationEventItem {
  const text = normalizeSessionNoteText(seg.text);
  const resume = resumeNoteOf(text, seg.resume);
  return {
    kind: "event",
    id: recordId(session.id, seq),
    text,
    at: seg.at,
    sessionId: session.id,
    tone: eventTone(text, seg.notice, seg.level),
    variant: "note",
    verify: isVerifyNote(text, seg.notice),
    aside: seg.aside === true,
    ...(seg.notice ? { notice: seg.notice } : {}),
    ...(resume ? { resume } : {}),
    ...sourceOf(session.id, index, seg),
  };
}

/**
 * 一条落盘会话 → 两截。`persistedTurns` 照旧记下带身份的输入（实时那一路没带凭据的乐观回显还要靠它认
 * 重复，见 conversationLiveTurns 的 timelineAfterPersistedTurns）。
 */
export function splitPersistedSession(
  { session, output, trace = [] }: { session: Session; output: string; trace?: SessionTraceEntry[] },
  persistedTurns: PersistedTurnTimes,
): SplitSession {
  const { spans, agentEnds, blanks } = parseSessionTranscript(output);
  const legacySegments: ConvSeg[] = [];
  const legacyIndices: number[] = [];
  const records: IdentityRecord[] = [];
  const turns = new Set<string>();
  spans.forEach(({ seg }, index) => {
    if (typeof seg.seq !== "number") { legacySegments.push(seg); legacyIndices.push(index); return; }
    const seq = seg.seq;
    const turn = seg.turnStartedAt ?? null;
    if (turn) turns.add(turn);
    const base = { sessionId: session.id, turn };
    if (seg.kind === "user") {
      recordPersistedTurn(persistedTurns, "user", seg.text, seg.at);
      records.push({ ...base, kind: "input", seq, at: seg.at, ...(seg.clientKey ? { clientKey: seg.clientKey } : {}), item: persistedInput(session, index, seg, seq) });
    } else if (seg.kind === "system") {
      recordPersistedTurn(persistedTurns, "system", seg.text, seg.at, session.id);
      records.push({ ...base, kind: "note", seq, item: persistedNote(session, index, seg, seq) });
    } else {
      records.push({ ...base, kind: "prose", seq, raw: seg.raw ?? seg.text, offset: 0, at: seg.at, seg, index });
    }
  });
  // 只有空白的那几段正文不成段，但它们是原文的一部分：后到的增量按盘上的字数接，少了它缩进和空行就丢了。
  for (const blank of blanks) {
    records.push({ kind: "prose", sessionId: session.id, turn: blank.turnStartedAt, seq: blank.seq, raw: blank.raw, offset: 0, at: blank.at });
  }
  for (const end of agentEnds) {
    if (typeof end.seq !== "number") continue;
    records.push({ kind: "end", sessionId: session.id, turn: end.turnStartedAt ?? null, seq: end.seq, at: end.at });
  }
  const legacyTrace: SessionTraceEntry[] = [];
  const readSide: SessionTraceEntry[] = [];
  for (const entry of trace) {
    if (typeof entry.seq !== "number") continue;
    turns.add(entry.turnStartedAt);
    records.push({ kind: "step", sessionId: session.id, turn: entry.turnStartedAt, seq: entry.seq, event: entry.event, entry });
  }
  for (const entry of trace) {
    if (typeof entry.seq === "number") continue;
    if (entry.origin !== undefined && turns.has(entry.turnStartedAt)) readSide.push(entry);
    else legacyTrace.push(entry);
  }
  records.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  return { session, legacySegments, legacyIndices, legacyTrace, records, readSide };
}

/** 实时那一路的一句输入（服务端播回来、带号的那种）。 */
export function liveInput(entry: Extract<TimelineEntry, { kind: "user" }>, sessions: readonly Session[]): Extract<IdentityRecord, { kind: "input" }> | null {
  if (entry.seq === undefined || !entry.sessionId) return null;
  return {
    kind: "input",
    sessionId: entry.sessionId,
    turn: entry.turnStartedAt ?? null,
    seq: entry.seq,
    at: entry.at,
    ...(entry.clientKey ? { clientKey: entry.clientKey } : {}),
    item: {
      kind: "user",
      id: recordId(entry.sessionId, entry.seq),
      text: entry.text,
      attachments: entry.attachments,
      at: entry.at,
      isAnswer: entry.isAnswer,
      bySystem: entry.bySystem,
      monitorWake: entry.monitorWake,
      answerIds: entry.answerIds,
      sessionId: entry.sessionId,
      sessionRole: entry.sessionRole ?? sessions.find((session) => session.id === entry.sessionId)?.role,
    },
  };
}
