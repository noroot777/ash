import type { DuetConsensusBy } from "@ash/shared";

export type DuetSettlementState = {
  raisedA: boolean;
  raisedB: boolean;
  agreesA: boolean;
  agreesB: boolean;
};

function bothRaised(state: DuetSettlementState): boolean {
  return state.raisedA && state.raisedB;
}

export function duetConsensusBy(state: DuetSettlementState): DuetConsensusBy | undefined {
  if (bothRaised(state)) return state.agreesA && state.agreesB ? "both" : undefined;
  if (state.raisedA && state.agreesA) return "A";
  if (state.raisedB && state.agreesB) return "B";
  return undefined;
}

export function canSettleDuet(state: DuetSettlementState): boolean {
  return bothRaised(state) || !!duetConsensusBy(state);
}

export function isDuetConsensus(state: DuetSettlementState): boolean {
  return !!duetConsensusBy(state);
}
