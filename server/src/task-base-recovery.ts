import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BaseUpdateRecovery } from "@ash/shared/branch-plan";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { expandHome, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { baseRef, baseUpdateBackupPrefix, commitAt } from "./task-branch-plan.js";
import { beginAccepting, endAccepting } from "./acceptance-lock.js";
import { acceptanceGuard } from "./task-accept-guard.js";
import { withRepoLock } from "./repo-lock.js";
import { workspaceParticipants } from "./task-workspace.js";
import { claimWorkspaceTurn, isTurnClaimed } from "./runs.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import { assertNotPreviewInstance } from "./preview-instance.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const commitId = (value: unknown): string | null => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : null;

async function recovery(task: typeof tasks.$inferSelect, repo: string): Promise<BaseUpdateRecovery | null> {
  if (!task.baseUpdateIntent) return null;
  let intent: { head?: unknown; rebased?: unknown } = {};
  try { intent = JSON.parse(task.baseUpdateIntent) || {}; } catch { /* 损坏的意图也可显式放弃。 */ }
  const branch = await resolveWorktreeBranchName(repo, task.id);
  const currentCommit = await commitAt(repo, branch);
  const oldCommit = commitId(intent.head);
  const preparedCommit = commitId(intent.rebased);
  const backups: BaseUpdateRecovery["backups"] = [];
  const unavailableCommits: string[] = [];
  for (const [name, commit] of [["before", oldCommit], ["prepared", preparedCommit]] as const) {
    if (!commit) continue;
    if (await commitAt(repo, commit)) backups.push({ ref: `${baseUpdateBackupPrefix(task.id)}abandoned-${hash(task.baseUpdateIntent).slice(0, 16)}-${name}`, commit });
    else unavailableCommits.push(commit);
  }
  const startCommit = task.worktreeStartCommit;
  const pinned = await commitAt(repo, baseRef(task.id));
  const fingerprint = hash(JSON.stringify([task.id, task.baseUpdateIntent, task.updatedAt, branch, currentCommit, startCommit, pinned, backups]));
  return { fingerprint, branch, currentCommit, startCommit, oldCommit, preparedCommit, backups, unavailableCommits };
}

export async function readBaseUpdateRecovery(taskId: string): Promise<BaseUpdateRecovery | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  return task && project ? recovery(task, expandHome(project.repoPath)) : null;
}

export async function abandonTaskBaseUpdate(taskId: string, fingerprint: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  assertNotPreviewInstance("放弃本次基线更新");
  if (!beginAccepting(taskId)) return { ok: false, error: "任务正在验收或更新基线，请稍后重试" };
  try {
    const initial = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const project = initial && (await db.select().from(projects).where(eq(projects.id, initial.projectId))).at(0);
    if (!initial || !project) return { ok: false, error: "任务或项目不存在" };
    const repo = expandHome(project.repoPath);
    return await withRepoLock(repo, async () => {
      const guard = await acceptanceGuard(taskId, "before_merge", { allowBaseUpdatePending: true });
      if (guard.failure) return { ok: false, error: guard.failure.error };
      const task = guard.task!;
      if (await hasActiveFreeReview(taskId)) return { ok: false, error: "审查仍在进行，请等审查结束后再放弃基线更新" };
      const peers = await workspaceParticipants(task, worktreePathFor(repo, taskId));
      if (peers.some(p => p.status === "running" || p.status === "queued" || isTurnClaimed(p.id))) return { ok: false, error: "工作区仍在执行，请先停止再处理基线更新" };
      const release = claimWorkspaceTurn(peers.map(p => p.id));
      if (!release) return { ok: false, error: "工作区刚被其它任务占用，请稍后重试" };
      try {
        const view = await recovery(task, repo);
        if (!view || view.fingerprint !== fingerprint) return { ok: false, error: "基线更新记录或分支已变化，请重新打开确认框核对" };
        for (const backup of view.backups) {
          const previous = await commitAt(repo, backup.ref);
          if (previous === backup.commit) continue;
          if (previous) return { ok: false, error: `恢复备份 ${backup.ref} 已变化，未覆盖；请先核对` };
          await exec("git", ["-C", repo, "update-ref", backup.ref, backup.commit, ""]);
        }
        // finishBaseUpdate 可能已更新私有 ref，但尚未原子提交开工记录和清除意图。
        if (view.startCommit && await commitAt(repo, view.startCommit)) {
          const pinned = await commitAt(repo, baseRef(taskId));
          if (pinned !== view.startCommit) await exec("git", ["-C", repo, "update-ref", baseRef(taskId), view.startCommit, pinned ?? ""]);
        }
        await db.update(tasks).set({ baseUpdateIntent: null, updatedAt: now() }).where(eq(tasks.id, taskId));
        const message = "已放弃本次基线更新。当前分支、工作区文件及开工记录已保留，请重新核对验收依赖。";
        await appendTaskTimeline(taskId, `${message} 可读取的更新前及准备结果已保存在：${view.backups.map(b => b.ref).join("、") || "无"}。`);
        await publishTaskUpdated(taskId);
        return { ok: true, message };
      } finally { release(); }
    });
  } finally { endAccepting(taskId); }
}
