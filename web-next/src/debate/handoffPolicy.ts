import type { Task, TaskStatus } from "@harness/shared";
import { isTeamSettled, workersOf } from "@harness/shared/team";
import type { DebateGate } from "./debateState.ts";

export function isOpenDebateGate(gate: DebateGate | null, status: TaskStatus): boolean {
  return !!gate?.open && status === "awaiting_review";
}

export function gateAllowsRevision(linkedTeam?: Pick<Task, "id"> | null): boolean {
  return !linkedTeam;
}

export function teamDebateIterationState(team: Task, allTasks: Task[]) {
  const origin = allTasks.find((item) => item.id === team.originTaskId);
  const existing = allTasks.find((item) => item.mode === "debate" && item.originTaskId === team.id);
  const settled = isTeamSettled(team.status === "running", workersOf(allTasks, team.id));
  return {
    eligible: team.mode === "team" && settled && origin?.mode === "debate",
    existing,
  };
}

// Team creation is the transaction boundary. These follow-ups must never throw
// back into the creation form: otherwise a partial failure invites duplicate teams.
export async function runCreatedHandoffFollowUps({
  closeGate,
  startTeam,
}: {
  closeGate: (() => Promise<unknown>) | null;
  startTeam: () => Promise<unknown>;
}): Promise<{ phase: "gate" | "start"; reason: unknown }[]> {
  const failures: { phase: "gate" | "start"; reason: unknown }[] = [];
  if (closeGate) {
    try { await closeGate(); }
    catch (reason) { failures.push({ phase: "gate", reason }); }
  }
  try { await startTeam(); }
  catch (reason) { failures.push({ phase: "start", reason }); }
  return failures;
}
