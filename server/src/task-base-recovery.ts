import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BaseUpdateRecovery } from "@ash/shared/branch-plan";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { expandHome, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { baseRef, baseUpdateBackupPrefix, commitAt, containsCommit } from "./task-branch-plan.js";
import { recordCompletedBaseUpdate } from "./task-base-record.js";
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
  let intent: { head?: unknown; rebased?: unknown; target?: unknown } = {};
  try { intent = JSON.parse(task.baseUpdateIntent) || {}; } catch { /* 下方按可证明的提交关系决定能否解除挂起。 */ }
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
  const targetCommit = commitId(intent.target);
  let resolution: BaseUpdateRecovery["resolution"] = "blocked";
  let resolvedStartCommit: string | null = null;
  let blocker: string | null = "无法证明当前分支对应更新前或准备结果，未解除挂起。请从恢复备份核对并恢复分支历史，再重新打开此处。";
  if (currentCommit && preparedCommit && targetCommit && oldCommit && task.mergeTargetBranch
    && await containsCommit(repo, preparedCommit, currentCommit) && await containsCommit(repo, targetCommit, preparedCommit)) {
    resolution = "complete"; resolvedStartCommit = targetCommit; blocker = null;
  } else if (startCommit && await commitAt(repo, startCommit)
    && (!currentCommit || oldCommit && await containsCommit(repo, oldCommit, currentCommit) && await containsCommit(repo, startCommit, currentCommit))) {
    resolution = "abandon"; resolvedStartCommit = startCommit; blocker = null;
  } else if (!startCommit || !await commitAt(repo, startCommit)) {
    blocker = "开工提交未记录或已无法读取，不能保留不确定的 diff 基点。请先恢复开工提交或准备结果对应的分支历史，再重新核对；当前代码和挂起记录均未修改。";
  }
  const pinned = await commitAt(repo, baseRef(task.id));
  const fingerprint = hash(JSON.stringify([task.id, task.baseUpdateIntent, task.updatedAt, task.mergeTargetBranch, branch, currentCommit, startCommit, pinned, backups, resolution, resolvedStartCommit]));
  return { fingerprint, branch, currentCommit, startCommit, oldCommit, preparedCommit, resolution, resolvedStartCommit, blocker, backups, unavailableCommits };
}

export async function readBaseUpdateRecovery(taskId: string): Promise<BaseUpdateRecovery | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  return task && project ? recovery(task, expandHome(project.repoPath)) : null;
}

export async function abandonTaskBaseUpdate(taskId: string, fingerprint: string, resolution: "abandon" | "complete"): Promise<{ ok: boolean; error?: string; message?: string }> {
  assertNotPreviewInstance("处理未完成的基线更新");
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
      if (await hasActiveFreeReview(taskId)) return { ok: false, error: "审查仍在进行，请等审查结束后再处理基线更新" };
      const peers = await workspaceParticipants(task, worktreePathFor(repo, taskId));
      if (peers.some(p => p.status === "running" || p.status === "queued" || isTurnClaimed(p.id))) return { ok: false, error: "工作区仍在执行，请先停止再处理基线更新" };
      const release = claimWorkspaceTurn(peers.map(p => p.id));
      if (!release) return { ok: false, error: "工作区刚被其它任务占用，请稍后重试" };
      try {
        const view = await recovery(task, repo);
        if (!view || view.fingerprint !== fingerprint) return { ok: false, error: "基线更新记录或分支已变化，请重新打开确认框核对" };
        if (view.blocker || !view.resolvedStartCommit) return { ok: false, error: view.blocker || "无法确定恢复后的开工提交" };
        if (view.resolution !== resolution) return { ok: false, error: "确认的处理方式与分支实际状态不符，请重新打开确认框核对" };
        for (const backup of view.backups) {
          const previous = await commitAt(repo, backup.ref);
          if (previous === backup.commit) continue;
          if (previous) return { ok: false, error: `恢复备份 ${backup.ref} 已变化，未覆盖；请先核对` };
          await exec("git", ["-C", repo, "update-ref", backup.ref, backup.commit, ""]);
        }
        if (view.resolution === "complete") {
          await recordCompletedBaseUpdate(repo, taskId, task.mergeTargetBranch!, {
            head: view.oldCommit!, rebased: view.preparedCommit!, target: view.resolvedStartCommit,
          });
        } else {
          const pinned = await commitAt(repo, baseRef(taskId));
          if (pinned !== view.resolvedStartCommit) await exec("git", ["-C", repo, "update-ref", baseRef(taskId), view.resolvedStartCommit, pinned ?? ""]);
          await db.update(tasks).set({ baseUpdateIntent: null, updatedAt: now() }).where(eq(tasks.id, taskId));
        }
        const message = view.resolution === "complete"
          ? "本次基线更新已改写分支，已按更新后的起点完成结算。当前提交、后续提交及工作区文件均已保留，请核对更新后的 diff 并重新验证。"
          : "已放弃本次基线更新。当前分支、工作区文件及开工记录已保留，请重新核对验收依赖。";
        await appendTaskTimeline(taskId, `${message} 可读取的更新前及准备结果已保存在：${view.backups.map(b => b.ref).join("、") || "无"}。`);
        await publishTaskUpdated(taskId);
        return { ok: true, message };
      } finally { release(); }
    });
  } finally { endAccepting(taskId); }
}
