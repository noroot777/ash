export type BranchDependency = {
  taskId: string | null;
  title: string;
  state: "ready" | "waiting" | "needs_update" | "unknown";
  message: string;
};

export type BranchPlanEntry = {
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  stage: string | null;
  startCommit: string | null;
  targetBranch: string | null;
  sourceCommit: string | null;
  targetCommit: string | null;
  strategy: string;
  dependency: BranchDependency | null;
  blocker: string | null;
  baseUpdatePending: boolean;
  fingerprint: string;
};

export type BranchPlanView = { task: BranchPlanEntry; descendants: BranchPlanEntry[] };
export type FamilyAcceptanceResult = { ok: boolean; completed: string[]; stoppedAt?: string; error?: string };

export function familySelectionBlock(entries: BranchPlanEntry[], selected: ReadonlySet<string>): { taskId: string; error: string } | null {
  for (const row of entries) {
    if (!selected.has(row.taskId) || row.stage === "accepted") continue;
    const dep = row.dependency;
    if (!dep || dep.state === "ready") continue;
    if (dep.state === "waiting" && dep.taskId && selected.has(dep.taskId)) continue;
    const canSelect = dep.state === "waiting" && entries.some(e => e.taskId === dep.taskId && e.stage !== "accepted");
    return { taskId: row.taskId, error: canSelect
      ? `「${row.title}」依赖未勾选的父任务「${dep.title}」，请先核对并勾选该父任务，或单独合入其成果。`
      : `「${row.title}」：${dep.message}` };
  }
  return null;
}
