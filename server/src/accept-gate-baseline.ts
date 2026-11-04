// 门禁基准：这一按的门禁命令测的是哪一棵树（语义本体在 shared/src/accept-gate.ts 的 AcceptGateBaseline）。
//
// 三个入口读同一份判定，**必须一起改**：
//  · acceptGateCheck（真按下去，仓库锁里）—— 拦不拦、登记哪一棵树、旧绿还作不作数；
//  · acceptGateWouldRun（批量验收按下去之前的预判）—— 它说「要跑」而真按下去被拒（或反过来），
//    统一验收就会停在半路，test-accept-gate-readonly 的夹具把两边钉在一起；
//  · acceptGateState（验收台那张卡）—— 「已通过，可以直接验收」还是「要重跑 / 会被拒」。
//
// 预演怎么跑、为什么不会调起项目自己的程序，在 accept-gate-preview.ts 的文件头。预演出来的那棵树
// 原样放进测试快照（accept-gate-source.ts 的 materializePreview），也是最终合并必须落下的那棵
// （git-accept.ts 的 expectedTree）—— 合并只在这里定义一次。
import { type AcceptGateBaseline, normalizeAcceptGateBaseline } from "@ash/shared/accept-gate";
import { type CheckoutSettings, changedPaths, checkoutFilters, checkoutGaps, checkoutSettings, conversionDrift, materializationIdentity, mergeDrivers, previewMerge, readOnlyGit } from "./accept-gate-preview.js";
import { decodePhysical, targetPreserved } from "./accept-gate-physical.js";
import { dependencyReads } from "./accept-gate-source.js";
import { isAncestor } from "./git-accept.js";
import { resolveWorktreeBranchName } from "./git.js";
import { expandHome } from "./platform.js";
import { commitAt, plannedMergeTarget } from "./task-branch-plan.js";
import type { projects, tasks } from "./db/schema.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export type GateBaselinePlan = {
  mode: AcceptGateBaseline;
  targetBranch: string | null;
  targetCommit: string | null;
  /** 合并预览档：要并进来的目标分支提交（复用判据的一部分）。null = 被测的是分支那棵树。 */
  previewBase: string | null;
  /** 预演出来的合并树。null = 不用合（分支已含目标分支尖端，快照就是分支那棵树）。 */
  previewTree: string | null;
  /** 合并预览档：快照检出要照着复现的目标检出语义配置（accept-gate-preview.ts 的 checkoutSettings）。 */
  previewSettings: CheckoutSettings | null;
  /** 上面那份的身份（materializationIdentity），复用判据的一部分。 */
  previewMaterialization: string | null;
  /**
   * 目标检出**现在**那些合并不重写的文件的摘要（accept-gate-physical.ts 的 targetPreserved），与凭据里
   * GatePhysical.preserved 比；目标没检出在被测提交上为 null。复用判据的一部分。
   */
  previewPhysical: string | null;
};

export type GateBaselineBlock = {
  reason: "accept_gate_target_behind" | "merge_conflict" | "accept_gate_preview_unavailable";
  error: string;
  sourceBranch?: string;
  targetBranch: string;
  targetCommit: string;
  conflictFiles?: string[];
};

const short = (commit: string) => commit.slice(0, 8);
const git = (repo: string, args: string[]) => readOnlyGit(repo, args);

/**
 * 按项目当前的基准，这一按要测哪一棵树，或者在门禁之前就该被拒。`borrowed` 是这次快照要从任务工作区
 * 借用的依赖目录（GateSource.dependencies / gateDependencies）：合并预览改到它们实际读取的内容时，
 * 借来的那份是任务分支的旧内容，只能拒（读不到依赖时不传，那一按本来就会因源码不可用被拒）。
 */
export async function resolveGateBaseline(task: TaskRow, project: ProjectRow, head: string | null,
  borrowed?: { cwd: string; dependencies: readonly string[] }): Promise<{ plan: GateBaselinePlan; block: null } | { plan: null; block: GateBaselineBlock }> {
  const mode = normalizeAcceptGateBaseline(project.acceptGateBaseline);
  // 目标解析与 acceptGateCheck 登记 targetBranch 那一句同源：只有独立 worktree 的任务才有「合并之后」。
  const targetBranch = task.useWorktree ? await plannedMergeTarget(task, project.repoPath) : null;
  const targetCommit = targetBranch ? await commitAt(project.repoPath, targetBranch) : null;
  const plan: GateBaselinePlan = { mode, targetBranch, targetCommit, previewBase: null, previewTree: null, previewSettings: null, previewMaterialization: null, previewPhysical: null };
  if (mode === "branch" || !targetBranch || !targetCommit || !head) return { plan, block: null };
  const contained = await isAncestor(expandHome(project.repoPath), targetCommit, head);
  if (mode === "contains_target") {
    if (contained) return { plan, block: null };
    const behind = (await git(project.repoPath, ["rev-list", "--count", `${head}..${targetCommit}`]).catch(() => null))?.stdout.trim();
    return { plan: null, block: { reason: "accept_gate_target_behind", targetBranch, targetCommit,
      error: `这个项目的门禁基准是「要求已含目标分支」：任务分支还没包含 ${targetBranch} 的最新提交`
        + `（${targetBranch} 现在在 ${short(targetCommit)}${behind ? `，有 ${behind} 个提交不在任务分支里` : ""}）。`
        + `门禁只测任务分支那棵树，缺着这些提交，绿了也说明不了合进去之后还过不过，所以这次没有跑它。`
        + `先让任务在自己的分支上 \`git merge ${targetBranch}\`（有冲突就地解掉并提交），再点验收。` } };
  }
  const unavailable = (why: string) => ({ plan: null, block: { reason: "accept_gate_preview_unavailable" as const,
    targetBranch, targetCommit, error: `合并预览这次没有预演：${why}。在项目设置 → 验收里换成「要求已含目标分支」`
      + `（任务自己先把 ${targetBranch} 合进来，门禁测的就是合并结果），或者换回「分支快照」。` } });
  // 判定读到的那份检出语义原样交给快照（accept-gate.ts → createGateSnapshot），快照不自己再读一遍。
  const settings = await checkoutSettings(project.repoPath);
  const preview = { ...plan, previewBase: targetCommit, previewSettings: settings, previewMaterialization: materializationIdentity(settings) };
  const gaps = await checkoutGaps(project.repoPath);
  if (gaps.length) return unavailable(`${gaps.join("；")}，快照写的是整棵树，测到的文件合进去之后不一定在磁盘上`);
  // 这一档的快照**一律**在封好的环境里物化（accept-gate-source 的 cloneSealedSnapshot），不管要不要
  // 合 —— 已含目标分支时快照就是分支那棵树，照样在那个环境里检出（第 1 轮审查 F2）。所以「封好的
  // 环境写不出平时那份文件」这两条对两种情形都要问：项目配的过滤器，以及仓库外属性给出的内建转换。
  const faithfulness = async (tree: string) => {
    const filters = await checkoutFilters(project.repoPath, tree);
    if (filters.length) {
      return unavailable(`要测的文件里有平时要经过仓库配的过滤器（${filters.join("、")}）才能检出的，`
        + "快照里不执行那段程序，写出来的就不是平时那份文件，测了也说明不了合进去之后怎样");
    }
    const drifted = await conversionDrift(project.repoPath, tree);
    if (drifted.length) {
      const named = drifted.slice(0, 5).join("、") + (drifted.length > 5 ? ` 等 ${drifted.length} 个` : "");
      return unavailable(`要测的文件里有平时靠仓库之外的属性设置（主检出的 info/attributes 或全局属性文件）做换行 / 编码`
        + `转换的（${named}），快照只认树里的 .gitattributes，写出来的字节就不是平时那份。把这些设置写进仓库的 .gitattributes 就能用这一档`);
    }
    return null;
  };
  // 核对本身跑不动（git 太旧、属性读不出来）也是「没法确认快照忠实」，同样结构化拒，不落成通用报错。
  const unfaithful = (tree: string) =>
    faithfulness(tree).catch((error: unknown) => unavailable(`git 没能核对检出属性（${String(error)}）`));
  // 目标检出现在的字节（复用判据的一部分）。读不出来同样是「没法确认快照忠实」，结构化拒。
  const physical = async (tree: string) => {
    try { return { plan: { ...preview, previewTree: contained ? null : tree,
      previewPhysical: await targetPreserved(project.repoPath, targetBranch, targetCommit, tree, borrowed?.dependencies ?? []) }, block: null }; }
    catch (error) { return unavailable(`没能读出目标检出里的文件（${error instanceof Error ? error.message : String(error)}）`); }
  };
  if (contained) {
    const tree = (await git(project.repoPath, ["rev-parse", `${head}^{tree}`])).stdout.trim();
    return await unfaithful(tree) ?? await physical(tree);
  }
  const drivers = await mergeDrivers(project.repoPath, targetCommit, head);
  if (drivers.length) {
    return unavailable(`这次要合的文件用了仓库自配的合并驱动（${drivers.join("、")}），预演不会执行它，`
      + "合出来的就不是真合并那一棵，测了也说明不了合进去之后怎样");
  }
  const merged = await previewMerge(project.repoPath, targetCommit, head);
  if ("error" in merged) {
    return unavailable(`git 没能预演（${merged.error}）`);
  }
  if ("tree" in merged) {
    const refused = await unfaithful(merged.tree);
    if (refused) return refused;
    // 依赖目录在快照里是**借**来的（任务工作区那一份，见 accept-gate-deps）。分支快照档里两者一致由
    // 「工作区干净」保证；合并预览不成立 —— 目标分支完全可以更新随仓库提交的 vendor/，或者依赖根
    // 指回的那棵源码树，借进来的却还是任务分支那份旧的（第 1、2 轮审查 F2/F1）。比的是借用**实际
    // 读取**的那几处（dependencyReads：字面路径、链上每一跳、最终落点），不是目录名。借用没法忠实
    // 放下合并后的内容，就在门禁之前拒。
    let reads: string[];
    try { reads = borrowed?.dependencies.length ? await dependencyReads(borrowed.cwd, borrowed.dependencies) : []; }
    catch (error) { return unavailable(`借用的依赖读自工作区哪几处没能完整求出（${error instanceof Error ? error.message : String(error)}）`); }
    const changed = reads.length ? await changedPaths(project.repoPath, head, merged.tree) : [];
    // 三种相交都算：改的就是这一处、改在它里面、或者改的是它的**祖先**（第 6 轮审查第 3 轮 F1：目标分支把
    // 普通目录 `src` 换成一条链，任务工作区里 `src/vendor` 借进快照后落在链的新位置上，合进去之后那里根本
    // 没有它）。目录本身不在逐文件的改动清单里；祖先出现在清单里，就说明它在这一侧改成了文件或链。
    const stale = reads.filter(read => changed.some(path => read === "" || path === read || path.startsWith(`${read}/`)
      || read.startsWith(`${path}/`)));
    if (stale.length) {
      return unavailable(`${targetBranch} 改了快照要从任务工作区借用的依赖内容（${stale.map(read => read || "整个工作区").join("、")}），`
        + "借进去的就是改之前的那份，测了也说明不了合进去之后怎样");
    }
    return await physical(merged.tree);
  }
  const sourceBranch = await resolveWorktreeBranchName(project.repoPath, task.id);
  return { plan: null, block: { reason: "merge_conflict", targetBranch, targetCommit, sourceBranch, conflictFiles: merged.conflicts,
    error: `这个项目的门禁基准是「合并预览」：预演把 ${targetBranch}（${short(targetCommit)}）合进任务分支时有冲突`
      + `（${merged.conflicts.join("、")}），所以没有跑门禁，两个分支都一个字节没动。`
      + `让任务在自己的分支上 \`git merge ${targetBranch}\` 解掉冲突并提交，再点验收。` } };
}

/**
 * 一行旧记录在**当前基准**下还算不算这一棵树的结果（与 gateSourceMatches 并列，两者都要成立）。
 *
 * 分支快照与「要求已含目标分支」测的都是分支那棵树（后者另由上面的拒绝保证它含着目标分支），
 * 所以两者的记录互通；合并预览测的是预演出来的那棵树。只比两个提交不够：同样的两个提交在不同的
 * 合并配置下会合出不同的树（第 2 轮审查 F1 实测 merge.directoryRenames），所以树也要相等；同一棵树在
 * 不同的换行配置下检出的字节不同，所以快照实际用的转换配置也要相等（第 3 轮复审 F1）；配置没变，
 * 目标检出里合并不重写的那些文件的字节也可能变了，所以它们也要和测的时候是同一份（第 5 轮复审 F2）。
 */
export function gateBaselineMatches(row: GateBaselineRecord, plan: GateBaselinePlan | null): boolean {
  return (row.previewBase ?? null) === (plan?.previewBase ?? null)
    && (row.previewTree ?? null) === (plan?.previewTree ?? null)
    && (row.previewMaterialization ?? null) === (plan?.previewMaterialization ?? null)
    && (!row.previewBase || (!!row.previewPhysical && (decodePhysical(row.previewPhysical)?.preserved ?? null) === (plan?.previewPhysical ?? null)));
}

type GateBaselineRecord = { previewBase?: string | null; previewTree?: string | null; previewMaterialization?: string | null;
  previewPhysical?: string | null };

/**
 * 旧绿不作数的原因不在目标分支（树还是那棵）：只差在转换配置上，或者只差在目标检出的字节上。日志里
 * 说清楚是哪一种，别报成「目标分支动了」。null = 目标分支 / 树本身变了。
 */
export function gateDriftBesidesTree(row: GateBaselineRecord, plan: GateBaselinePlan | null): "materialization" | "physical" | null {
  if ((row.previewBase ?? null) !== (plan?.previewBase ?? null) || (row.previewTree ?? null) !== (plan?.previewTree ?? null)) return null;
  return (row.previewMaterialization ?? null) !== (plan?.previewMaterialization ?? null) ? "materialization" : "physical";
}

/** 门禁日志 / 时间线里那一句「这一次测的是哪一棵」。 */
export function gateBaselineNotice(plan: GateBaselinePlan): string | null {
  if (!plan.previewBase || !plan.targetBranch) return null;
  return plan.previewTree
    ? `合并预览：快照里先把 ${plan.targetBranch}@${short(plan.previewBase)} 合进任务分支，门禁跑的是这份合并结果`
    : `合并预览：任务分支已包含 ${plan.targetBranch}@${short(plan.previewBase)}，快照就是合并结果`;
}
