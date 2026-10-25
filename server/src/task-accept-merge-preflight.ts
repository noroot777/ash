import { acceptPlan } from "@ash/shared/workflow-policy";
import type { AcceptBy } from "@ash/shared/workflow-policy";
import { tasks, projects } from "./db/schema.js";
import { execFileText } from "./exec.js";
import { localBranchExists, resolveWorktreeBranchName } from "./git.js";
import { isAncestor, targetCheckout } from "./git-accept.js";
import { branchDependency, plannedMergeTarget } from "./task-branch-plan.js";
import { taskWorkflowDef } from "./workflows.js";
import type { AcceptFailure } from "./task-accept-guard.js";

export async function mergePreflight(task: typeof tasks.$inferSelect, project: typeof projects.$inferSelect | null,
  by: AcceptBy, commit?: boolean): Promise<AcceptFailure | null> {
  if (!project || !task.useWorktree || task.stage === "merged") return null;
  const plan = acceptPlan(taskWorkflowDef(task.workflow), by, task.workflowAt);
  if (!plan.merge || plan.merge === "tag") return null;
  const fail = (reason: string, error: string): AcceptFailure => ({ accepted: false, httpStatus: 409,
    taskId: task.id, status: task.status, reason, error });
  const dependency = await branchDependency(task, project.repoPath);
  if (dependency && dependency.state !== "ready") return fail(`base_${dependency.state}`, dependency.message);
  const target = await plannedMergeTarget(task, project.repoPath);
  if (!target) return fail("target_unresolved", "目标分支为空且项目当前处于 detached HEAD");
  if (!await localBranchExists(project.repoPath, target)) return fail("target_branch_missing", `目标分支 ${target} 不存在`);
  const source = await resolveWorktreeBranchName(project.repoPath, task.id);
  if (!await localBranchExists(project.repoPath, source)) return fail("source_branch_missing", `任务分支 ${source} 不存在`);
  if (source === target) return fail("source_equals_target", "任务分支不能同时作为验收目标分支");
  if (await isAncestor(project.repoPath, source, target)) return null;
  const checkout = await targetCheckout(project.repoPath, target);
  if (checkout.path && !checkout.atRepo) return fail("target_checked_out", `目标分支 ${target} 已在另一个 worktree ${checkout.path} 检出；未运行验收前置命令`);
  if (!checkout.atRepo && (commit ?? project.acceptCommit) === false) {
    return fail("target_not_checked_out", "合并后不提交要求目标分支检出在项目目录；未运行验收前置命令");
  }
  if (checkout.atRepo) {
    const { stdout } = await execFileText("git", ["-C", project.repoPath, "status", "--porcelain"]);
    if (stdout.trim()) return { ...fail("target_dirty", `目标分支 ${target} 的工作区不干净；未运行验收前置命令`),
      dirtyFiles: stdout.trimEnd().split("\n").map(line => line.slice(3)), targetBranch: target, targetPath: checkout.path! };
  }
  return null;
}
