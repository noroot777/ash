// 合并预览档那一按的最终落地：git-accept.ts 的 mergeTaskBranchLocked 带着落地约束（测过的树 + 测的时候
// 目标分支所在的提交）时转到这里。
//
// 不变量：落下的就是门禁测过的那棵树、落在被测时的目标提交之上；落不成就**什么都不动**。所以结果
// 在任何检出之外生成（`commit-tree`，树就是测过的那棵），再只用「快进到它」发布 —— 检出里
// `merge --ff-only`，没有检出时带旧值的 `update-ref`。两种发布要么整份落下、要么原样失败，失败不需要
// 撤回，也就不会把期间另一个终端提交到目标分支上的东西一并撤掉（第 4 轮复审 F1：旧做法先在用户
// 检出里真合、树不对再 `reset --hard` 回合并前，连带抹掉了外部提交，还报「目标分支没动」）。
//
// 代价：生成结果这一步不经过 merge / commit 的那几个钩子（pre-merge-commit、commit-msg…）；检出里的
// 快进照常触发 post-merge。门禁就是这一档的检查，钩子再改一遍树，落下的就又不是测过的那棵了。
import { execFileText as exec } from "./exec.js";
import { gitError } from "./git.js";
import { registeredCheckout } from "./git-worktree-state.js";
import type { TaskMergeResult } from "./git-accept.js";

/** 落地约束：落下来的必须是这棵树，而且目标分支得还在被测时那个提交上。 */
export type LandingGuard = { tree: string; target: string };
type Names = { sourceBranch: string; targetBranch: string };
type Published = "merge_commit" | "squash" | "fast_forward";

const rev = async (cwd: string, ref: string): Promise<string | null> =>
  (await exec("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", ref]).catch(() => null))?.stdout.trim() || null;

export const movedTarget = (targetBranch: string, tested: string, now: string | null) =>
  `目标分支 ${targetBranch} 在门禁测过之后动了（测的时候在 ${tested.slice(0, 12)}，现在${now ? `在 ${now.slice(0, 12)}` : "读不到"}），`
  + "这时候合出来的已经不是测过的那一棵，所以这次没有合并，ash 没有动目标分支（它现在的提交原样留着）。重新验收会按现在的目标分支重新预演、重新跑门禁。";

const refusal = (names: Names, message: string): TaskMergeResult => ({ ok: false, reason: "merge_failed", message, ...names });

/**
 * 生成要发布的那个提交（不碰任何检出）。快进就是任务分支那个提交本身（它的树得正是测过的那棵）；
 * 合并提交以被测的目标提交和任务分支为父，squash 只以目标提交为父。
 */
export async function testedResultCommit(repo: string, method: Published, guard: LandingGuard, sourceRef: string,
  message: string, names: Names): Promise<string | TaskMergeResult> {
  if (method === "fast_forward") {
    return await rev(repo, `${sourceRef}^{tree}`) === guard.tree ? (await rev(repo, `${sourceRef}^{commit}`))!
      : refusal(names, `快进落下的会是任务分支那棵树，不是验收前置命令测过的那一棵（${guard.tree.slice(0, 12)}），没有合并。重新验收会重新跑门禁。`);
  }
  const parents = method === "merge_commit" ? ["-p", guard.target, "-p", sourceRef] : ["-p", guard.target];
  try {
    return (await exec("git", ["-C", repo, "commit-tree", guard.tree, ...parents, "-m", message])).stdout.trim();
  } catch (error) {
    return refusal(names, `没能生成合并结果：${gitError(error)}`);
  }
}

/** 目标分支检出在这里（已核过干净）：只许快进到生成好的那个提交。 */
export async function publishInCheckout(cwd: string, method: Published, guard: LandingGuard, result: string,
  names: Names): Promise<TaskMergeResult> {
  const head = await rev(cwd, "HEAD");
  if (head !== guard.target) return refusal(names, movedTarget(names.targetBranch, guard.target, head));
  try {
    await exec("git", ["-C", cwd, "merge", "--ff-only", result]);
  } catch (error) {
    const now = await rev(cwd, "HEAD");
    return refusal(names, now !== guard.target ? movedTarget(names.targetBranch, guard.target, now)
      : `快进到测过的合并结果失败（${gitError(error)}），目标分支没动。`);
  }
  return { ok: true, ...names, method };
}

/**
 * 目标分支哪儿都没检出：带旧值原子地挪 ref（核对之后被别人挪过就失败）。挪完再看一眼它是不是在
 * 这期间被检出了 —— 是的话那份检出的文件还是旧的，把**自己刚挪的这一下**原子地挪回去（只在它还指着
 * 我们的结果时），不碰别的。
 */
export async function publishRefOnly(repo: string, method: Published, guard: LandingGuard, result: string,
  names: Names): Promise<TaskMergeResult> {
  const ref = `refs/heads/${names.targetBranch}`;
  try {
    await exec("git", ["-C", repo, "update-ref", "-m", `ash accept: ${names.sourceBranch}`, ref, result, guard.target]);
  } catch {
    return refusal(names, movedTarget(names.targetBranch, guard.target, await rev(repo, ref)));
  }
  const checkout = await registeredCheckout(repo, names.targetBranch).catch(() => ({ path: null }));
  if (!checkout.path) return { ok: true, ...names, method };
  const undone = await exec("git", ["-C", repo, "update-ref", ref, guard.target, result]).then(() => true, () => false);
  return refusal(names, `目标分支 ${names.targetBranch} 在合并的同时被检出到了 ${checkout.path}，`
    + (undone ? "已把这次的更新退回、那份检出没动。" : `没能退回这次的更新：它现在指着 ${result.slice(0, 12)}，合并之前是 ${guard.target.slice(0, 12)}。`)
    + "重新验收即可。");
}

/**
 * 「合并后不提交」：把目标提交那棵树到测过的那棵之间的改动落进检出的索引和工作区（两树 read-tree，
 * 会覆盖本地改动或未跟踪文件时 git 自己拒绝），不落提交。落完核对暂存的正是测过的那棵；对不上
 * 就如实说，不替用户复位工作区。
 */
export async function stageTestedTree(cwd: string, guard: LandingGuard, names: Names): Promise<TaskMergeResult> {
  const head = await rev(cwd, "HEAD");
  if (head !== guard.target) return refusal(names, movedTarget(names.targetBranch, guard.target, head));
  try {
    await exec("git", ["-C", cwd, "read-tree", "-m", "-u", guard.target, guard.tree]);
  } catch (error) {
    return refusal(names, `把测过的改动落进工作区失败（${gitError(error)}），目标分支和工作区都没动。`);
  }
  const staged = (await exec("git", ["-C", cwd, "write-tree"]).catch(() => null))?.stdout.trim() ?? null;
  if (staged === guard.tree && await rev(cwd, "HEAD") === guard.target) {
    return { ok: true, ...names, method: "no_commit", stagedTree: staged };
  }
  return refusal(names, `工作区里暂存的（${staged?.slice(0, 12) ?? "读不到"}）不是验收前置命令测过的那一棵（${guard.tree.slice(0, 12)}）：`
    + "落的同时目标检出被别人动过。ash 没有替你复位，请在那个检出里核对后用 `git reset --merge` 或手动处理，再重新验收。");
}
