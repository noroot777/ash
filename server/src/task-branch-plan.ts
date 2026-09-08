import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks, projects, taskBranchReceipts } from "./db/schema.js";
import { expandHome, localBranchExists, resolveTaskMergeTarget, resolveWorktreeBranchName } from "./git.js";
import { execFileText as exec } from "./exec.js";
import { withRepoLock } from "./repo-lock.js";

export type BranchTask = typeof tasks.$inferSelect;
export const baseRef = (id: string) => `refs/ash/task-bases/${encodeURIComponent(id)}`;
export const acceptedHeadRef = (id: string) => `refs/ash/accepted-heads/${encodeURIComponent(id)}`;
export const branchName = (ref: string) => ref.trim().replace(/^refs\/heads\//, "");

export async function commitAt(repo: string, ref: string): Promise<string | null> {
  try {
    return (await exec("git", ["-C", expandHome(repo), "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.trim();
  } catch { return null; }
}

export async function restoreAcceptedStart(task: { id: string; worktreeStartCommit?: string | null }, repo: string): Promise<void> {
  if (!task.worktreeStartCommit || await commitAt(repo, await resolveWorktreeBranchName(repo, task.id))) return;
  const head = await commitAt(repo, acceptedHeadRef(task.id));
  if (!head) return;
  await exec("git", ["-C", expandHome(repo), "update-ref", baseRef(task.id), head]);
  await db.update(tasks).set({ worktreeStartCommit: head, updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id));
  task.worktreeStartCommit = head;
}

export async function deleteTaskBranchRefs(taskId: string): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) return;
  await withRepoLock(project.repoPath, async () => {
    for (const ref of [baseRef(taskId), acceptedHeadRef(taskId)]) {
      const head = await commitAt(project.repoPath, ref);
      if (head) await exec("git", ["-C", expandHome(project.repoPath), "update-ref", "-d", ref, head]);
    }
  });
}

export async function containsCommit(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return exec("git", ["-C", expandHome(repo), "merge-base", "--is-ancestor", ancestor, descendant])
    .then(() => true, () => false);
}

export async function branchOwner(repo: string, projectId: string, branch: string): Promise<BranchTask | undefined> {
  const rows = await db.select().from(tasks).where(eq(tasks.projectId, projectId));
  for (const row of rows) {
    if (row.useWorktree && await resolveWorktreeBranchName(repo, row.id) === branchName(branch)) return row;
  }
  return undefined;
}

async function finalTarget(repo: string, row: BranchTask, seen = new Set<string>()): Promise<string | null> {
  if (seen.has(row.id)) throw new Error("派生任务的验收依赖存在循环");
  seen.add(row.id);
  if (row.mergeTargetBranch) return row.mergeTargetBranch;
  const oldTarget = row.acceptedTargetBranch || row.worktreeBase;
  const parent = oldTarget ? await branchOwner(repo, row.projectId, oldTarget) : undefined;
  return parent && parent.id !== row.id
    ? finalTarget(repo, parent, seen)
    : resolveTaskMergeTarget(repo, oldTarget);
}

// 起点钉住提交，目标钉住分支。私有 ref 让尚未启动的子任务在父分支清理后仍可开工。
export async function initializeBranchPlan(row: typeof tasks.$inferInsert & { id: string }, repo: string): Promise<void> {
  if (!row.useWorktree || row.reviewOf || row.worktreeStartCommit || row.stage === "accepted" || row.stage === "merged") return;
  const explicitTarget = row.mergeTargetBranch?.trim();
  if (explicitTarget && !(await localBranchExists(repo, branchName(explicitTarget)))) {
    throw new HTTPException(400, { res: Response.json({ error: `最终合入分支 ${explicitTarget} 不存在，请选择本地分支` }, { status: 400 }) });
  }
  let base = row.worktreeBase?.trim() || null;
  let parent: BranchTask | undefined;
  if (!base && row.parentId) {
    const lead = (await db.select().from(tasks).where(eq(tasks.id, row.parentId))).at(0);
    // 团队默认隔离执行者在各自起跑时从共享分支开叉，串行后续执行者能看到领队的新提交。
    if (lead?.projectId === row.projectId && lead.mode === "team") return;
  }
  if (base) parent ??= await branchOwner(repo, row.projectId, base);
  const start = await commitAt(repo, base || "HEAD");
  // 空仓库和失效基线沿用运行时的惰性准备 / staleBaseFallback；此刻没有可冻结的提交。
  if (!start) return;
  const target = row.mergeTargetBranch?.trim()
    ? branchName(row.mergeTargetBranch)
    : parent ? await finalTarget(repo, parent) : await resolveTaskMergeTarget(repo, base && await localBranchExists(repo, branchName(base)) ? base : null);
  row.worktreeBase = base;
  row.worktreeStartCommit = start;
  row.mergeTargetBranch = target;
  row.baseTaskId = parent?.id ?? null;
  await exec("git", ["-C", expandHome(repo), "update-ref", baseRef(row.id), start, ""]);
}

export type BranchDependency = {
  taskId: string | null;
  title: string;
  state: "ready" | "waiting" | "needs_update" | "unknown";
  message: string;
};

export async function plannedMergeTarget(task: BranchTask, repo: string): Promise<string | null> {
  if (task.baseTaskId && !task.mergeTargetBranch) return null;
  return task.acceptedTargetBranch || resolveTaskMergeTarget(repo, task.mergeTargetBranch || task.worktreeBase);
}

export async function inheritedParentCommit(task: BranchTask, repo: string, parent?: BranchTask): Promise<string | null> {
  let inherited = task.worktreeStartCommit;
  if (parent && inherited) {
    const source = await resolveWorktreeBranchName(repo, task.id);
    const parentBranch = await resolveWorktreeBranchName(repo, parent.id);
    try {
      const common = (await exec("git", ["-C", expandHome(repo), "merge-base", source, parentBranch])).stdout.trim();
      if (await containsCommit(repo, inherited, common)) inherited = common;
    } catch { /* 父分支已清理时，冻结起点仍是依赖证据。 */ }
  }
  return inherited;
}

export async function branchDependency(task: BranchTask, repo: string): Promise<BranchDependency | null> {
  if (!task.baseTaskId) return null;
  const parent = (await db.select().from(tasks).where(eq(tasks.id, task.baseTaskId))).at(0);
  const title = parent?.title ?? task.baseTaskId;
  const result = (state: BranchDependency["state"], message: string): BranchDependency =>
    ({ taskId: parent?.id ?? null, title, state, message });
  if (!task.mergeTargetBranch) return result("unknown", "最终合入分支未确定，请在「派生与验收」中重设合入目标，再检查父成果依赖");
  if (!task.worktreeStartCommit) return result("unknown", "未记录继承的父提交，请恢复任务的开工记录后再验收");
  const inherited = (await inheritedParentCommit(task, repo, parent))!;
  if (await containsCommit(repo, inherited, task.mergeTargetBranch)) {
    return result("ready", `继承的父成果已进入 ${task.mergeTargetBranch}`);
  }
  const receipts = await db.select().from(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, task.baseTaskId));
  for (const receipt of receipts) {
    if (await containsCommit(repo, inherited, receipt.sourceCommit) && await containsCommit(repo, receipt.mergeCommit, task.mergeTargetBranch)) {
      return result("needs_update", `「${title}」依赖的版本经提交历史调整后已合入 ${task.mergeTargetBranch}，需要更新子分支基线并核对验证结果`);
    }
  }
  if (!parent) return result("unknown", "来源任务记录已不存在，且无法证明继承的代码已进入目标分支；请恢复来源记录或核对并更新子分支");
  const merged = parent.acceptedMergeCommit && parent.acceptedBaseCommit
    && parent.acceptedMergeCommit !== parent.acceptedBaseCommit
    && await containsCommit(repo, parent.acceptedMergeCommit, task.mergeTargetBranch);
  if (merged && parent.acceptedSourceCommit
    && await containsCommit(repo, inherited, parent.acceptedSourceCommit)) {
    return result("needs_update", `「${title}」已压缩合入 ${task.mergeTargetBranch}，需要更新子分支基线并核对验证结果`);
  }
  return result("waiting", `等待「${title}」的父成果合入 ${task.mergeTargetBranch}；任务结束或仅打标签不代表代码已合入`);
}

export async function dependentTasks(repo: string, projectId: string, taskId: string): Promise<BranchTask[]> {
  const branch = await resolveWorktreeBranchName(repo, taskId);
  const rows = await db.select().from(tasks).where(eq(tasks.projectId, projectId));
  const blocked: BranchTask[] = [];
  for (const row of rows) {
    if (row.id === taskId || row.stage === "accepted") continue;
    if (row.baseTaskId === taskId) {
      if ((await branchDependency(row, repo))?.state !== "ready") blocked.push(row);
    } else if (!row.mergeTargetBranch && branchName(row.acceptedTargetBranch || row.worktreeBase || "") === branch) {
      blocked.push(row);
    }
  }
  return blocked;
}

export async function branchDeletionBlock(repo: string, taskId: string, projectId?: string, deleteRefs = true): Promise<string | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task && !projectId) return null;
  if (task?.baseUpdateIntent) return "上次基线更新尚未结算，请先重试更新基线再删除或清理";
  if (!deleteRefs) return null;
  const dependents = await dependentTasks(repo, task?.projectId || projectId!, taskId);
  return dependents.length
    ? `仍有 ${dependents.length} 个任务依赖此任务的分支或验收记录：${dependents.map(t => `「${t.title}」（${t.id}）${t.archived ? "［已归档，可在归档列表中处理］" : ""}`).join("、")}。先合入父成果并处理子任务依赖，再删除；清理不能解除验收依赖。`
    : null;
}
