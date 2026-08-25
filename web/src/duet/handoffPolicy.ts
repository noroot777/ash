import type { Task, TaskListItem, TaskStatus } from "@ash/shared";
import { isTeamSettled, teamNeverStarted, workersOf } from "@ash/shared/team";
import type { DuetGate } from "./duetState.ts";

export function isOpenDuetGate(gate: DuetGate | null, status: TaskStatus): boolean {
  return !!gate?.open && status === "awaiting_review";
}

export function gateAllowsRevision(linkedTeam?: Pick<Task, "id"> | null): boolean {
  return !linkedTeam;
}

export function teamDuetIterationState(team: TaskListItem, allTasks: TaskListItem[]) {
  const origin = allTasks.find((item) => item.id === team.originTaskId);
  const existing = allTasks.find((item) => item.mode === "duet" && item.originTaskId === team.id);
  const settled = isTeamSettled(team.status === "running", workersOf(allTasks, team.id));
  return {
    // 复盘讨论要先读调度台的执行记录，所以从没开过台的团队（创建成功但启动失败，仍停在
    // backlog）没有记录可读——后端只能 409，按钮就是个死路，这里直接不给。
    eligible: team.mode === "team" && settled && !teamNeverStarted(team.status) && origin?.mode === "duet",
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
