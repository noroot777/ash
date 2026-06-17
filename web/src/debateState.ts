import type { ServerEvent, DebateSpeaker, GateName } from "@harness/shared";

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
};

export type DebateGate = {
  gate: GateName;
  open: boolean;
  consensus?: boolean;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

export type DebateState = {
  turns: DebateTurn[];
  gate: DebateGate | null;
};

export const emptyDebate = (): DebateState => ({ turns: [], gate: null });

const speakerOf = (role: string): DebateSpeaker =>
  role === "debaterB" ? "B" : role === "implementer" ? "impl" : "A";

// Fold a server event into a task's debate state (chat-timeline model, §12).
export function applyDebateEvent(s: DebateState, ev: ServerEvent): DebateState {
  if (ev.type === "debate.progress") {
    if (ev.phase === "start") {
      return { ...s, turns: [...s.turns, { round: ev.round, speaker: ev.speaker, text: "", tools: [], raised: false, done: false }] };
    }
    // phase end → mark the matching open turn done + raised
    const turns = [...s.turns];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].speaker === ev.speaker && !turns[i].done) {
        turns[i] = { ...turns[i], done: true, raised: !!ev.raisedHand };
        break;
      }
    }
    return { ...s, turns };
  }
  if (ev.type === "debate.gate") {
    return {
      ...s,
      gate: ev.open
        ? { gate: ev.gate, open: true, consensus: ev.consensus, conclusionA: ev.conclusionA, conclusionB: ev.conclusionB }
        : null,
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
