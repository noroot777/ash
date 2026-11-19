import type { Task, TaskStatus } from "@navi/shared";
import type { DuetGate } from "./duetState.ts";

export function isOpenDuetGate(gate: DuetGate | null, status: TaskStatus): boolean {
  return !!gate?.open && status === "awaiting_review";
}

export function gateAllowsRevision(linkedTeam?: Pick<Task, "id"> | null): boolean {
  return !linkedTeam;
}

// Task creation is the transaction boundary. These follow-ups must never throw
// back into the creation form: otherwise a partial failure invites duplicate tasks.
export async function runCreatedHandoffFollowUps({
  closeGate,
  startTask,
}: {
  closeGate: (() => Promise<unknown>) | null;
  startTask: () => Promise<unknown>;
}): Promise<{ phase: "gate" | "start"; reason: unknown }[]> {
  const failures: { phase: "gate" | "start"; reason: unknown }[] = [];
  if (closeGate) {
    try { await closeGate(); }
    catch (reason) { failures.push({ phase: "gate", reason }); }
  }
  try { await startTask(); }
  catch (reason) { failures.push({ phase: "start", reason }); }
  return failures;
}
