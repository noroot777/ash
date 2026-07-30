import type { DebateConsensusBy, DebateSpeaker, GateName, ServerEvent } from "@harness/shared";

export type DebateTurn = {
  round: number;
  speaker: DebateSpeaker;
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

export type DebateGate = {
  gate: GateName;
  open: boolean;
  consensus?: boolean;
  consensusBy?: DebateConsensusBy;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

export type DebateState = { turns: DebateTurn[]; gate: DebateGate | null };
export type PersistedDebateTurn = Omit<DebateTurn, "tools" | "done" | "raised"> & { raised?: boolean };
export type PersistedDebateEntry = PersistedDebateTurn | Extract<ServerEvent, { type: "debate.gate" }>;

export const emptyDebate = (): DebateState => ({ turns: [], gate: null });

function isPersistedGate(entry: PersistedDebateEntry): entry is Extract<ServerEvent, { type: "debate.gate" }> {
  return (entry as { type?: string }).type === "debate.gate";
}

function speakerOf(role: string): DebateSpeaker {
  if (role === "debaterB") return "B";
  if (role === "implementer") return "impl";
  if (role === "reviewer") return "review";
  return "A";
}

export function applyDebateEvent(state: DebateState, event: ServerEvent): DebateState {
  if (event.type === "debate.progress") {
    if (event.phase === "start") {
      return {
        ...state,
        turns: [...state.turns, {
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
  if (event.type === "debate.gate") {
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
  if (event.type === "debate.user") {
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

export function rebuildDebateState(entries: PersistedDebateEntry[]): DebateState {
  let state = emptyDebate();
  for (const entry of entries) {
    if (isPersistedGate(entry)) state = applyDebateEvent(state, entry);
    else state = { ...state, turns: [...state.turns, { ...entry, raised: !!entry.raised, tools: [], done: true }] };
  }
  return state;
}
