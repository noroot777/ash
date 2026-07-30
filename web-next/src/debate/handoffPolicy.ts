import type { Task, TaskStatus } from "@harness/shared";
import type { DebateGate } from "./debateState.ts";

export function isOpenDebateGate(gate: DebateGate | null, status: TaskStatus): boolean {
  return !!gate?.open && status === "awaiting_review";
}

export function gateAllowsRevision(linkedTeam?: Pick<Task, "id"> | null): boolean {
  return !linkedTeam;
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
