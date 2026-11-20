// 推送档的合并：结果在任何用户检出之外生成，先推远程、远程收下了才快进本地目标分支（task-accept-push.ts 文件头）。
//
// 不变量：**推的是这里生成的那个提交**（`result`），它在 Navi 自己的临时 detached 检出里合出来、或直接
// `commit-tree` 出来（合并预览档），别人碰不到；本地目标分支在推上去之前一个字节都不动。所以推不上去时
// 没有「退回」这一步，推上去之后本地快进不了（期间被挪了、检出里的改动会被覆盖）也只是本地落后，远程那份
// 就是这一次合并（审查第 3 轮 F1：原先推的是「推那一刻目标分支指着谁」，合并被另一个终端撤回时照样报推送成功）。
//
// 合并的四种结局跟就地合并（git-accept.ts）同一套判断与措辞：已经合过、能快进就快进、三方合并、squash；
// 合并预览档用门禁测过的那棵树直接生成（git-accept-tested.ts testedResultCommit）。
import type { AcceptStrategy } from "@navi/shared/workflow";
import { execFileText as exec } from "./exec.js";
import { gitError } from "./git.js";
import {
  commitOf, isAncestor, mergeInCheckedOutTarget, mergeInputs, publishTestedResult, squashCommitMessage,
  squashInCheckedOutTarget, treeOfCommit, withTemporaryCleanupOutcome,
  type TaskMergeOptions, type TaskMergeResult, type TaskMergeWarning,
} from "./git-accept.js";
import { alreadyLandedUntested, movedTarget, testedResultCommit, type LandingGuard } from "./git-accept-tested.js";
import { addTemporaryWorktree, removeTemporaryWorktree } from "./git-accept-temp.js";
import { moveBranchGuarded } from "./git-guarded-move.js";

type Failure = Extract<TaskMergeResult, { ok: false }>;

/** 生成好、还没落到本地目标分支的那一次合并。`result === base` = 早已合过（推的就是目标分支现在那一头）。 */
export type DetachedMerge = {
  ok: true;
  method: "already_merged" | "fast_forward" | "merge_commit" | "squash";
  sourceBranch: string;
  targetBranch: string;
  /** 生成时目标分支所在的提交（结果的父提交 / 快进的起点）。 */
  base: string;
  result: string;
  guard: LandingGuard | null;
  warnings?: TaskMergeWarning[];
};

const mergeMessage = (sourceBranch: string, targetBranch: string) => `Merge branch '${sourceBranch}' into ${targetBranch}`;

/** 生成合并结果，不碰任何用户检出、不挪目标分支。冲突照就地合并的口径报 merge_conflict（调用方交回任务）。 */
export async function mergeDetached(repoPath: string, taskId: string, requestedTarget: string | null | undefined,
  strategy: AcceptStrategy, options: TaskMergeOptions): Promise<DetachedMerge | Failure> {
  const inputs = await mergeInputs(repoPath, taskId, requestedTarget, options);
  if (!inputs.ok) return inputs;
  const { repo, sourceBranch, targetBranch, sourceRef } = inputs;
  const names = { sourceBranch, targetBranch };
  const fail = (reason: Failure["reason"], message: string): Failure => ({ ok: false, reason, message, ...names });
  if (strategy === "tag" || options.commit === false) return fail("merge_failed", "这一档验收不产生提交，没有可推的");
  const base = await commitOf(repo, `refs/heads/${targetBranch}`);
  if (!base) return fail("target_branch_missing", `目标本地分支 ${targetBranch} 不存在`);
  const guard: LandingGuard | null = options.expectedTree && !options.retryOfMerged
    ? { tree: options.expectedTree, target: options.expectedTarget ?? base, physical: options.expectedPhysical ?? null } : null;
  if (guard && base !== guard.target) return fail("merge_failed", movedTarget(targetBranch, guard.target, base));
  const done = (method: DetachedMerge["method"], result: string, warnings?: TaskMergeWarning[]): DetachedMerge =>
    ({ ok: true, method, ...names, base, result, guard, ...(warnings?.length ? { warnings } : {}) });

  if (await isAncestor(repo, sourceRef, base)) {
    if (guard && await treeOfCommit(repo, base) !== guard.tree) {
      return fail("merge_failed", `目标分支 ${targetBranch} 已经包含任务分支，但它现在那棵树不是验收前置命令测过的那一棵，没有把这次记成验收通过。重新验收会按现在的目标分支重新跑门禁。`);
    }
    const untested = guard ? await alreadyLandedUntested(repo, guard, names) : null;
    if (untested && !untested.ok) return untested;
    return done("already_merged", base);
  }
  if (guard) {
    const method = strategy === "squash" ? "squash" : await isAncestor(repo, base, sourceRef) ? "fast_forward" : "merge_commit";
    const message = method === "squash" ? squashCommitMessage(sourceBranch) : mergeMessage(sourceBranch, targetBranch);
    const result = await testedResultCommit(repo, method, guard, sourceRef, message, names);
    return typeof result === "string" ? done(method, result) : result as Failure;
  }
  const source = await commitOf(repo, sourceRef);
  if (!source) return fail("source_branch_missing", `任务分支 ${sourceBranch} 不存在`);
  if (strategy !== "squash" && await isAncestor(repo, base, source)) return done("fast_forward", source);

  // 三方合并 / squash：在 Navi 自己的临时 detached 检出里合（钩子、提交身份照常），合完读那份检出的 HEAD ——
  // 那份检出只有这里在用，读到的就是合出来的那个提交。
  let temp;
  try { temp = await addTemporaryWorktree(repo, base, true); }
  catch (error) { return fail("merge_failed", `创建临时合并 worktree 失败：${gitError(error)}`); }
  let outcome: DetachedMerge | Failure;
  try {
    const merged = strategy === "squash"
      ? await squashInCheckedOutTarget(temp.path, sourceBranch, targetBranch, true, source)
      : await mergeInCheckedOutTarget(temp.path, sourceBranch, targetBranch, false, source, mergeMessage(sourceBranch, targetBranch));
    if (!merged.ok) outcome = merged;
    else if (merged.method === "already_merged") outcome = done("already_merged", base);
    else {
      const head = (await exec("git", ["-C", temp.path, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      outcome = head && head !== base ? done(merged.method === "squash" ? "squash" : "merge_commit", head)
        : fail("merge_failed", "合并没有产生新的提交");
    }
  } catch (error) {
    outcome = fail("merge_failed", `合并失败：${gitError(error)}`);
  }
  const cleaned = withTemporaryCleanupOutcome(outcome.ok ? { ok: true, ...names, method: "merge_commit" } : outcome,
    await removeTemporaryWorktree(repo, temp), temp.path);
  if (!outcome.ok) return cleaned as Failure;
  return cleaned.ok && cleaned.warnings ? { ...outcome, warnings: cleaned.warnings } : outcome;
}

/**
 * 远程收下之后，把本地目标分支快进到推上去的那个提交。合并预览档走测过的发布（检出里的字节核对同就地合并）；
 * 其余走带护栏挪分支（检出着时持锁、只在它还指着 base 时挪、会覆盖检出里改动的路径就不动）。
 */
export async function landDetached(repoPath: string, merged: DetachedMerge): Promise<{ ok: true } | { ok: false; message: string }> {
  if (merged.result === merged.base) return { ok: true };
  const names = { sourceBranch: merged.sourceBranch, targetBranch: merged.targetBranch };
  if (merged.guard && merged.method !== "already_merged") {
    const published = await publishTestedResult(repoPath, merged.guard, merged.method, merged.result, names);
    return published.ok ? { ok: true } : { ok: false, message: published.message };
  }
  const moved = await moveBranchGuarded(repoPath, merged.targetBranch, merged.base, merged.result,
    `把推上去的合并快进进本地 ${merged.targetBranch}`);
  return moved.ok ? { ok: true } : { ok: false, message: moved.message };
}
