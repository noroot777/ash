// 合并预览档那一按的最终落地：git-accept.ts 的 mergeTaskBranchLocked 带着落地约束（测过的树 + 测的时候
// 目标分支所在的提交 + 测过的物理内容）时转到这里。
//
// 不变量：落下的就是门禁测过的那棵树、落在被测时的目标提交之上，目标检出里的字节就是快照里测过的那份；
// 落不成就**什么都不动**。所以结果在任何检出之外生成（`commit-tree`，树就是测过的那棵），再只用
// 「快进到它」发布 —— 检出里 `merge --ff-only`，没有检出时带旧值的 `update-ref`。两种发布要么整份落下、
// 要么原样失败，失败不需要撤回，也就不会把期间另一个终端提交到目标分支上的东西一并撤掉（第 4 轮复审
// F1：旧做法先在用户检出里真合、树不对再 `reset --hard` 回合并前，连带抹掉了外部提交）。
//
// 发布这几条 git 一律不调用户钩子、不调 fsmonitor（landingGit）：门禁就是这一档的检查，`post-merge`
// 之类在发布那一刻再改一遍目标分支或文件，落下的就又不是测过的那份（第 5 轮复审 F1 实测：钩子落了
// 一个提交，返回却是合并成功），而且那是门禁命令之外的项目程序。发布之后再核一遍后置条件：目标分支、
// HEAD 指着刚发布的结果、树是测过的那棵、检出里的字节是测过的那份；对不上就如实说，不替用户复位。
//
// 物理内容（第 5 轮复审 F2）：门禁起跑时把快照里被测的字节记成摘要（accept-gate-physical.ts）。发布前
// 核目标检出里合并不重写的那些文件还是那份，发布后核整棵树。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutMatches, type GatePhysical } from "./accept-gate-physical.js";
import { execFileText as exec } from "./exec.js";
import { gitError } from "./git.js";
import { registeredCheckout } from "./git-worktree-state.js";
import type { TaskMergeResult } from "./git-accept.js";

/** 落地约束：落下来的必须是这棵树，目标分支得还在被测时那个提交上，检出里的字节得是测过的那份。 */
export type LandingGuard = { tree: string; target: string; physical: GatePhysical | null };
type Names = { sourceBranch: string; targetBranch: string };
type Published = "merge_commit" | "squash" | "fast_forward";

let noHooks: Promise<string> | null = null;
/** 发布用的 git：钩子目录指向一个空目录，fsmonitor 关掉。 */
const landingGit = async (cwd: string, args: string[]) => {
  noHooks ??= mkdtemp(join(tmpdir(), "ash-no-hooks-"));
  return exec("git", ["-C", cwd, "-c", `core.hooksPath=${await noHooks}`, "-c", "core.fsmonitor=false", ...args]);
};

const rev = async (cwd: string, ref: string): Promise<string | null> =>
  (await exec("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", ref]).catch(() => null))?.stdout.trim() || null;

export const movedTarget = (targetBranch: string, tested: string, now: string | null) =>
  `目标分支 ${targetBranch} 在门禁测过之后动了（测的时候在 ${tested.slice(0, 12)}，现在${now ? `在 ${now.slice(0, 12)}` : "读不到"}），`
  + "这时候合出来的已经不是测过的那一棵，所以这次没有合并，ash 没有动目标分支（它现在的提交原样留着）。重新验收会按现在的目标分支重新预演、重新跑门禁。";

const refusal = (names: Names, message: string): TaskMergeResult => ({ ok: false, reason: "merge_failed", message, ...names });

/** 发布之前：目标检出里合并不重写的那些文件还是测过的那份。不是就拒，什么都不动。 */
async function untestedCheckout(cwd: string, guard: LandingGuard, names: Names): Promise<TaskMergeResult | null> {
  const physical = guard.physical;
  if (!physical?.preserved) {
    return refusal(names, `门禁跑的时候目标分支 ${names.targetBranch} 没有检出在被测的提交上（或者那一次没记下测过的文件内容），`
      + `现在它检出在 ${cwd}，这份检出里的文件没被核对过，所以这次没有合并，目标分支没动。重新验收会按现在的检出重新跑门禁。`);
  }
  if (await checkoutMatches(cwd, cwd, physical, guard.target, guard.tree, false).catch(() => false)) return null;
  return refusal(names, `目标分支 ${names.targetBranch} 的检出里有这次合并不会重写的文件，在门禁测过之后变了（字节和测的时候不是同一份，`
    + "树和 `git status` 看不出来），合进去之后就不是测过的那份，所以这次没有合并，目标分支没动。重新验收会按现在的检出重新跑门禁。");
}

/** 发布之后：检出里整棵树的字节是测过的那份。不是就如实说（已经发布了，不替用户复位）。 */
async function landedUntested(cwd: string, guard: LandingGuard, names: Names, landed: string): Promise<TaskMergeResult | null> {
  if (guard.physical && await checkoutMatches(cwd, cwd, guard.physical, guard.target, guard.tree, true).catch(() => false)) return null;
  return refusal(names, `${landed}，但 ${cwd} 里的文件和门禁测过的那份不是同一份（发布的同时有别的程序改了它们），`
    + "所以这次不算验收通过。ash 没有替你复位，请在那个检出里核对后手动处理，再重新验收。");
}

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
    return (await landingGit(repo, ["commit-tree", guard.tree, ...parents, "-m", message])).stdout.trim();
  } catch (error) {
    return refusal(names, `没能生成合并结果：${gitError(error)}`);
  }
}

/** 目标分支检出在这里（已核过干净）：只许快进到生成好的那个提交。 */
export async function publishInCheckout(cwd: string, method: Published, guard: LandingGuard, result: string,
  names: Names): Promise<TaskMergeResult> {
  const head = await rev(cwd, "HEAD");
  if (head !== guard.target) return refusal(names, movedTarget(names.targetBranch, guard.target, head));
  const untested = await untestedCheckout(cwd, guard, names);
  if (untested) return untested;
  try {
    await landingGit(cwd, ["merge", "--ff-only", result]);
  } catch (error) {
    const now = await rev(cwd, "HEAD");
    return refusal(names, now !== guard.target ? movedTarget(names.targetBranch, guard.target, now)
      : `快进到测过的合并结果失败（${gitError(error)}），目标分支没动。`);
  }
  const [now, ref, tree] = await Promise.all([rev(cwd, "HEAD"), rev(cwd, `refs/heads/${names.targetBranch}`), rev(cwd, "HEAD^{tree}")]);
  if (now !== result || ref !== result || tree !== guard.tree) {
    return refusal(names, `快进之后目标分支 ${names.targetBranch} 不在刚发布的测过的结果 ${result.slice(0, 12)} 上`
      + `（现在在 ${(ref ?? "读不到").slice(0, 12)}，有别的程序同时动了它），所以这次不算验收通过。ash 没有去动它现在的提交，请核对后重新验收。`);
  }
  return await landedUntested(cwd, guard, names, `目标分支 ${names.targetBranch} 已经快进到测过的结果 ${result.slice(0, 12)}`)
    ?? { ok: true, ...names, method };
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
    await landingGit(repo, ["update-ref", "-m", `ash accept: ${names.sourceBranch}`, ref, result, guard.target]);
  } catch {
    return refusal(names, movedTarget(names.targetBranch, guard.target, await rev(repo, ref)));
  }
  const checkout = await registeredCheckout(repo, names.targetBranch).catch(() => ({ path: null }));
  if (!checkout.path) return { ok: true, ...names, method };
  const undone = await landingGit(repo, ["update-ref", ref, guard.target, result]).then(() => true, () => false);
  return refusal(names, `目标分支 ${names.targetBranch} 在合并的同时被检出到了 ${checkout.path}，`
    + (undone ? "已把这次的更新退回、那份检出没动。" : `没能退回这次的更新：它现在指着 ${result.slice(0, 12)}，合并之前是 ${guard.target.slice(0, 12)}。`)
    + "重新验收即可。");
}

/**
 * 「合并后不提交」：把目标提交那棵树到测过的那棵之间的改动落进检出的索引和工作区（两树 read-tree，
 * 会覆盖本地改动或未跟踪文件时 git 自己拒绝），不落提交。落完核对暂存的正是测过的那棵、检出里的
 * 字节是测过的那份；对不上就如实说，不替用户复位工作区。
 */
export async function stageTestedTree(cwd: string, guard: LandingGuard, names: Names): Promise<TaskMergeResult> {
  const head = await rev(cwd, "HEAD");
  if (head !== guard.target) return refusal(names, movedTarget(names.targetBranch, guard.target, head));
  const untested = await untestedCheckout(cwd, guard, names);
  if (untested) return untested;
  try {
    await landingGit(cwd, ["read-tree", "-m", "-u", guard.target, guard.tree]);
  } catch (error) {
    return refusal(names, `把测过的改动落进工作区失败（${gitError(error)}），目标分支和工作区都没动。`);
  }
  const staged = (await landingGit(cwd, ["write-tree"]).catch(() => null))?.stdout.trim() ?? null;
  if (staged !== guard.tree || await rev(cwd, "HEAD") !== guard.target) {
    return refusal(names, `工作区里暂存的（${staged?.slice(0, 12) ?? "读不到"}）不是验收前置命令测过的那一棵（${guard.tree.slice(0, 12)}）：`
      + "落的同时目标检出被别人动过。ash 没有替你复位，请在那个检出里核对后用 `git reset --merge` 或手动处理，再重新验收。");
  }
  return await landedUntested(cwd, guard, names, "测过的改动已经落进目标检出的工作区（没有提交）")
    ?? { ok: true, ...names, method: "no_commit", stagedTree: staged };
}
