// 「合并后不提交」那一档的**收尾**：验收已经完成，改动却还躺在目标分支的工作区里没提交。
//
// 为什么要有这个文件（现场，2026-09-15）：用户在验收框里故意没勾「合并后提交代码」，
// 合并照做了，然后他卡住了 —— 界面上只剩一句和正常验收一模一样的「✓ 验收完成」，看不出
// 还欠一步，也找不到任何地方能收尾，最后是人手工 `git merge --no-ff` 把那份改动补进目标
// 分支的。所以这里做两件事：
//
// ① **核对现场**，不是复读 DB。验收之后用户在自己的终端里干了什么 ash 一概管不着：他
//    可能自己提交了、可能 `git reset --hard` 丢了、也可能又往暂存区里加了别的东西。所以
//    每次都去看一眼那份改动此刻的处境（PendingMergeKind 的五种态）。
// ② 给出那几条出路的动作：把索引里那份落成提交（`commitPendingMerge`），或者在产物已经
//    不在时重新合一次（`remergePendingMerge`）。
//
// 三条硬规矩，都是用户点名要的：
// · **不许自动替用户提交**，也不许自动 `-D` 强删分支 —— 这里的每个动作都由用户自己点。
// · **拿不准就拒绝**。判据只认内容证据：`acceptedPendingTree` 是合完那一刻
//   `git write-tree` 的结果，索引指纹与它逐字节一致才敢 `git commit`；不一致就意味着
//   索引里混进了别的东西，硬提交等于把用户后来自己 `git add` 的改动裹进这次合并。
// · **既定设计别动**：合并那一下用的是 `merge --squash` 且有意不留 MERGE_HEAD
//   （理由在 git-accept.ts），所以事后补的提交也是一个普通提交 —— git 依旧不认为任务
//   分支已合并，`git branch -d` 仍会拒绝，清理重跑时照实说，不改用 `-D`。
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { acceptPlan } from "@ash/shared/workflow-policy";
import type { PendingMergeActionResult, PendingMergeState } from "@ash/shared/accept-pending";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { expandHome, localBranchExists, resolveWorktreeBranchName, symbolicBranch } from "./git.js";
import {
  isAncestor,
  mergeTaskBranch,
  squashCommitMessage,
  targetCheckout,
  treeOfCommit,
  writeIndexTree,
} from "./git-accept.js";
import { cleanupAcceptedTask, cleanupPlanFor } from "./git-accept-cleanup.js";
import { execFileText as exec } from "./exec.js";
import { gitError } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { beginAccepting, endAccepting } from "./acceptance-lock.js";
import { acceptanceGuard } from "./task-accept-guard.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { recordBranchReceipt } from "./task-branch-receipts.js";
import { taskWorkflowDef } from "./workflows.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export type PendingMergeFailure = { ok: false; httpStatus: 404 | 409; reason: string; error: string };

/** 往目标分支上找「内容跟那次合并结果一致」的提交时，最多回溯这么多个。 */
const COMMIT_SCAN_LIMIT = 200;

function commitLabel(commit: string): string {
  return commit.slice(0, 8);
}

async function loadPendingTask(taskId: string): Promise<{ task: TaskRow; project: ProjectRow } | PendingMergeFailure> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return { ok: false, httpStatus: 404, reason: "not_found", error: "not found" };
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) {
    return { ok: false, httpStatus: 409, reason: "project_not_found", error: `任务所属项目 ${task.projectId} 不存在` };
  }
  return { task, project };
}

/** 这个任务身上有没有「合并后不提交」这回事。没有的话前端连卡片都不该画。 */
export function hasPendingMergeRecord(task: TaskRow): boolean {
  return task.acceptedMergeMethod === "no_commit";
}

/** 目标分支上 base 之后的提交里，有没有一个的内容正好是那次合并的结果。 */
async function commitWithTree(
  repo: string,
  base: string,
  target: string,
  tree: string,
): Promise<{ commit: string | null; scannedAll: boolean }> {
  let commits: string[] = [];
  try {
    const { stdout } = await exec("git", [
      "-C", repo, "rev-list", `--max-count=${COMMIT_SCAN_LIMIT + 1}`, `${base}..${target}`,
    ]);
    commits = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return { commit: null, scannedAll: false };
  }
  const scannedAll = commits.length <= COMMIT_SCAN_LIMIT;
  for (const commit of commits.slice(0, COMMIT_SCAN_LIMIT)) {
    if (await treeOfCommit(repo, commit) === tree) return { commit, scannedAll };
  }
  return { commit: null, scannedAll };
}

/** 未暂存改动 + 未跟踪文件（**不含**只在索引里的那些）：它们不会被带进这次提交。 */
function unstagedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .filter((line) => line.startsWith("??") || (line[1] ?? " ") !== " ")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function nameOnly(repo: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", repo, ...args]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/**
 * 现场核对。**调用方负责持仓库锁**（GET 路由自己加；两个动作在同一把锁里先核对再动手，
 * 免得核对和动手之间被别人插队）。这一层只读，不写任何东西。
 */
export async function inspectPendingMerge(task: TaskRow, project: ProjectRow): Promise<PendingMergeState> {
  const repo = expandHome(project.repoPath);
  const target = task.acceptedTargetBranch;
  const base = task.acceptedBaseCommit;
  const pendingTree = task.acceptedPendingTree;
  const sourceBranch = await resolveWorktreeBranchName(repo, task.id).catch(() => null);
  const sourceBranchExists = sourceBranch ? await localBranchExists(repo, sourceBranch) : false;
  const common = {
    taskId: task.id,
    repoPath: project.repoPath,
    targetBranch: target,
    sourceBranch,
    sourceBranchExists,
  };
  const unknown = (message: string, extra: Partial<PendingMergeState> = {}): PendingMergeState => ({
    ...common, kind: "unknown", message, canCommit: false,
    canRemerge: sourceBranchExists, ...extra,
  });
  const branchTail = sourceBranchExists
    ? `来源分支 ${sourceBranch} 还留着，那份改动在版本库里没丢。`
    : `来源分支${sourceBranch ? ` ${sourceBranch}` : ""}已经不在了。`;

  if (!target || !base) {
    return unknown(
      "这次验收没留下完整的合并快照（目标分支或合并前基准缺失），没法核对现场。"
        + `请自己确认那份改动在不在目标分支上。${branchTail}`,
      { canRemerge: false },
    );
  }
  if (!(await localBranchExists(repo, target))) {
    return unknown(`目标分支 ${target} 现在不存在（被删掉或改名了），没法核对那次合并的结果。${branchTail}`);
  }

  // 已经记下合并提交（用户自己提交过、或点过「现在提交」）：只需确认它还在目标分支上。
  if (task.acceptedMergeCommit) {
    const commit = task.acceptedMergeCommit;
    if (await isAncestor(repo, commit, target)) {
      return {
        ...common, kind: "committed", commit, canCommit: false, canRemerge: false,
        message: `那次「合并后不提交」的改动已经落成提交 ${commitLabel(commit)}，就在 ${target} 上，这件事收尾了。`,
      };
    }
    return unknown(
      `记录里这次合并落成的提交是 ${commitLabel(commit)}，但它已经不在 ${target} 上了`
        + `（多半被 reset 或 rebase 掉了）。${branchTail}`,
      { commit },
    );
  }

  const head = (await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${target}^{commit}`])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null));
  if (!head) return unknown(`读不出 ${target} 此刻指向哪个提交。${branchTail}`);

  // 目标分支前进了：用户很可能自己把这份改动提交了（手工 commit，或 merge --no-ff ——
  // 两者合出来的内容都跟 squash 的结果一致，所以按**内容**认，不按提交消息认）。
  if (head !== base) {
    const found = pendingTree ? await commitWithTree(repo, base, target, pendingTree) : null;
    if (found?.commit) {
      return {
        ...common, kind: "committed", commit: found.commit, canCommit: false, canRemerge: false,
        message: `你自己已经把那份改动提交了：${target} 上的 ${commitLabel(found.commit)} 内容与那次合并的结果完全一致。`,
      };
    }
    return unknown(
      `${target} 已经从 ${commitLabel(base)} 前进到 ${commitLabel(head)}，`
        + (pendingTree
          ? `但${found && !found.scannedAll ? `最近 ${COMMIT_SCAN_LIMIT} 个提交里` : "这些提交里"}没有一个的内容跟那次合并的结果一致，`
            + "所以认不出那份改动到底进去了没有。"
          : "而这次验收是在本功能之前做的、没留下内容指纹，没法核对。")
        + `请自己核对 ${target} 上有没有这份改动。${branchTail}`,
    );
  }

  // 目标分支一个提交都没多：那份改动要么还在索引里，要么被丢了。这两种都得看**项目目录**
  // 的索引，所以目标分支必须还检出在那儿（不提交那一档当初就是在那儿合的）。
  const checkout = await targetCheckout(repo, target);
  if (!checkout.atRepo) {
    const current = await symbolicBranch(repo);
    return unknown(
      `${target} 现在没有检出在项目目录 ${project.repoPath}（那里现在是 ${current ? `分支 ${current}` : "一个游离的提交"}）`
        + (checkout.path ? `，而是在 ${checkout.path}` : "")
        + "，所以看不到那次合并留下的暂存内容，也没法替你提交。"
        + `把项目目录切回 ${target} 再来看。${branchTail}`,
    );
  }
  const indexTree = await writeIndexTree(repo);
  if (!indexTree) {
    return unknown(`${project.repoPath} 的索引读不出来（可能有未解决的合并冲突），先把它收拾干净。${branchTail}`);
  }
  const baseTree = await treeOfCommit(repo, base);
  const porcelain = await exec("git", ["-C", repo, "status", "--porcelain"]).then(({ stdout }) => stdout).catch(() => "");
  const stagedFiles = await nameOnly(repo, ["diff", "--cached", "--name-only"]);
  const dirtyFiles = unstagedFiles(porcelain);

  if (pendingTree && indexTree === pendingTree) {
    return {
      ...common, kind: "staged", canCommit: true, canRemerge: false, stagedFiles, dirtyFiles,
      message: `那次合并的改动还躺在 ${target} 的工作区里暂存着，一个字没提交`
        + `（${stagedFiles.length} 个文件）。${target} 的提交历史仍停在 ${commitLabel(base)}。`
        + (dirtyFiles.length
          ? `另外这个工作区里还有 ${dirtyFiles.length} 个没暂存/没跟踪的文件，它们不会被带进这次提交。`
          : "")
        + `在你收尾之前，这个工作区都是「脏」的，同一仓库的下一次验收会因此暂停。${branchTail}`,
    };
  }
  if (baseTree && indexTree === baseTree && !stagedFiles.length) {
    return {
      ...common, kind: "discarded", canCommit: false, canRemerge: sourceBranchExists, dirtyFiles,
      message: `那次合并的改动已经不在 ${target} 的工作区里了（索引和 ${commitLabel(base)} 一致，`
        + "多半被 git reset --hard 丢掉了)。"
        + (sourceBranchExists
          ? `来源分支 ${sourceBranch} 还留着，可以重新合一次。`
          : `来源分支${sourceBranch ? ` ${sourceBranch}` : ""}也已经不在了，这份改动在本机没有别的副本。`),
    };
  }
  return {
    ...common, kind: "foreign", canCommit: false, canRemerge: false, stagedFiles, dirtyFiles,
    message: `${target} 的索引里现在的内容跟那次合并留下的不一样`
      + (pendingTree ? "（这中间有人动过暂存区）" : "（这次验收做在本功能之前，没留下内容指纹，没法核对）")
      + "，所以 ash 不替你提交 —— 硬提交会把无关改动一起裹进这次合并。"
      + `请自己在 ${project.repoPath} 里核对后提交，或 git -C ${project.repoPath} reset --hard 丢弃再重新验收。${branchTail}`,
  };
}

/**
 * 「用户自己已经提交了」时把快照补齐：`acceptedMergeCommit` 从 null 变成他那个提交。
 *
 * 放在读路径上是有意的 —— 这个事实是**核对现场**时才认出来的，而且补的是一个空字段、
 * 幂等、只写一次。不补的话「合并结果审查」「父成果依赖」这些靠快照的功能会一直等一个
 * 永远不来的提交。
 */
async function backfillCommitted(task: TaskRow, commit: string): Promise<void> {
  if (task.acceptedMergeCommit) return;
  await db.update(tasks).set({ acceptedMergeCommit: commit, updatedAt: now() }).where(eq(tasks.id, task.id));
  await recordBranchReceipt(task.id, true).catch(() => {});
  await appendTaskTimeline(
    task.id,
    `核对现场时发现：那次「合并后不提交」的改动你自己已经提交了（${commitLabel(commit)}，内容与合并结果一致），`
      + "已把合并快照补齐。",
  );
  await publishTaskUpdated(task.id);
}

export async function pendingMergeState(taskId: string): Promise<{ state: PendingMergeState | null } | PendingMergeFailure> {
  const loaded = await loadPendingTask(taskId);
  if ("ok" in loaded) return loaded;
  const { task, project } = loaded;
  if (!hasPendingMergeRecord(task)) return { state: null };
  const state = await withRepoLock(project.repoPath, () => inspectPendingMerge(task, project));
  if (state.kind === "committed" && state.commit) await backfillCommitted(task, state.commit);
  return { state };
}

/** 清理重跑：当初因为「没提交」跳过的那一步，现在再走一遍（仍然只用 `git branch -d`）。 */
async function rerunCleanup(task: TaskRow, project: ProjectRow, targetBranch: string): Promise<string[]> {
  const plan = acceptPlan(taskWorkflowDef(task.workflow), "human", task.workflowAt);
  const cleanPlan = cleanupPlanFor(plan.clean);
  if (!cleanPlan.worktree && !cleanPlan.branch) return [];
  const cleanup = await cleanupAcceptedTask(project.repoPath, task.id, targetBranch, cleanPlan);
  const notices = [...(cleanup.notices ?? [])];
  if (cleanup.ok) {
    notices.push(cleanup.branchDeleted
      ? `已用 git branch -d 删除 ${cleanup.sourceBranch}`
      : `分支 ${cleanup.sourceBranch} 保留（${cleanPlan.branch ? "git 不认为它已合并，按约定不强删" : "线上写的就是保留分支"}）`);
  } else if (cleanup.reason === "branch_not_merged") {
    // 这不是失败，是这一档**注定**的结果：事后补的那个提交是 squash 出来的新提交，
    // 任务分支永远不是目标分支的祖先，`git branch -d` 一定拒绝。照实说，绝不改用 -D。
    notices.push(`分支 ${cleanup.sourceBranch} 保留（这次合并是 squash 出来的新提交，git 不认为它已合并，按约定不强删）`);
  } else {
    // 清理没跑成不推翻这次提交 —— 提交已经发生且正确。如实报一句，让用户自己决定。
    notices.push(`清理未完成：${cleanup.message}（提交已经落下，不受影响）`);
  }
  return notices;
}

export async function commitPendingMerge(taskId: string): Promise<PendingMergeActionResult | PendingMergeFailure> {
  if (IS_PREVIEW_INSTANCE) {
    return { ok: false, httpStatus: 409, reason: "preview_instance", error: previewRefusal("提交这次合并") };
  }
  const loaded = await loadPendingTask(taskId);
  if ("ok" in loaded) return loaded;
  const { task, project } = loaded;
  if (!hasPendingMergeRecord(task) || task.acceptedMergeCommit) {
    return {
      ok: false, httpStatus: 409, reason: "not_pending",
      error: "这个任务没有「已合并但未提交」的改动等着收尾",
    };
  }
  // 与真正的验收（含尾段）互斥：那边正合并/正清理时，这边一句 commit 会落在半个世界上。
  if (!beginAccepting(taskId)) {
    return { ok: false, httpStatus: 409, reason: "acceptance_in_progress", error: "该任务正在验收中，等它结束再试" };
  }
  try {
    const guard = await acceptanceGuard(taskId, "before_merge");
    if (guard.failure) {
      return { ok: false, httpStatus: guard.failure.httpStatus, reason: guard.failure.reason, error: guard.failure.error };
    }
    return await withRepoLock(project.repoPath, async () => {
      // 核对和动手必须在同一把锁里：中间隔一次 await 就够别人插队改索引了。
      const state = await inspectPendingMerge(task, project);
      if (!state.canCommit || !state.targetBranch || !state.sourceBranch) {
        return { ok: false, httpStatus: 409, reason: state.kind, error: state.message } as PendingMergeFailure;
      }
      const repo = expandHome(project.repoPath);
      try {
        await exec("git", ["-C", repo, "commit", "-m", squashCommitMessage(state.sourceBranch)]);
      } catch (error) {
        const message = `git commit 失败：${gitError(error)}；索引里的改动一个字没动，可以修掉原因再试`;
        await appendTaskTimeline(taskId, `替你提交这次合并没成功：${message}`);
        return { ok: false, httpStatus: 409, reason: "commit_failed", error: message } as PendingMergeFailure;
      }
      const commit = await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${state.targetBranch}^{commit}`])
        .then(({ stdout }) => stdout.trim() || null)
        .catch(() => null);
      if (!commit || commit === task.acceptedBaseCommit) {
        const message = `git commit 跑完了，但 ${state.targetBranch} 仍停在 ${commitLabel(task.acceptedBaseCommit ?? "")}；`
          + "没有产生提交，请手动核对仓库状态。";
        await appendTaskTimeline(taskId, message);
        return { ok: false, httpStatus: 409, reason: "commit_missing", error: message } as PendingMergeFailure;
      }
      await db.update(tasks).set({ acceptedMergeCommit: commit, updatedAt: now() }).where(eq(tasks.id, taskId));
      await recordBranchReceipt(taskId, true).catch(() => {});
      const notices = await rerunCleanup(task, project, state.targetBranch);
      await appendTaskTimeline(
        taskId,
        `已把那次「合并后不提交」的改动落成提交 ${commitLabel(commit)}（${state.targetBranch}），`
          + `提交消息与正常验收一致。${notices.length ? `清理重跑：${notices.join("；")}。` : ""}`,
      );
      const updated = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? task;
      const after = await inspectPendingMerge(updated, project);
      await publishTaskUpdated(taskId);
      return {
        ok: true, state: after, commit, notices,
        message: `已提交 ${commitLabel(commit)} 到 ${state.targetBranch}。`,
      } as PendingMergeActionResult;
    });
  } finally {
    endAccepting(taskId);
  }
}

export async function remergePendingMerge(
  taskId: string,
  commitChoice: boolean | undefined,
): Promise<PendingMergeActionResult | PendingMergeFailure> {
  if (IS_PREVIEW_INSTANCE) {
    return { ok: false, httpStatus: 409, reason: "preview_instance", error: previewRefusal("重新合并这次验收") };
  }
  const loaded = await loadPendingTask(taskId);
  if ("ok" in loaded) return loaded;
  const { task, project } = loaded;
  if (!hasPendingMergeRecord(task) || task.acceptedMergeCommit) {
    return { ok: false, httpStatus: 409, reason: "not_pending", error: "这个任务没有等着收尾的「已合并但未提交」改动" };
  }
  if (!beginAccepting(taskId)) {
    return { ok: false, httpStatus: 409, reason: "acceptance_in_progress", error: "该任务正在验收中，等它结束再试" };
  }
  try {
    const guard = await acceptanceGuard(taskId, "before_merge");
    if (guard.failure) {
      return { ok: false, httpStatus: guard.failure.httpStatus, reason: guard.failure.reason, error: guard.failure.error };
    }
    // 合完落不落提交：这一次说了就按这一次的，没说就跟项目设置走（与验收那条路同口径）。
    const commit = commitChoice ?? project.acceptCommit !== false;
    return await withRepoLock(project.repoPath, async () => {
      const before = await inspectPendingMerge(task, project);
      if (!before.canRemerge || !before.targetBranch) {
        return { ok: false, httpStatus: 409, reason: before.kind, error: before.message } as PendingMergeFailure;
      }
      const plan = acceptPlan(taskWorkflowDef(task.workflow), "human", task.workflowAt);
      const merge = await mergeTaskBranch(project.repoPath, taskId, before.targetBranch, plan.merge ?? "safe", { commit });
      if (!merge.ok) {
        await appendTaskTimeline(taskId, `重新合并未完成：${merge.message}。目标分支没有被强制修改。`);
        return { ok: false, httpStatus: 409, reason: merge.reason, error: merge.message } as PendingMergeFailure;
      }
      const noCommit = merge.method === "no_commit";
      await db.update(tasks).set({
        acceptedTargetBranch: merge.targetBranch,
        acceptedBaseCommit: merge.beforeCommit ?? null,
        acceptedMergeCommit: noCommit ? null : merge.afterCommit ?? null,
        acceptedMergeMethod: merge.method,
        acceptedPendingTree: merge.stagedTree ?? null,
        updatedAt: now(),
      }).where(eq(tasks.id, taskId));
      if (!noCommit) await recordBranchReceipt(taskId, true).catch(() => {});
      const notices = noCommit ? [] : await rerunCleanup(task, project, merge.targetBranch);
      await appendTaskTimeline(
        taskId,
        `已重新合并：${merge.sourceBranch} → ${merge.targetBranch}`
          + (noCommit
            ? "（仍按「合并后不提交」，改动又躺在目标分支工作区里等你收尾）。"
            : `（这次落了提交 ${commitLabel(merge.afterCommit ?? "")}）。`)
          + `${notices.length ? `清理重跑：${notices.join("；")}。` : ""}`,
      );
      const updated = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? task;
      const after = await inspectPendingMerge(updated, project);
      await publishTaskUpdated(taskId);
      return {
        ok: true, state: after, notices,
        commit: noCommit ? null : merge.afterCommit ?? null,
        message: noCommit
          ? `已重新合进 ${merge.targetBranch} 的工作区并暂存，仍未提交。`
          : `已重新合并并提交 ${commitLabel(merge.afterCommit ?? "")}。`,
      } as PendingMergeActionResult;
    });
  } finally {
    endAccepting(taskId);
  }
}

export function mountPendingMergeRoutes(api: Hono): void {
  api.get("/tasks/:id/pending-merge", async (c) => {
    const result = await pendingMergeState(c.req.param("id"));
    if ("ok" in result) {
      const { httpStatus, ...body } = result;
      return httpStatus === 404 ? c.json(body, 404) : c.json(body, 409);
    }
    return c.json(result);
  });
  api.post("/tasks/:id/pending-merge/commit", async (c) => {
    const result = await commitPendingMerge(c.req.param("id"));
    if (result.ok) return c.json(result);
    const { httpStatus, ...body } = result;
    return httpStatus === 404 ? c.json(body, 404) : c.json(body, 409);
  });
  api.post("/tasks/:id/pending-merge/remerge", async (c) => {
    const input = await c.req.json<{ commit?: unknown }>().catch(() => null);
    // 跟验收那条路同一个口径：只认真正的布尔，别的一律当「没说」= 跟项目设置走。
    const commit = typeof input?.commit === "boolean" ? input.commit : undefined;
    const result = await remergePendingMerge(c.req.param("id"), commit);
    if (result.ok) return c.json(result);
    const { httpStatus, ...body } = result;
    return httpStatus === 404 ? c.json(body, 404) : c.json(body, 409);
  });
}
