import { branchOwner, commitAt, containsCommit, plannedMergeTarget } from "./task-branch-plan.js";
import type { BranchTask } from "./task-branch-plan.js";
import { expandHome, localBranchExists, resolveTaskMergeTarget, resolveWorktreeBranchName } from "./git.js";
import { targetCheckout } from "./git-accept.js";
import { execFileText as exec } from "./exec.js";

function memo<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const values = new Map<string, Promise<T>>();
  return key => {
    let value = values.get(key);
    if (!value) { value = read(key); values.set(key, value); }
    return value;
  };
}

// 同一次家族读取共享父分支、目标分支和祖先查询；每次刷新、每一步验收均创建新实例。
export function branchPlanReads(repo: string, projectId: string) {
  const branch = memo((id: string) => resolveWorktreeBranchName(repo, id));
  const target = memo((name: string) => resolveTaskMergeTarget(repo, name || null));
  const contains = memo((key: string) => {
    const [ancestor, descendant] = JSON.parse(key) as [string, string];
    return containsCommit(repo, ancestor, descendant);
  });
  return {
    branch,
    commit: memo((ref: string) => commitAt(repo, ref)),
    exists: memo((name: string) => localBranchExists(repo, name)),
    owner: memo((name: string) => branchOwner(repo, projectId, name, branch)),
    checkout: memo((name: string) => targetCheckout(repo, name)),
    target: (task: BranchTask) => plannedMergeTarget(task, repo, name => target(name || "")),
    contains: (ancestor: string, descendant: string) => contains(JSON.stringify([ancestor, descendant])),
    common: async (source: string, parent: string) => (await exec("git", ["-C", expandHome(repo), "merge-base", source, parent])).stdout.trim(),
  };
}

export type BranchPlanReads = ReturnType<typeof branchPlanReads>;
