import type { DuetConsensusBy, DuetSpeaker, GateName, ServerEvent } from "@ash/shared";
import type { ExecutionEvent } from "../lib/executionTrace.ts";

export type DuetTurn = {
  round: number;
  speaker: DuetSpeaker;
  text: string;
  // 合稿轮的停止原因(consensus/agreedToStop/roundCap/midway);其余轮与旧行为 undefined。
  stop?: string;
  /** 本回合的执行过程(工具/思考),与普通任务、团队共用一个「执行过程」折叠块。 */
  events: ExecutionEvent[];
  raised: boolean;
  agrees?: boolean;
  conclusion?: string;
  done: boolean;
  error?: string;
  notice?: string;
  at?: string;
  startedAt?: string;
  durationMs?: number;
  target?: "A" | "B";
};

export type DuetGate = {
  gate: GateName;
  open: boolean;
  consensus?: boolean;
  consensusBy?: DuetConsensusBy;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

export type DuetState = { turns: DuetTurn[]; gate: DuetGate | null };
// 落盘的回合行:events 是后加的,旧 transcript 里没有(缺省当作没有执行过程)。
export type PersistedDuetTurn = Omit<DuetTurn, "events" | "done" | "raised"> & { raised?: boolean; events?: ExecutionEvent[] };
export type PersistedDuetEntry =
  | PersistedDuetTurn
  | Extract<ServerEvent, { type: "duet.gate" | "duet.progress" }>;

export const emptyDuet = (): DuetState => ({ turns: [], gate: null });

function isPersistedGate(entry: PersistedDuetEntry): entry is Extract<ServerEvent, { type: "duet.gate" }> {
  return (entry as { type?: string }).type === "duet.gate";
}

function isPersistedProgress(entry: PersistedDuetEntry): entry is Extract<ServerEvent, { type: "duet.progress" }> {
  return (entry as { type?: string }).type === "duet.progress";
}

function speakerOf(role: string): DuetSpeaker {
  if (role === "voiceB") return "B";
  if (role === "implementer") return "impl";
  if (role === "reviewer") return "review";
  return "A";
}

export function applyDuetEvent(state: DuetState, event: ServerEvent): DuetState {
  if (event.type === "duet.progress") {
    if (event.phase === "start") {
      const turns = [...state.turns];
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]!;
        if (turn.round !== event.round || turn.speaker !== event.speaker || turn.done) continue;
        turns[index] = { ...turn, startedAt: event.startedAt ?? event.at ?? turn.startedAt };
        return { ...state, turns };
      }
      return {
        ...state,
        turns: [...turns, {
          round: event.round,
          speaker: event.speaker,
          text: "",
          events: [],
          raised: false,
          done: false,
          startedAt: event.startedAt ?? event.at,
        }],
      };
    }
    const turns = [...state.turns];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]!.speaker === event.speaker && !turns[index]!.done) {
        turns[index] = {
          ...turns[index]!,
          done: true,
          raised: !!event.raisedHand,
          at: event.at,
          startedAt: event.startedAt ?? turns[index]!.startedAt,
          durationMs: event.durationMs,
        };
        break;
      }
    }
    return { ...state, turns };
  }
  if (event.type === "duet.gate") {
    const previous = state.gate?.gate === event.gate ? state.gate : null;
    return {
      ...state,
      gate: {
        gate: event.gate,
        open: event.open,
        consensus: event.consensus ?? previous?.consensus,
        consensusBy: event.consensusBy ?? previous?.consensusBy ?? (event.consensus ? "both" : undefined),
        conclusionA: event.conclusionA ?? previous?.conclusionA,
        conclusionB: event.conclusionB ?? previous?.conclusionB,
      },
    };
  }
  if (event.type === "duet.user") {
    return {
      ...state,
      turns: [...state.turns, {
        round: event.round,
        speaker: "user",
        text: event.text,
        events: [],
        raised: false,
        done: true,
        at: event.at,
        target: event.target,
      }],
    };
  }
  if (event.type === "agent.event") {
    const speaker = speakerOf(event.role);
    const turns = [...state.turns];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]!.speaker !== speaker || turns[index]!.done) continue;
      const turn = { ...turns[index]! };
      if (event.event.kind === "text") turn.text += event.event.text;
      if (event.event.kind === "tool") turn.events = [...turn.events, { kind: "tool", label: event.event.name, detail: event.event.detail }];
      if (event.event.kind === "thinking") turn.events = [...turn.events, { kind: "thinking", label: "思考过程", detail: event.event.text }];
      if (event.event.kind === "error") turn.error = event.event.message;
      if (event.event.kind === "system") turn.notice = `${turn.notice ?? ""}\n${event.event.text}`.trim();
      turns[index] = turn;
      break;
    }
    return { ...state, turns };
  }
  return state;
}

export function latestActiveDuetTurn(turns: DuetTurn[]): DuetTurn | null {
  return [...turns].reverse().find((turn) =>
    !turn.done && (turn.speaker === "A" || turn.speaker === "B"),
  ) ?? null;
}

export function rebuildDuetState(entries: PersistedDuetEntry[]): DuetState {
  let state = emptyDuet();
  for (const entry of entries) {
    if (isPersistedGate(entry)) state = applyDuetEvent(state, entry);
    else if (isPersistedProgress(entry)) state = applyDuetEvent(state, entry);
    else {
      const completed: DuetTurn = { ...entry, raised: !!entry.raised, events: entry.events ?? [], done: true };
      const turns = [...state.turns];
      let replaced = false;
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]!;
        if (turn.round !== completed.round || turn.speaker !== completed.speaker || turn.done) continue;
        // 旧 transcript 的回合行没有 events:别让落盘那份把实时攒到的执行过程抹掉。
        turns[index] = { ...completed, events: completed.events.length ? completed.events : turn.events };
        replaced = true;
        break;
      }
      state = { ...state, turns: replaced ? turns : [...turns, completed] };
    }
  }
  return state;
}
