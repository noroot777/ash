import type { ServerEvent, DebateSpeaker, GateName, DebateConsensusBy } from "@harness/shared";

export type DebateTurn = {
  round: number;
  speaker: DebateSpeaker;
  text: string;
  tools: { name: string; detail?: string }[];
  raised: boolean;
  agrees?: boolean; // self-declared agreement with the opponent (only when raised)
  conclusion?: string; // self-declared one-line 结论
  done: boolean;
  error?: string;
  at?: string; // persisted speech instant; for user turns, when the human spoke
  startedAt?: string;
  durationMs?: number;
  target?: "A" | "B"; // for `user` turns: a 提问 directed at one debater (undefined = both)
};

export type DebateGate = {
  gate: GateName;
  open: boolean;
  consensus?: boolean;
  consensusBy?: DebateConsensusBy;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

export type DebateState = {
  turns: DebateTurn[];
  gate: DebateGate | null;
};

export type PersistedDebateTurn = Omit<DebateTurn, "tools" | "done" | "raised"> & { raised?: boolean };
export type PersistedDebateEntry = PersistedDebateTurn | Extract<ServerEvent, { type: "debate.gate" }>;

const isPersistedGate = (
  entry: PersistedDebateEntry,
): entry is Extract<ServerEvent, { type: "debate.gate" }> =>
  (entry as { type?: string }).type === "debate.gate";

export const emptyDebate = (): DebateState => ({ turns: [], gate: null });

// implementer/reviewer only occur in historical event streams.
const speakerOf = (role: string): DebateSpeaker =>
  role === "debaterB" ? "B" : role === "implementer" ? "impl" : role === "reviewer" ? "review" : "A";

// Fold a server event into a task's debate state (chat-timeline model, §12).
export function applyDebateEvent(s: DebateState, ev: ServerEvent): DebateState {
  if (ev.type === "debate.progress") {
    if (ev.phase === "start") {
      return { ...s, turns: [...s.turns, { round: ev.round, speaker: ev.speaker, text: "", tools: [], raised: false, done: false, startedAt: ev.startedAt ?? ev.at }] };
    }
    // phase end → mark the matching open turn done + raised
    const turns = [...s.turns];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].speaker === ev.speaker && !turns[i].done) {
        turns[i] = { ...turns[i], done: true, raised: !!ev.raisedHand, at: ev.at, startedAt: ev.startedAt ?? turns[i].startedAt, durationMs: ev.durationMs };
        break;
      }
    }
    return { ...s, turns };
  }
  if (ev.type === "debate.gate") {
    // A close event deliberately carries only `{open:false}`. Keep the verdict
    // from the matching open event so a finished debate can still hand its last
    // consensus/conclusions to `/team` instead of erasing them at approval time.
    const previous = s.gate?.gate === ev.gate ? s.gate : null;
    return {
      ...s,
      gate: {
        gate: ev.gate,
        open: ev.open,
        consensus: ev.consensus ?? previous?.consensus,
        consensusBy: ev.consensusBy ?? previous?.consensusBy ?? (ev.consensus ? "both" : undefined),
        conclusionA: ev.conclusionA ?? previous?.conclusionA,
        conclusionB: ev.conclusionB ?? previous?.conclusionB,
      },
    };
  }
  if (ev.type === "debate.user") {
    // The human's gate intervention, dropped into the timeline as its own turn.
    return {
      ...s,
      turns: [...s.turns, { round: ev.round, speaker: "user", text: ev.text, tools: [], raised: false, done: true, at: ev.at, target: ev.target }],
    };
  }
  if (ev.type === "agent.event") {
    const sp = speakerOf(ev.role);
    const turns = [...s.turns];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].speaker === sp && !turns[i].done) {
        const t = { ...turns[i] };
        const e = ev.event;
        if (e.kind === "text") t.text += e.text;
        else if (e.kind === "tool") t.tools = [...t.tools, { name: e.name, detail: e.detail }];
        else if (e.kind === "error") t.error = e.message;
        turns[i] = t;
        break;
      }
    }
    return { ...s, turns };
  }
  return s;
}

// Rebuild both the visible turns and the last gate verdict from transcript.jsonl.
// Older transcripts contain turns only; newer ones also contain debate.gate
// timeline events, which makes the handoff conclusion exact after a refresh.
export function rebuildDebateState(entries: PersistedDebateEntry[]): DebateState {
  let state = emptyDebate();
  for (const entry of entries) {
    if (isPersistedGate(entry)) {
      state = applyDebateEvent(state, entry);
      continue;
    }
    state = {
      ...state,
      turns: [...state.turns, { ...entry, raised: !!entry.raised, tools: [], done: true }],
    };
  }
  return state;
}
