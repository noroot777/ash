import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { BranchPlanEntry, BranchPlanView, FamilyAcceptanceResult } from "@ash/shared";
import { familySelectionBlock } from "@ash/shared/branch-plan";
import { acceptPlan, isFinalHumanGate } from "@ash/shared/workflow-policy";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { branchDependency, branchName, branchRelationship, type BranchTask } from "./task-branch-plan.js";
import { expandHome, localBranchExists, resolveWorktreeBranchName, symbolicBranch } from "./git.js";
import { taskWorkflowDef } from "./workflows.js";
import { acceptanceGuard } from "./task-accept-guard.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import { withRepoLock } from "./repo-lock.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { updateTaskBase } from "./task-base-update.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import type { AcceptTaskResult } from "./task-accept.js";
import { beginAccepting, endAccepting } from "./acceptance-lock.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";
import { detectTaskWorkspace, discardTaskWorkspace } from "./workspace-cleanup.js";
import { workspaceParticipants } from "./task-workspace.js";
import { claimWorkspaceTurn, isTurnClaimed } from "./runs.js";
import { assertReadableWorktree, checkoutRecovery, removeMissingWorktreeRegistrations, UnreadableWorktreeError } from "./git-worktree-state.js";
import { targetCheckout } from "./git-accept.js";
import { branchPlanReads } from "./branch-plan-reads.js";

async function entry(task: BranchTask, repo: string, fingerprintTarget?: string | null,
  reads = branchPlanReads(repo, task.projectId)): Promise<BranchPlanEntry> {
  const target = await reads.target(task);
  const plan = acceptPlan(taskWorkflowDef(task.workflow), "human", task.workflowAt);
  const guard = await acceptanceGuard(task.id, "before_accept");
  let blocker = guard.failure?.error ?? null;
  let blockerLabel: string | undefined;
  if (!blocker && !isFinalHumanGate(taskWorkflowDef(task.workflow), task.workflowAt)) blocker = "尚在中途关口，请先完成任务流程";
  if (!blocker && task.workflowMode === "free" && !["done", "failed", "canceled"].includes(task.status)
    && task.stage !== "accepted" && task.stage !== "merged") blocker = "任务尚未结束";
  if (!blocker && task.workflowMode === "free" && task.stage !== "accepted" && await hasActiveFreeReview(task.id)) blocker = "审查仍在进行";
  const sourceBranch = await reads.branch(task.id);
  const sourceCommit = await reads.commit(sourceBranch);
  const targetCommit = target ? await reads.commit(target) : null;
  const targetError = !target ? "最终合入分支未确定，请重设合入目标"
    : !(await reads.exists(target)) ? `目标本地分支 ${target} 不存在，请重设合入目标` : null;
  const targetOwner = target ? await reads.owner(target) : undefined;
  const checkout = target && task.useWorktree && plan.merge && plan.merge !== "tag" && task.stage !== "accepted" && task.stage !== "merged"
    ? await reads.checkout(target) : null;
  if (!blocker && task.useWorktree && task.stage !== "accepted" && targetError) blocker = targetError;
  const targetWorkspaceRecovery = checkout?.path && !checkout.atRepo
    ? checkoutRecovery(checkout) ?? `分支 ${target} 的登记仍指向 ${checkout.path}，请核对该工作区的检出登记。` : null;
  const targetWorkspaceBlocker = checkout?.path && !checkout.atRepo
    ? `目标分支 ${target} 仍在工作区 ${checkout.path} 检出。${checkoutRecovery(checkout) ?? ""}${targetOwner
      ? `请先停止任务「${targetOwner.title}」的执行，在其「派生与验收」中释放工作区目录（保留分支），再单独验收本任务。`
      : "请先解除该工作区对目标分支的占用并保留分支，再验收；也可重设合入目标。"}` : null;
  if (!blocker && targetWorkspaceBlocker) {
    blockerLabel = "目标工作区仍被占用";
    blocker = targetWorkspaceBlocker;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([
    task.id, task.updatedAt, task.stage, task.workflow, task.workflowAt, task.workflowMode,
    task.status, task.worktreeStartCommit, task.baseTaskId, target, sourceCommit,
    fingerprintTarget === undefined ? targetCommit : fingerprintTarget,
    targetOwner?.id, checkout,
  ])).digest("hex");
  return {
    taskId: task.id, projectId: task.projectId, title: task.title, status: task.status, stage: task.stage,
    startCommit: task.worktreeStartCommit, targetBranch: target, targetTaskId: targetOwner?.id ?? null, sourceBranch, sourceCommit, targetCommit, targetWorkspaceBlocker, targetWorkspaceRecovery,
    strategy: plan.merge || "mark", dependency: task.baseUpdateIntent ? { taskId: task.baseTaskId, title: "父任务", state: "needs_update", message: "上次基线更新尚未结算，请重试更新基线以恢复" } : await branchDependency(task, repo, reads), blocker, blockerLabel, fingerprint, baseUpdatePending: !!task.baseUpdateIntent,
  };
}

export async function readBranchPlan(taskId: string): Promise<BranchPlanView | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!task || !project) return null;
  const rows = await db.select().from(tasks).where(eq(tasks.projectId, task.projectId));
  const reads = branchPlanReads(project.repoPath, task.projectId);
  const ordered = [task];
  const seen = new Set([task.id]);
  for (let i = 0; i < ordered.length; i++) {
    const parentBranch = await reads.branch(ordered[i].id);
    for (const child of rows) {
      if (seen.has(child.id) || !branchRelationship(child, ordered[i].id, parentBranch)) continue;
      seen.add(child.id);
      ordered.push(child);
    }
  }
  const entries: BranchPlanEntry[] = [];
  for (let offset = 0; offset < ordered.length; offset += 4) {
    entries.push(...await Promise.all(ordered.slice(offset, offset + 4).map(row => entry(row, project.repoPath, undefined, reads))));
  }
  return { task: entries[0], descendants: entries.slice(1) };
}

type Accept = (taskId: string) => Promise<AcceptTaskResult>;

export async function acceptFamily(
  taskId: string,
  expected: { taskId: string; fingerprint: string }[],
  accept: Accept,
): Promise<FamilyAcceptanceResult> {
  if (IS_PREVIEW_INSTANCE) return { ok: false, completed: [], error: previewRefusal("统一验收") };
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!task || !project) return { ok: false, completed: [], error: "任务不存在" };
  return withRepoLock(project.repoPath, async () => {
    const view = await readBranchPlan(taskId);
    const entries = view ? [view.task, ...view.descendants] : [];
    const ids = new Set(expected.map(e => e.taskId));
    if (!ids.has(taskId) || ids.size !== expected.length || expected.length > 100
      || expected.some(e => !entries.some(row => row.taskId === e.taskId && row.fingerprint === e.fingerprint))) {
      return { ok: false, completed: [], error: "验收范围或提交已变化，请刷新并重新核对" };
    }
    const chosen = entries.filter(e => ids.has(e.taskId));
    const blocked = chosen.find(e => e.stage !== "accepted" && e.blocker);
    if (blocked) return { ok: false, completed: [], stoppedAt: blocked.taskId, error: blocked.blocker! };
    const dependencyBlock = familySelectionBlock(entries, ids);
    if (dependencyBlock) return { ok: false, completed: [], stoppedAt: dependencyBlock.taskId, error: dependencyBlock.error };
    const completed: string[] = [];
    for (const row of chosen) {
      const currentTask = (await db.select().from(tasks).where(eq(tasks.id, row.taskId))).at(0);
      const current = currentTask ? await entry(currentTask, project.repoPath, row.targetCommit) : null;
      if (!current || current.fingerprint !== row.fingerprint) {
        const error = `「${row.title}」在验收期间已变化，后续任务未合入`;
        await appendTaskTimeline(taskId, `统一验收暂停：${error}；已完成 ${completed.join("、") || "无"}`);
        return { ok: false, completed, stoppedAt: row.taskId, error };
      }
      let result: AcceptTaskResult;
      try { result = await accept(row.taskId); }
      catch (cause) {
        const after = (await db.select().from(tasks).where(eq(tasks.id, row.taskId))).at(0);
        if (after?.stage === "accepted") completed.push(row.taskId);
        const error = cause instanceof Error ? cause.message : String(cause);
        await appendTaskTimeline(taskId, `统一验收暂停在「${row.title}」：${error}；已完成 ${completed.join("、") || "无"}，其余未执行。`);
        return { ok: false, completed, stoppedAt: row.taskId, error };
      }
      if (!result.accepted || (result.tail && !result.tail.ok)) {
        if (result.accepted) completed.push(row.taskId);
        const error = result.accepted ? "合并已完成，但验收后步骤失败" : result.error;
        await appendTaskTimeline(taskId, `统一验收暂停在「${row.title}」：${error}；已完成 ${completed.join("、") || "无"}，其余未执行。`);
        return { ok: false, completed, stoppedAt: row.taskId, error };
      }
      completed.push(row.taskId);
      await appendTaskTimeline(taskId, `统一验收：已完成「${row.title}」（${row.taskId}）`);
    }
    return { ok: true, completed };
  });
}

export function mountBranchPlanRoutes(api: Hono, accept: Accept): void {
  api.post("/tasks/:id/release-workspace", async c => {
    if (IS_PREVIEW_INSTANCE) return c.json({ error: previewRefusal("释放工作区目录") }, 409);
    const taskId = c.req.param("id");
    const body = await c.req.json<{ fingerprint?: string }>();
    if (typeof body?.fingerprint !== "string") return c.json({ error: "fingerprint required" }, 400);
    if (!beginAccepting(taskId)) return c.json({ error: "任务正在验收或更新工作区，请稍后重试" }, 409);
    try {
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
      const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
      if (!task || !project) return c.json({ error: "任务或项目不存在" }, 404);
      return await withRepoLock(project.repoPath, async () => {
        const guard = await acceptanceGuard(taskId, "before_cleanup");
        if (guard.failure) return c.json({ error: guard.failure.error }, 409);
        const current = guard.task!;
        if (!current.useWorktree) return c.json({ error: "只有独立工作区任务可以释放目录" }, 409);
        if (await hasActiveFreeReview(taskId)) return c.json({ error: "审查仍在进行，请等审查结束后释放工作区" }, 409);
        if ((await entry(current, project.repoPath)).fingerprint !== body.fingerprint) return c.json({ error: "任务或分支已变化，请刷新后重新确认" }, 409);
        const workspace = await detectTaskWorkspace(project.repoPath, taskId);
        if (!workspace.branch) return c.json({ error: "任务分支不存在，请先恢复分支再释放目录" }, 409);
        if (!workspace.path) {
          await removeMissingWorktreeRegistrations(expandHome(project.repoPath), { branch: workspace.branch });
          const remaining = await targetCheckout(project.repoPath, workspace.branch);
          if (remaining.path && !remaining.atRepo) return c.json({ error: `工作区 ${remaining.path}：${checkoutRecovery(remaining) || `分支 ${workspace.branch} 的占用尚未解除，请先解除占用并保留分支，再重试释放。`}` }, 409);
          return c.json({ ok: true });
        }
        try { await assertReadableWorktree(workspace.path, expandHome(project.repoPath), workspace.branch); }
        catch (error) {
          if (error instanceof UnreadableWorktreeError) return c.json({ error: error.message }, 409);
          throw error;
        }
        if (await symbolicBranch(workspace.path) !== workspace.branch) return c.json({ error: "工作区检出分支已变化，请先核对工作区" }, 409);
        const checkout = await targetCheckout(project.repoPath, workspace.branch);
        if (checkout.locked) return c.json({ error: `工作区 ${workspace.path}：${checkoutRecovery(checkout)}` }, 409);
        const peers = await workspaceParticipants(current, workspace.path);
        if (peers.some(p => p.status === "running" || p.status === "queued" || isTurnClaimed(p.id))) return c.json({ error: "工作区仍有任务在执行，请先停止再释放" }, 409);
        const release = claimWorkspaceTurn(peers.map(p => p.id));
        if (!release) return c.json({ error: "工作区刚被其它任务占用，请稍后重试" }, 409);
        try {
          const result = await discardTaskWorkspace(project.repoPath, taskId, { worktree: true, branch: false, force: false });
          if (!result.worktreeRemoved) return c.json({ error: result.worktreeError || "工作区未能释放，请刷新后重试" }, 409);
          await db.update(tasks).set({ updatedAt: now() }).where(eq(tasks.id, taskId));
          await appendTaskTimeline(taskId, `已释放工作区目录 ${workspace.path}，保留任务记录及分支 ${workspace.branch}；可继续处理合入这条分支的子任务。`);
          await publishTaskUpdated(taskId);
          return c.json({ ok: true });
        } finally { release(); }
      });
    } finally { endAccepting(taskId); }
  });
  api.post("/tasks/:id/merge-target", async c => {
    if (IS_PREVIEW_INSTANCE) return c.json({ error: previewRefusal("更改合入目标") }, 409);
    const taskId = c.req.param("id");
    const body = await c.req.json<{ branch?: string; fingerprint?: string }>();
    if (typeof body.branch !== "string" || !body.branch.trim() || typeof body.fingerprint !== "string") return c.json({ error: "branch and fingerprint required" }, 400);
    if (!beginAccepting(taskId)) return c.json({ error: "任务正在验收或更新基线" }, 409);
    try {
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
      const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
      if (!task || !project) return c.json({ error: "任务或项目不存在" }, 404);
      return await withRepoLock(project.repoPath, async () => {
        const guard = await acceptanceGuard(taskId, "before_merge");
        if (guard.failure) return c.json({ error: guard.failure.error }, 409);
        const current = guard.task!;
        if (!current.useWorktree || current.stage === "merged" || current.stage === "accepted" || current.acceptedMergeCommit) {
          return c.json({ error: "只有尚未合入的独立工作区任务可以更改目标" }, 409);
        }
        if (await hasActiveFreeReview(taskId)) return c.json({ error: "审查仍在进行，请等审查结束后更改目标" }, 409);
        const before = await entry(current, project.repoPath);
        if (before.fingerprint !== body.fingerprint) return c.json({ error: "任务或目标分支已变化，请刷新后重试" }, 409);
        const target = branchName(body.branch!);
        if (!(await localBranchExists(project.repoPath, target))) return c.json({ error: `目标本地分支 ${target} 不存在` }, 400);
        if (target === await resolveWorktreeBranchName(project.repoPath, taskId)) return c.json({ error: "合入目标不能是任务自身的分支" }, 400);
        await db.update(tasks).set({ mergeTargetBranch: target, acceptedTargetBranch: null, acceptedSourceCommit: null, updatedAt: now() }).where(eq(tasks.id, taskId));
        await appendTaskTimeline(taskId, `合入目标由 ${before.targetBranch || "未确定"} 更改为 ${target}；开工提交未变，请重新核对验收依赖与 diff。`);
        await publishTaskUpdated(taskId);
        return c.json({ ok: true });
      });
    } finally { endAccepting(taskId); }
  });
  api.get("/tasks/:id/branch-plan", async c => {
    const view = await readBranchPlan(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "not found" }, 404);
  });
  api.post("/tasks/:id/update-base", async c => {
    if (IS_PREVIEW_INSTANCE) return c.json({ ok: false, error: previewRefusal("更新子分支基线") }, 409);
    const body = await c.req.json<{ sourceCommit?: string }>();
    if (!body.sourceCommit || !/^[a-f0-9]{40,64}$/.test(body.sourceCommit)) return c.json({ error: "sourceCommit required" }, 400);
    const result = await updateTaskBase(c.req.param("id"), body.sourceCommit);
    return c.json(result, result.ok ? 200 : 409);
  });
  api.post("/tasks/:id/accept-family", async c => {
    const body = await c.req.json<{ entries?: { taskId: string; fingerprint: string }[] }>();
    if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 100
      || body.entries.some(e => !e || typeof e.taskId !== "string" || typeof e.fingerprint !== "string")) return c.json({ error: "entries required" }, 400);
    const result = await acceptFamily(c.req.param("id"), body.entries, accept);
    return c.json(result, result.ok ? 200 : 409);
  });
}
