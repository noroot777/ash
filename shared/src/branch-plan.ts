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
