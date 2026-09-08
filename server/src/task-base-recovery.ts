import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BaseUpdateRecovery } from "@ash/shared/branch-plan";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { expandHome, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { baseRef, baseUpdateBackupPrefix, commitAt, containsCommit } from "./task-branch-plan.js";
import { recordCompletedBaseUpdate } from "./task-base-record.js";
import { parseBaseUpdateIntent } from "./task-base-intent.js";
import { readBaseUpdateBackups, retainBaseUpdateBackups } from "./task-base-backups.js";
import { manualBaseProposal } from "./task-base-manual.js";
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

async function recovery(task: typeof tasks.$inferSelect, repo: string): Promise<BaseUpdateRecovery | null> {
  if (!task.baseUpdateIntent) return null;
  const intent = parseBaseUpdateIntent(task.baseUpdateIntent);
  const branch = await resolveWorktreeBranchName(repo, task.id);
  const currentCommit = await commitAt(repo, branch);
  const oldCommit = intent?.head ?? null;
  const preparedCommit = intent?.rebased ?? null;
  const backups: BaseUpdateRecovery["backups"] = [];
  const prefix = baseUpdateBackupPrefix(task.id);
  const existingBackups = await readBaseUpdateBackups(repo, task.id);
  const unavailableCommits: string[] = [];
  for (const [name, commit] of [["before", oldCommit], ["prepared", preparedCommit], [`current-${currentCommit}`, currentCommit]] as const) {
    if (!commit) continue;
    if (await commitAt(repo, commit)) backups.push({ ref: `${prefix}abandoned-${hash(task.baseUpdateIntent).slice(0, 16)}-${name}`, commit });
    else unavailableCommits.push(commit);
  }
  const startCommit = task.worktreeStartCommit;
  const targetCommit = intent?.target ?? null;
  let resolution: BaseUpdateRecovery["resolution"] = "blocked";
  let resolvedStartCommit: string | null = null;
  let blocker: string | null = null;
  if (currentCommit && preparedCommit && targetCommit && oldCommit && task.mergeTargetBranch
    && await containsCommit(repo, preparedCommit, currentCommit) && await containsCommit(repo, targetCommit, preparedCommit)) {
    resolution = "complete"; resolvedStartCommit = targetCommit; blocker = null;
  } else if (startCommit && await commitAt(repo, startCommit)
    && (!currentCommit || oldCommit && await containsCommit(repo, oldCommit, currentCommit) && await containsCommit(repo, startCommit, currentCommit))) {
    resolution = "abandon"; resolvedStartCommit = startCommit; blocker = null;
  }
  const pinned = await commitAt(repo, baseRef(task.id));
  let manual: BaseUpdateRecovery["manual"] = null;
  if (resolution === "blocked") {
    const proposal = await manualBaseProposal(repo, currentCommit, [
      [targetCommit, "拟以更新记录中的目标提交为起点。无法证明原准备结果仍对应当前分支，下面展示的是该起点到当前提交的实际差异。"],
      [pinned, "拟以仓库中仍存在的私有基点为起点。原更新记录不能自动结算，请核对下面的实际差异。"],
      [startCommit, "拟保留当前记录的开工起点。分支历史已变化，请核对下面的实际差异。"],
    ], task.mergeTargetBranch);
    resolvedStartCommit = proposal.start; manual = proposal.manual; blocker = proposal.blocker;
    resolution = blocker ? "blocked" : "manual";
  }
  const fingerprint = hash(JSON.stringify([task.id, task.baseUpdateIntent, task.updatedAt, task.mergeTargetBranch, branch, currentCommit, startCommit, pinned, existingBackups, backups, resolution, resolvedStartCommit, manual]));
  return { fingerprint, branch, currentCommit, startCommit, oldCommit, preparedCommit, resolution, resolvedStartCommit, blocker, backups, existingBackups, unavailableCommits, manual };
}

export async function readBaseUpdateRecovery(taskId: string): Promise<BaseUpdateRecovery | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  return task && project ? recovery(task, expandHome(project.repoPath)) : null;
}

export async function abandonTaskBaseUpdate(taskId: string, fingerprint: string, resolution: "abandon" | "complete" | "manual", acknowledged = false): Promise<{ ok: boolean; error?: string; message?: string }> {
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
        if (view.blocker) return { ok: false, error: view.blocker };
        if (view.resolution !== resolution) return { ok: false, error: "确认的处理方式与分支实际状态不符，请重新打开确认框核对" };
        if (resolution === "manual" && !acknowledged) return { ok: false, error: "请明确确认已核对基点和差异范围；当前提交与文件会保留，旧更新不会被记作完成" };
        for (const backup of view.backups) {
          const previous = await commitAt(repo, backup.ref);
          if (previous === backup.commit) continue;
          if (previous) return { ok: false, error: `恢复备份 ${backup.ref} 已变化，未覆盖；请先核对` };
          await exec("git", ["-C", repo, "update-ref", backup.ref, backup.commit, ""]);
        }
        if (view.resolution === "complete") {
          await recordCompletedBaseUpdate(repo, taskId, task.mergeTargetBranch!, {
            head: view.oldCommit!, rebased: view.preparedCommit!, target: view.resolvedStartCommit!,
          });
        } else {
          const pinned = await commitAt(repo, baseRef(taskId));
          if (view.resolvedStartCommit && pinned !== view.resolvedStartCommit) await exec("git", ["-C", repo, "update-ref", baseRef(taskId), view.resolvedStartCommit, pinned ?? ""]);
          if (!view.resolvedStartCommit && pinned) await exec("git", ["-C", repo, "update-ref", "-d", baseRef(taskId), pinned]);
          await db.update(tasks).set({ baseUpdateIntent: null, updatedAt: now(), ...(resolution === "manual"
            ? { worktreeStartCommit: view.resolvedStartCommit, acceptedSourceCommit: null, stage: null } : {}) }).where(eq(tasks.id, taskId));
        }
        const intent = parseBaseUpdateIntent(task.baseUpdateIntent!);
        const keep = [...view.backups.map(b => b.ref), ...(intent
          ? [intent.backup, `${baseUpdateBackupPrefix(taskId)}prepared-${intent.rebased}`]
          : view.existingBackups.map(b => b.ref))];
        const backupWarning = await retainBaseUpdateBackups(repo, taskId, keep);
        const message = !view.currentCommit
          ? "已解除本次基线更新挂起。任务分支已不存在，可读取的开工记录与备份已保留；未重建分支或工作区，请重新建立工作区或删除任务记录。"
          : view.resolution === "complete"
          ? "本次基线更新已改写分支，已按更新后的起点完成结算。当前提交、后续提交及工作区文件均已保留，请核对更新后的 diff 并重新验证。"
          : resolution === "manual"
            ? "已按核对的基点手动解除挂起，当前提交与工作区文件已保留。原更新未记作完成，请按新的 diff 范围重新审查；也可重设合入目标、释放工作区或删除任务。"
            : "已放弃本次基线更新。当前分支、工作区文件及开工记录已保留，请重新核对验收依赖。";
        await appendTaskTimeline(taskId, `${message} 本次恢复备份：${view.backups.map(b => b.ref).join("、") || "无新增"}。${backupWarning}`);
        await publishTaskUpdated(taskId);
        return { ok: true, message: `${message}${backupWarning}` };
      } finally { release(); }
    });
  } finally { endAccepting(taskId); }
}
