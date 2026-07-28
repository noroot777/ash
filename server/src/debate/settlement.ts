import type { DebateConsensusBy } from "@harness/shared";

export type DebateSettlementState = {
  raisedA: boolean;
  raisedB: boolean;
  agreesA: boolean;
  agreesB: boolean;
};

function bothRaised(state: DebateSettlementState): boolean {
  return state.raisedA && state.raisedB;
}

export function debateConsensusBy(state: DebateSettlementState): DebateConsensusBy | undefined {
  if (bothRaised(state)) return state.agreesA && state.agreesB ? "both" : undefined;
  if (state.raisedA && state.agreesA) return "A";
  if (state.raisedB && state.agreesB) return "B";
  return undefined;
}

export function canSettleDebate(state: DebateSettlementState): boolean {
  return bothRaised(state) || !!debateConsensusBy(state);
}

export function isDebateConsensus(state: DebateSettlementState): boolean {
  return !!debateConsensusBy(state);
}
