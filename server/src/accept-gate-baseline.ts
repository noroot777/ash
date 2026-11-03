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
import { sep } from "node:path";
import { type AcceptGateBaseline, normalizeAcceptGateBaseline } from "@ash/shared/accept-gate";
import { changedPaths, checkoutFilters, mergeDrivers, previewMerge } from "./accept-gate-preview.js";
import { execFileText } from "./exec.js";
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
const git = (repo: string, args: string[]) => execFileText("git", ["-C", expandHome(repo), ...args], { maxBuffer: 8 * 1024 * 1024 });

/**
 * 按项目当前的基准，这一按要测哪一棵树，或者在门禁之前就该被拒。`dependencies` 是这次快照要借用的
 * 依赖目录（GateSource.dependencies）：合并预览改到它们里面随仓库提交的内容时，借来的那份是任务
 * 分支的旧内容，只能拒（读不到源码时不传，那一按本来就会因源码不可用被拒）。
 */
export async function resolveGateBaseline(task: TaskRow, project: ProjectRow, head: string | null,
  dependencies: readonly string[] = []): Promise<{ plan: GateBaselinePlan; block: null } | { plan: null; block: GateBaselineBlock }> {
  const mode = normalizeAcceptGateBaseline(project.acceptGateBaseline);
  // 目标解析与 acceptGateCheck 登记 targetBranch 那一句同源：只有独立 worktree 的任务才有「合并之后」。
  const targetBranch = task.useWorktree ? await plannedMergeTarget(task, project.repoPath) : null;
  const targetCommit = targetBranch ? await commitAt(project.repoPath, targetBranch) : null;
  const plan: GateBaselinePlan = { mode, targetBranch, targetCommit, previewBase: null, previewTree: null };
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
  const preview = { ...plan, previewBase: targetCommit };
  if (contained) return { plan: preview, block: null };
  const unavailable = (why: string) => ({ plan: null, block: { reason: "accept_gate_preview_unavailable" as const,
    targetBranch, targetCommit, error: `合并预览这次没有预演：${why}。在项目设置 → 验收里换成「要求已含目标分支」`
      + `（任务自己先把 ${targetBranch} 合进来，门禁测的就是合并结果），或者换回「分支快照」。` } });
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
    const filters = await checkoutFilters(project.repoPath, merged.tree);
    if (filters.length) {
      return unavailable(`合并之后的文件里有平时要经过仓库配的过滤器（${filters.join("、")}）才能检出的，`
        + "快照里不执行那段程序，写出来的就不是平时那份文件，测了也说明不了合进去之后怎样");
    }
    // 依赖目录在快照里是**借**来的（任务工作区那一份，见 accept-gate-deps）。分支快照档里两者一致由
    // 「工作区干净」保证；合并预览不成立 —— 目标分支完全可以更新随仓库提交的 vendor/，借进来的却还是
    // 任务分支那份旧的（第 1 轮审查 F2）。借用没法忠实放下合并后的内容，就在门禁之前拒。
    const portable = dependencies.map(dep => dep.split(sep).join("/"));
    const touched = portable.filter(dep => dep !== "." && dep !== "");
    const changed = touched.length ? await changedPaths(project.repoPath, head, merged.tree) : [];
    const stale = touched.filter(dep => changed.some(path => path === dep || path.startsWith(`${dep}/`)));
    if (stale.length) {
      return unavailable(`${targetBranch} 改了随仓库提交的依赖目录（${stale.join("、")}），而快照里的依赖目录借的是任务`
        + "工作区那一份，放进去的就是改之前的内容，测了也说明不了合进去之后怎样");
    }
    return { plan: { ...preview, previewTree: merged.tree }, block: null };
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
 * 合并配置下会合出不同的树（第 2 轮审查 F1 实测 merge.directoryRenames），所以树也要相等。
 */
export function gateBaselineMatches(row: { previewBase?: string | null; previewTree?: string | null },
  plan: GateBaselinePlan | null): boolean {
  return (row.previewBase ?? null) === (plan?.previewBase ?? null)
    && (row.previewTree ?? null) === (plan?.previewTree ?? null);
}

/** 门禁日志 / 时间线里那一句「这一次测的是哪一棵」。 */
export function gateBaselineNotice(plan: GateBaselinePlan): string | null {
  if (!plan.previewBase || !plan.targetBranch) return null;
  return plan.previewTree
    ? `合并预览：快照里先把 ${plan.targetBranch}@${short(plan.previewBase)} 合进任务分支，门禁跑的是这份合并结果`
    : `合并预览：任务分支已包含 ${plan.targetBranch}@${short(plan.previewBase)}，快照就是合并结果`;
}
