// 合并预览档那一按的最终落地：git-accept.ts 的 mergeTaskBranchLocked 带着落地约束（测过的树 + 测的时候
// 目标分支所在的提交 + 测过的物理内容）时转到这里。
//
// 不变量：落下的就是门禁测过的那棵树、落在被测时的目标提交之上，目标检出里的字节就是快照里测过的那份；
// 落不成就**不动目标分支**。所以结果在任何检出之外生成（`commit-tree`，树就是测过的那棵），再只用
// 「快进到它」发布 —— 检出里先演一遍两树合并、带旧值挪分支、再写文件，没有检出时带旧值的 `update-ref`。
// 写文件之前的失败什么都不动；写到一半的失败停在那儿如实交付（git-accept-publish.ts 文件头），不替用户
// 复位，不会把期间另一个终端提交到目标分支上的东西一并撤掉（第 4 轮复审 F1：旧做法先在用户检出里真合、
// 树不对再 `reset --hard` 回合并前，连带抹掉了外部提交）。
//
// 发布这几条 git 一律不调用户钩子、不调 fsmonitor（landingGit）：门禁就是这一档的检查，`post-merge`
// 之类在发布那一刻再改一遍目标分支或文件，落下的就又不是测过的那份（第 5 轮复审 F1 实测：钩子落了
// 一个提交，返回却是合并成功），而且那是门禁命令之外的项目程序。改目标检出文件的那一步更进一步，在
// 只含测过的检出语义的封好环境里做（git-accept-publish.ts）：仓库此刻配了什么过滤器都调不起来。门禁
// 之前那道「工作区干净」也不跑 `git status`（它会按仓库配置调 clean 过滤器），见 guardedDirtyFiles。
// 发布之后再核一遍后置条件：目标分支、HEAD 指着刚发布的结果、树是测过的那棵、检出里的字节是测过的
// 那份；对不上就如实说，不替用户复位。
//
// 物理内容（第 5 轮复审 F2）：门禁起跑时把快照里被测的字节记成摘要（accept-gate-physical.ts）。发布前
// 核目标检出里合并不重写的那些文件还是那份，发布后核整棵树。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutMatches, type GatePhysical } from "./accept-gate-physical.js";
import { checkoutSettings, materializationIdentity, readOnlyGit } from "./accept-gate-preview.js";
import { type PathState, type SealedMove, sealedMove } from "./git-accept-publish.js";
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

/** 发布之后（或者早已合入时）：检出里整棵树的字节是测过的那份。不是就如实说（不替用户复位）。 */
async function landedUntested(cwd: string, guard: LandingGuard, names: Names, landed: string): Promise<TaskMergeResult | null> {
  if (guard.physical && await checkoutMatches(cwd, cwd, guard.physical, guard.target, guard.tree, true).catch(() => false)) return null;
  return refusal(names, `${landed}，但 ${cwd} 里的文件和门禁测过的那份不是同一份（字节或读 / 执行权限对不上），`
    + "所以这次不算验收通过。ash 没有替你复位，请在那个检出里核对后手动处理，再重新验收。");
}

/**
 * 「已经合入」那个成功出口（第 5 轮复审第 2 轮 F1）：树对上了还不够，目标检出着就核整棵树的字节。
 * 目标哪儿都没检出就没有磁盘状态可比。
 */
export async function alreadyLandedUntested(repo: string, guard: LandingGuard, names: Names): Promise<TaskMergeResult | null> {
  const checkout = (await registeredCheckout(repo, names.targetBranch).catch(() => null))?.path;
  return checkout ? landedUntested(checkout, guard, names, `目标分支 ${names.targetBranch} 已经包含任务分支、树也是测过的那棵`) : null;
}

/**
 * 受保护落地之前的「工作区干净」：暂存区与 HEAD 一致、没有未忽略的未跟踪文件。不跑 `git status` ——
 * 它为了比工作区要按仓库配置调 clean 过滤器；已跟踪文件的字节由发布前的物理核对（untestedCheckout）
 * 与两树 read-tree 自己的「是不是最新」核对管，都不调程序。
 */
export async function guardedDirtyFiles(repo: string): Promise<string[]> {
  const list = async (args: string[]) => (await readOnlyGit(repo, args)).stdout.split("\0").filter(Boolean);
  return [...new Set([...await list(["diff-index", "--cached", "--name-only", "-z", "HEAD"]),
    ...await list(["ls-files", "--others", "--exclude-standard", "-z"])])];
}

/**
 * 在封好的环境里把目标检出从被测的目标提交改成 `to`（git-accept-publish.ts）。`publish` 是挪分支那一步
 * （演过两树合并之后、写文件之前做）。成功返回 null。
 */
async function sealedLanding(cwd: string, guard: LandingGuard, names: Names, to: string,
  publish?: () => Promise<string | null>): Promise<TaskMergeResult | null> {
  const settings = await checkoutSettings(cwd);
  if (!guard.physical?.materialization || materializationIdentity(settings) !== guard.physical.materialization) {
    return refusal(names, `目标检出的换行 / 链接配置（core.autocrlf / core.eol / core.symlinks）和门禁测的时候不是同一份了，`
      + "照现在的配置写出来的文件就不是测过的那份，所以这次没有合并，目标分支没动。重新验收会按现在的配置重新跑门禁。");
  }
  const moved = await sealedMove(cwd, settings, guard.target, to, guard.tree, publish)
    .catch((error: unknown): SealedMove => ({ ok: false, stage: "blocked", message: gitError(error) }));
  if (moved.ok) return null;
  if (moved.stage === "locked") return refusal(names, `${moved.message}，目标分支和工作区都没动。处理完再重新验收。`);
  if (moved.stage === "publish") return refusal(names, `${moved.message}检出里的文件也一个都没动。`);
  if (moved.stage === "blocked") {
    return refusal(names, `没能把测过的改动写进 ${cwd}（${moved.message}），失败在写任何文件之前：目标分支没动，检出里的文件也没动。处理完再重新验收。`);
  }
  if (moved.stage === "index") {
    if (!moved.published) {
      return refusal(names, `测过的改动已经写进 ${cwd}，但没能暂存（${moved.message}）：目标分支和索引都没动，\`git status\` 会把它们显示成未暂存的改动。`
        + "请在那个检出里核对后手动处理，再重新验收。");
    }
    return refusal(names, `目标分支 ${names.targetBranch} 已经挪到 ${to.slice(0, 12)}、${cwd} 里的文件也已经是测过的那份，`
      + `但把新索引换进去失败了（${moved.message}）：索引还停在合并之前，\`git status\` 会把这次的改动显示成未暂存。`
      + "在那个检出里跑一次 `git reset -q`（只改索引、不动文件）就对齐了，再重新验收。");
  }
  return refusal(names, halfWritten(moved, cwd, names, to, guard.target));
}

const listed = (paths: readonly string[]) => paths.slice(0, 10).join("、") + (paths.length > 10 ? ` 等 ${paths.length} 个` : "");

const STATE_NAMES: [PathState["state"], string][] = [["target", "已经是测过那份"], ["partial", "写了一半（既不是原来那份也不是测过那份）"],
  ["unknown", "读不了、核不出来"], ["original", "还是合并之前那份"]];
/** 按现在的样子分组列出（git-accept-publish.ts 的 classify）。 */
const described = (paths: readonly PathState[]) => STATE_NAMES
  .map(([state, name]) => [name, paths.filter(path => path.state === state).map(path => path.path)] as const)
  .filter(([, group]) => group.length).map(([name, group]) => `${name}的：${listed(group)}`).join("；");

/**
 * 怎么收拾成某一棵（`toTested` = 测过的那棵 / 否则合并之前那棵）：那棵里有的用 checkout 取，没有的是该删的，
 * 未跟踪了 checkout 取不到，手动删（第 6 轮审查第 6 轮 N1）。
 */
function repair(paths: readonly PathState[], toTested: boolean): string {
  const fetch = paths.filter(path => toTested ? path.inTo : path.inFrom).map(path => path.path);
  const drop = paths.filter(path => !(toTested ? path.inTo : path.inFrom)).map(path => path.path);
  return [fetch.length ? `用 \`git checkout HEAD -- <路径>\` 取回 ${listed(fetch)}` : "",
    drop.length ? `核对后手动删掉 ${listed(drop)}（${toTested ? "测过的那棵里没有它们" : "合并之前没有它们"}）` : ""].filter(Boolean).join("，");
}

/**
 * 写文件写到一半失败：ash 不放回、不删任何东西（git-accept-publish.ts 文件头），照实说每个路径现在是什么样、
 * 怎么收拾。只有核实了都还是原样才说「没写」；核不出来就把可能动过的全部交出来。
 */
function halfWritten(moved: Extract<SealedMove, { stage: "partial" }>, cwd: string, names: Names, to: string, base: string): string {
  const head = `把测过的改动写进 ${cwd} 时失败了（${moved.message}），ash 没有自动放回、也没有删任何东西。`;
  const unknownAll = (goal: string) => `没能核出每个文件现在是什么样${moved.changed?.length ? `，这次要改的这些都可能被动过：${listed(moved.changed)}` : ""}。`
    + `请在那个检出里核对（\`git status\`），${goal}，再重新验收。`;
  if (moved.published) {
    const branch = `目标分支 ${names.targetBranch} 已经挪到测过的结果 ${to.slice(0, 12)}。`;
    const reset = moved.indexInstalled ? "" : `索引还停在合并之前（${base.slice(0, 12)}），先在那个检出里跑 \`git reset -q\`（只改索引）。`;
    if (!moved.paths) return head + branch + reset + unknownAll("测过的那棵里有的用 `git checkout HEAD -- <路径>` 补齐、没有的手动删掉");
    const todo = moved.paths.filter(path => path.state !== "target");
    if (!todo.length) return head + branch + reset + "核下来这次要改的文件其实都已经是测过的那份，重新验收即可。";
    return head + branch + reset + (moved.indexInstalled ? "索引已经是测过的那棵。" : "")
      + `还有 ${todo.length} 个不是测过的那份 —— ${described(todo)}。在那个检出里${repair(todo, true)}，再重新验收。`;
  }
  const kept = "目标分支和索引都没动。";
  if (!moved.paths) return head + kept + unknownAll("合并之前就有的用 `git checkout HEAD -- <路径>` 取回、合并新增的直接删掉");
  const touched = moved.paths.filter(path => path.state !== "original");
  if (!touched.length) return head + kept + `核下来这次要改的 ${moved.paths.length} 个文件都还是合并之前那份，重新验收即可。`;
  return head + kept + `动过的有 ${touched.length} 个 —— ${described(touched)}。要撤掉就在那个检出里${repair(touched, false)}，再重新验收。`;
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

/** 目标分支检出在这里（已核过干净）：只许快进到生成好的那个提交（文件在封好的环境里改，分支带旧值挪）。 */
export async function publishInCheckout(cwd: string, method: Published, guard: LandingGuard, result: string,
  names: Names): Promise<TaskMergeResult> {
  const head = await rev(cwd, "HEAD");
  if (head !== guard.target) return refusal(names, movedTarget(names.targetBranch, guard.target, head));
  const untested = await untestedCheckout(cwd, guard, names);
  if (untested) return untested;
  const branch = `refs/heads/${names.targetBranch}`;
  const failed = await sealedLanding(cwd, guard, names, result, async () => {
    try {
      await landingGit(cwd, ["update-ref", "-m", `ash accept: ${names.sourceBranch}`, branch, result, guard.target]);
      return null;
    } catch {
      return movedTarget(names.targetBranch, guard.target, await rev(cwd, branch));
    }
  });
  if (failed) return failed;
  const [now, ref, tree] = await Promise.all([rev(cwd, "HEAD"), rev(cwd, branch), rev(cwd, "HEAD^{tree}")]);
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
  const failed = await sealedLanding(cwd, guard, names, guard.tree);
  if (failed) return failed;
  const staged = (await landingGit(cwd, ["write-tree"]).catch(() => null))?.stdout.trim() ?? null;
  if (staged !== guard.tree || await rev(cwd, "HEAD") !== guard.target) {
    return refusal(names, `工作区里暂存的（${staged?.slice(0, 12) ?? "读不到"}）不是验收前置命令测过的那一棵（${guard.tree.slice(0, 12)}）：`
      + "落的同时目标检出被别人动过。ash 没有替你复位，请在那个检出里核对后用 `git reset --merge` 或手动处理，再重新验收。");
  }
  return await landedUntested(cwd, guard, names, "测过的改动已经落进目标检出的工作区（没有提交）")
    ?? { ok: true, ...names, method: "no_commit", stagedTree: staged };
}
