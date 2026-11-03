// 门禁基准：这一按的门禁命令测的是哪一棵树（语义本体在 shared/src/accept-gate.ts 的 AcceptGateBaseline）。
//
// 三个入口读同一份判定，**必须一起改**：
//  · acceptGateCheck（真按下去，仓库锁里）—— 拦不拦、登记哪一棵树、旧绿还作不作数；
//  · acceptGateWouldRun（批量验收按下去之前的预判）—— 它说「要跑」而真按下去被拒（或反过来），
//    统一验收就会停在半路，test-accept-gate-readonly 的夹具把两边钉在一起；
//  · acceptGateState（验收台那张卡）—— 「已通过，可以直接验收」还是「要重跑 / 会被拒」。
//
// 预演合并用 `git merge-tree --write-tree`：它只往对象库写 blob/tree，不碰任何 ref、索引和工作区，
// 也不跑钩子 —— 是一次 git 操作，不是用户代码。真正给门禁跑的那份合并结果在测试快照里另合一次
// （accept-gate-source.ts 的 createGateSnapshot），两边的树必须相等，否则快照建不起来。
import { type AcceptGateBaseline, normalizeAcceptGateBaseline } from "@ash/shared/accept-gate";
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

type PreviewMerge = { tree: string } | { conflicts: string[] } | { error: string };

/** 预演「目标分支 ← 任务分支」那次合并。参数顺序与真合并一致（在目标分支上 `git merge` 任务分支）。 */
async function previewMerge(repo: string, targetCommit: string, head: string): Promise<PreviewMerge> {
  try {
    const { stdout } = await git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", targetCommit, head]);
    return { tree: stdout.split("\n")[0]!.trim() };
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: number; stdout?: string; stderr?: string };
    // 退出码 1 = 合得出来但有冲突：第一行是树，后面每行一个冲突文件，空行之后是说明（已用 --no-messages 关掉）。
    if (code === 1 && stdout) {
      const lines = stdout.split("\n");
      const end = lines.indexOf("", 1);
      return { conflicts: [...new Set(lines.slice(1, end < 0 ? undefined : end).map(line => line.trim()).filter(Boolean))] };
    }
    return { error: (stderr || String(error)).trim() };
  }
}

/**
 * 按项目当前的基准，这一按要测哪一棵树，或者在门禁之前就该被拒。
 *
 * `probeConflict: false` 只给验收台的新鲜度用：那里只要知道「预演基准是哪个提交」，冲突要不要
 * 拦由同一个函数的完整版回答 —— 两者共用目标解析，基准口径不会分叉。
 */
export async function resolveGateBaseline(task: TaskRow, project: ProjectRow, head: string | null,
  opts: { probeConflict?: boolean } = {}): Promise<{ plan: GateBaselinePlan; block: null } | { plan: null; block: GateBaselineBlock }> {
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
  if (contained || opts.probeConflict === false) return { plan: preview, block: null };
  const merged = await previewMerge(project.repoPath, targetCommit, head);
  if ("tree" in merged) return { plan: { ...preview, previewTree: merged.tree }, block: null };
  if ("error" in merged) {
    return { plan: null, block: { reason: "accept_gate_preview_unavailable", targetBranch, targetCommit,
      error: `合并预览没能预演（${merged.error}）。这一档要用 git 2.38 以上的 \`git merge-tree --write-tree\`；`
        + "升级 git，或者在项目设置 → 验收里把门禁基准换回「分支快照」。" } };
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
 * 只比预演基准：分支快照与「要求已含目标分支」测的都是分支那棵树（后者另由上面的拒绝保证它含着
 * 目标分支），所以两者的记录互通；合并预览测的是「分支 + 那个目标提交」，目标分支一动就不是同一棵。
 */
export function gateBaselineMatches(row: { previewBase?: string | null }, plan: GateBaselinePlan | null): boolean {
  return (row.previewBase ?? null) === (plan?.previewBase ?? null);
}

/** 门禁日志 / 时间线里那一句「这一次测的是哪一棵」。 */
export function gateBaselineNotice(plan: GateBaselinePlan): string | null {
  if (!plan.previewBase || !plan.targetBranch) return null;
  return plan.previewTree
    ? `合并预览：快照里先把 ${plan.targetBranch}@${short(plan.previewBase)} 合进任务分支，门禁跑的是这份合并结果`
    : `合并预览：任务分支已包含 ${plan.targetBranch}@${short(plan.previewBase)}，快照就是合并结果`;
}
