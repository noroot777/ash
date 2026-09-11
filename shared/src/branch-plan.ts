import type { UnexecutedVerification } from "./workflow-policy.ts";

export type BranchDependency = {
  taskId: string | null;
  title: string;
  state: "ready" | "waiting" | "needs_update" | "unknown";
  message: string;
  legacyTarget?: boolean;
};

export type BranchPlanEntry = {
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  stage: string | null;
  startCommit: string | null;
  targetBranch: string | null;
  targetTaskId?: string | null;
  sourceCommit: string | null;
  sourceBranch?: string;
  targetCommit: string | null;
  strategy: string;
  dependency: BranchDependency | null;
  blocker: string | null;
  blockerLabel?: string;
  targetWorkspaceBlocker?: string | null;
  targetWorkspaceRecovery?: string | null;
  baseUpdatePending: boolean;
  fingerprint: string;
  unexecutedVerification?: UnexecutedVerification | null;
};

export type BranchPlanView = { task: BranchPlanEntry; descendants: BranchPlanEntry[] };
export type FamilyAcceptanceResult = { ok: boolean; completed: string[]; stoppedAt?: string; error?: string };

export type BaseUpdateRecovery = {
  fingerprint: string;
  branch: string;
  currentCommit: string | null;
  startCommit: string | null;
  oldCommit: string | null;
  preparedCommit: string | null;
  resolution: "abandon" | "complete" | "manual" | "blocked";
  resolvedStartCommit: string | null;
  blocker: string | null;
  backups: { ref: string; commit: string }[];
  existingBackups: { ref: string; commit: string }[];
  unavailableCommits: string[];
  manual: { basis: string; files: string[]; fileCount: number; diff: string; truncated: boolean } | null;
};

export function familySelectionBlock(entries: BranchPlanEntry[], selected: ReadonlySet<string>): { taskId: string; error: string } | null {
  for (const row of entries) {
    if (!selected.has(row.taskId) || row.stage === "accepted") continue;
    const dep = row.dependency;
    if (dep?.legacyTarget && dep.taskId && selected.has(dep.taskId)) {
      return { taskId: row.taskId, error: `「${row.title}」：${dep.message}` };
    }
    if (row.targetTaskId && selected.has(row.targetTaskId) && row.strategy !== "tag") {
      return { taskId: row.taskId, error: `「${row.title}」仍合入所选任务的分支 ${row.targetBranch}，不能一起统一验收。请先释放目标任务的工作区目录（保留分支），单独验收子任务，再继续处理目标任务。` };
    }
    if (!dep || dep.state === "ready") continue;
    if (dep.state === "waiting" && dep.taskId && selected.has(dep.taskId)) continue;
    const canSelect = dep.state === "waiting" && entries.some(e => e.taskId === dep.taskId && e.stage !== "accepted");
    return { taskId: row.taskId, error: canSelect
      ? `「${row.title}」依赖未勾选的父任务「${dep.title}」，请先核对并勾选该父任务，或单独合入其成果。`
      : `「${row.title}」：${dep.message}` };
  }
  return null;
}

export function familyAcceptanceNotices(entries: BranchPlanEntry[]): string[] {
  return entries.flatMap(row => {
    const dep = row.dependency;
    const parent = dep?.state === "waiting" && entries.find(e => e.taskId === dep.taskId && e.stage !== "accepted" && e.strategy === "squash");
    return parent ? [`「${parent.title}」将压缩合入；这条依赖链本次只能先合入父任务，随后暂停在「${row.title}」。请更新子分支基线并核对改动，再继续验收。`] : [];
  });
}
