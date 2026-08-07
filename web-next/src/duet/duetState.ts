import type { DuetConsensusBy, DuetSpeaker, GateName, ServerEvent } from "@harness/shared";

export type DuetTurn = {
  round: number;
  speaker: DuetSpeaker;
  text: string;
  tools: { name: string; detail?: string }[];
  raised: boolean;
  agrees?: boolean;
  conclusion?: string;
  done: boolean;
  error?: string;
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
export type PersistedDuetTurn = Omit<DuetTurn, "tools" | "done" | "raised"> & { raised?: boolean };
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
          tools: [],
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
        tools: [],
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
      if (event.event.kind === "tool") turn.tools = [...turn.tools, { name: event.event.name, detail: event.event.detail }];
      if (event.event.kind === "error") turn.error = event.event.message;
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
      const completed: DuetTurn = { ...entry, raised: !!entry.raised, tools: [], done: true };
      const turns = [...state.turns];
      let replaced = false;
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]!;
        if (turn.round !== completed.round || turn.speaker !== completed.speaker || turn.done) continue;
        turns[index] = completed;
        replaced = true;
        break;
      }
      state = { ...state, turns: replaced ? turns : [...turns, completed] };
    }
  }
  return state;
}
