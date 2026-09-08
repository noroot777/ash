import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks, taskBranchReceipts } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { expandHome, symbolicBranch, worktreePathFor, resolveWorktreeBranchName } from "./git.js";
import { branchDependency, baseRef, baseUpdateBackupPrefix, commitAt, inheritedParentCommit } from "./task-branch-plan.js";
import { withRepoLock } from "./repo-lock.js";
import { beginAccepting, endAccepting } from "./acceptance-lock.js";
import { acceptanceGuard } from "./task-accept-guard.js";
import { workspaceParticipants } from "./task-workspace.js";
import { isTurnClaimed, claimWorkspaceTurn } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { assertNotPreviewInstance } from "./preview-instance.js";
import { now } from "./util.js";

// 先记录目标提交再移动 Git；中断后的重试只完成同一份意图，不再次 rebase。
async function finishBaseUpdate(task: typeof tasks.$inferSelect, repo: string, held = false): Promise<{ ok: boolean; error?: string }> {
  const intent = JSON.parse(task.baseUpdateIntent!) as { head: string; rebased: string; target: string; branch: string; backup: string };
  const path = worktreePathFor(repo, task.id);
  const peers = await workspaceParticipants(task, path);
  if (!held && peers.some(p => p.status === "running" || p.status === "queued")) return { ok: false, error: "工作区正在执行，无法恢复基线更新" };
  const release = held ? () => {} : claimWorkspaceTurn(peers.map(p => p.id));
  if (!release) return { ok: false, error: "工作区正在执行，无法恢复基线更新" };
  try {
    if (task.archived || await symbolicBranch(path) !== intent.branch) return { ok: false, error: "任务已归档、接力或工作区已变化，未恢复基线更新" };
    if ((await exec("git", ["-C", path, "status", "--porcelain"])).stdout.trim()) return { ok: false, error: "工作区存在未提交文件，未恢复基线更新" };
    const current = await commitAt(repo, intent.branch);
    if (current !== intent.head && current !== intent.rebased) return { ok: false, error: "子分支已被其它操作修改，未覆盖；请核对基线更新记录" };
    if (current === intent.head) await exec("git", ["-C", path, "reset", "--keep", intent.rebased]);
    await exec("git", ["-C", repo, "update-ref", baseRef(task.id), intent.target]);
    await db.insert(taskBranchReceipts).values({ id: `${task.id}:${intent.head}:${intent.rebased}`, taskId: task.id, sourceCommit: intent.head, mergeCommit: intent.rebased, targetBranch: task.mergeTargetBranch! }).onConflictDoNothing();
    await db.update(tasks).set({ worktreeStartCommit: intent.target, acceptedSourceCommit: null,
      baseUpdateIntent: null, stage: null, updatedAt: now() }).where(eq(tasks.id, task.id));
    await appendTaskTimeline(task.id, `子分支基线已更新到 ${task.mergeTargetBranch}@${intent.target.slice(0, 8)}；旧提交保留在 ${intent.backup}。请核对 diff 并按影响范围重新验证，旧审查结论未自动沿用。`);
    await publishTaskUpdated(task.id);
    return { ok: true };
  } finally { release(); }
}

export async function updateTaskBase(taskId: string, expectedHead: string): Promise<{ ok: boolean; error?: string }> {
  assertNotPreviewInstance("更新子分支基线");
  if (!beginAccepting(taskId)) return { ok: false, error: "任务正在验收或更新基线" };
  try {
    let task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!task || !project) return { ok: false, error: "任务或项目不存在" };
    return await withRepoLock(project.repoPath, async () => {
      const guard = await acceptanceGuard(taskId, "before_merge");
      if (guard.failure && guard.failure.reason !== "base_update_pending") return { ok: false, error: guard.failure.error };
      task = guard.task!;
      if (task.baseUpdateIntent) return finishBaseUpdate(task, project.repoPath);
      if (task.stage === "accepted" || task.stage === "merged") return { ok: false, error: "本轮已经合入，不能重写任务分支" };
      const repo = expandHome(project.repoPath);
      const dep = await branchDependency(task, repo);
      if (dep?.state !== "needs_update" || !task.worktreeStartCommit || !task.mergeTargetBranch) {
        return { ok: false, error: dep?.message || "无需更新父成果基线" };
      }
      const branch = await resolveWorktreeBranchName(repo, taskId);
      const parent = task.baseTaskId ? (await db.select().from(tasks).where(eq(tasks.id, task.baseTaskId))).at(0) : undefined;
      const upstream = (await inheritedParentCommit(task, repo, parent))!;
      const head = await commitAt(repo, branch);
      const target = await commitAt(repo, task.mergeTargetBranch);
      if (!head || !target || head !== expectedHead) return { ok: false, error: "任务提交已经变化，请刷新后重试" };
      const path = worktreePathFor(repo, taskId);
      if (await symbolicBranch(path) !== branch) return { ok: false, error: "任务工作区不存在或检出分支已变化，请先恢复任务工作区" };
      const peers = await workspaceParticipants(task, path);
      if (peers.some(p => p.status === "running" || p.status === "queued" || isTurnClaimed(p.id))) {
        return { ok: false, error: "工作区仍有任务或审查在执行，请结束后重试" };
      }
      const clean = async () => !(await exec("git", ["-C", path, "status", "--porcelain"])).stdout.trim();
      if (!(await clean())) return { ok: false, error: "子任务工作区有未提交文件，请提交后再更新基线" };
      const release = claimWorkspaceTurn(peers.map(p => p.id));
      if (!release) return { ok: false, error: "工作区刚被其它任务占用，请稍后重试" };
      let root: string;
      try { root = await mkdtemp(join(tmpdir(), "ash-base-update-")); } catch (e) { release(); throw e; }
      const temp = join(root, "worktree");
      try {
        await exec("git", ["-C", repo, "worktree", "add", "--detach", temp, head]);
        try {
          await exec("git", ["-C", temp, "rebase", "--rebase-merges=rebase-cousins", "--no-update-refs", "--onto", target, upstream]);
        } catch {
          await exec("git", ["-C", temp, "rebase", "--abort"]).catch(() => {});
          const error = "更新基线发生冲突或 rebase 失败；原子分支和工作区未修改，请在子任务中处理后重新验证";
          await appendTaskTimeline(taskId, error);
          return { ok: false, error };
        }
        const rebased = await commitAt(temp, "HEAD");
        if (!rebased || !(await clean()) || await commitAt(repo, branch) !== head || await symbolicBranch(path) !== branch) {
          return { ok: false, error: "工作区在准备期间发生变化，未更新子分支" };
        }
        const backup = `${baseUpdateBackupPrefix(taskId)}${head}`;
        await exec("git", ["-C", repo, "update-ref", backup, head]);
        const intent = JSON.stringify({ head, rebased, target, branch, backup });
        await db.update(tasks).set({ baseUpdateIntent: intent, updatedAt: now() }).where(eq(tasks.id, taskId));
        return await finishBaseUpdate({ ...task, baseUpdateIntent: intent }, repo, true);
      } finally {
        release();
        await exec("git", ["-C", repo, "worktree", "remove", "--force", temp]).catch(() => {});
        await rm(root, { recursive: true, force: true });
        await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
      }
    });
  } finally { endAccepting(taskId); }
}
