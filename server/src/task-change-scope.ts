// 「这条任务自己改了什么」的口径，只此一份：diff、单文件 diff、动过哪些路径、提交清单、
// 交给审查者的对比基准都从这里取，各算各的就会对不上。
//
// 一句话：**目标分支上已经有的、和开工点里已经有的，都不算这条任务的改动。**
//
// 开工点（`worktreeStartCommit`）是冻结的，但它只在任务分支**从不合目标分支**时才等于
// 「改动的起点」。执行者 `git merge <目标分支>` 一次（解验收冲突时系统就是这么让它做的，
// 见 accept-conflict.ts），目标分支在开工之后的全部进展就都落在 `开工点..分支头` 里 ——
// 一条净改动为零的任务曾在验收台上写着「1010 文件 +34552 −63807」。
//
// 所以对比基准是一棵合出来的树：**开工点，加上任务分支里已经合进来的那部分目标分支**。
//   · 没合过目标分支 → 就是开工点；
//   · 开工点在目标分支历史上、之后合过 → 分支与目标分支的共同祖先；
//   · 开工点不在目标分支上（前置还没合入，起点是「目标分支 + 前置」合成的提交，见
//     prerequisite-start-point.ts）、之后又合过 → 两边合在一起，前置带来的、目标分支带来的都不算；
//   · 前置后来进了目标分支（含压缩合入、调整历史后合入）、下游又把它合了进来 → 前置的内容已经
//     在那段目标分支里，不再从开工点另算一份（task-change-sources.ts）。压缩合入时两边是内容相同
//     的不同提交，再合一遍轻则重复、重则冲突；
//   · 目标分支此后又前进、但没合进任务分支的那部分 → 走不到，自然不出现。
// 解冲突时动的内容落在「合出来的树」与分支头之间，算任务自己的。
//
// 提交清单同理：分支上有、而从目标分支和开工点都走不到的提交（它自己做的合并提交算）。
//
// 只读：不碰任何工作区和索引。要合成一棵树时用 `merge-tree --write-tree` + `commit-tree`，
// 只往对象库里写对象；身份和日期写死，同样的输入永远得到同一个提交号，反复读不会越攒越多。
// 两边合不拢就照实说算不出来，不退回按开工点算 —— 那正是会给出错数字的那个算法。
//
// 面板每隔几秒就问一次，所以贵的那一半（共同祖先、祖先判定、合树）按提交号记着：
// 同一组提交号的答案不会变，分支头、目标分支头、开工点任何一个动了，键就变了。
import { execFileText as exec } from "./exec.js";
import { expandHome, isGitRepo, resolveTaskMergeTarget, resolveWorktreeBranchName } from "./git.js";

/** 定口径要用到的任务字段；直接把任务行递进来即可。 */
export interface ChangeScopeTask {
  id: string;
  worktreeStartCommit?: string | null;
  mergeTargetBranch?: string | null;
  worktreeBase?: string | null;
  stage?: string | null;
  acceptedBaseCommit?: string | null;
}

export type ChangeScopeFailure =
  | "not_git_repo" | "source_branch_missing" | "start_commit_unreadable" | "target_unresolved"
  | "target_branch_missing" | "no_merge_base" | "base_conflict" | "base_unreadable";

export type TaskChangeScope =
  | {
    ok: true; sourceBranch: string; targetBranch: string | null;
    /** 任务分支此刻的头。 */
    head: string;
    /** 对比基准：`git diff <base> <head>` 就是这条任务自己的改动。可能是合成的提交。 */
    base: string;
    /** 提交清单的排除项：`git log <head> --not <exclude…>`。 */
    exclude: string[];
  }
  | { ok: false; sourceBranch: string; targetBranch: string | null; reason: ChangeScopeFailure };

/** 给人读的原因（审查提示里用；界面那份在 web/src/lib/branch-diff-reason.ts）。 */
export const CHANGE_SCOPE_FAILURE_TEXT: Record<ChangeScopeFailure, string> = {
  not_git_repo: "项目不是 Git 仓库",
  source_branch_missing: "任务分支不存在或已清理",
  start_commit_unreadable: "无法读取任务的开工提交",
  target_unresolved: "无法确定目标分支",
  target_branch_missing: "合入目标分支不在本地",
  no_merge_base: "任务分支与合入目标没有共同基点",
  base_conflict: "开工点带来的代码和任务分支里已合入的目标分支合不到一起，算不出这条任务自己的改动",
  base_unreadable: "合成对比基准时 git 没有给出结果",
};

const git = async (repo: string, args: string[], env?: NodeJS.ProcessEnv) =>
  (await exec("git", ["-C", repo, ...args], env ? { env } : {})).stdout.trim();

const commitOf = (repo: string, ref: string): Promise<string | null> =>
  git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).then((sha) => sha || null, () => null);

// git 用退出码 1 回答「不是」「没有」；别的失败（对象读不到、被打断）不能当成回答记下来。
const answeredNo = (error: unknown) => (error as { code?: unknown }).code === 1;

const contains = (repo: string, ancestor: string, descendant: string): Promise<boolean> =>
  exec("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]).then(() => true, (error) => {
    if (answeredNo(error)) return false;
    throw error;
  });

/** 记着最近用过的那一批；在算的那一份也共用（同一刻 diff、提交清单、产物面板会一起来问）。算失败的不留。 */
export function remembered<T>(limit = 512) {
  const entries = new Map<string, Promise<T>>();
  return {
    get(key: string, compute: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const pending = compute();
      entries.set(key, pending);
      pending.catch(() => { if (entries.get(key) === pending) entries.delete(key); });
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
      return pending;
    },
    forget(key: string): void { entries.delete(key); },
  };
}

/**
 * 任务分支里已经合进来的那部分目标分支，相对开工点的位置。
 * `merged` 是分支与目标分支的共同祖先里**开工点还没有的**那几个；`startInside` = 开工点整个在它们里面。
 */
type Shape = { related: boolean; merged: string[]; startInside: boolean };
const shapes = remembered<Shape>();

async function readShape(repo: string, head: string, start: string | null, target: string): Promise<Shape> {
  // 共同祖先可以不止一个（前置直接合入目标分支后，「上次合进来的目标分支」和「前置那一版」并列），全都要算上。
  const bases = await git(repo, ["merge-base", "--all", target, head]).then((out) => out.split("\n").filter(Boolean), (error) => {
    if (answeredNo(error)) return [] as string[];
    throw error;
  });
  if (!start) return { related: bases.length > 0, merged: bases, startInside: true };
  const merged: string[] = [];
  for (const base of bases) if (!await contains(repo, base, start)) merged.push(base);
  let startInside = false;
  for (const base of merged) if (await contains(repo, start, base)) { startInside = true; break; }
  return { related: bases.length > 0, merged, startInside };
}

type Combined = { ok: true; commit: string; synthesized: boolean } | { ok: false; reason: "base_conflict" };
const combinations = remembered<Combined>();

// 合成的提交由 ash 落款、日期写死：同样的两边永远合出同一个提交号。
const ASH_FIXED_IDENTITY = {
  GIT_AUTHOR_NAME: "ash", GIT_AUTHOR_EMAIL: "ash@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "ash", GIT_COMMITTER_EMAIL: "ash@localhost", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

/** 把几版代码合成一个提交；被别的包含的不重复合。合不拢 = base_conflict。 */
async function combine(repo: string, picks: string[]): Promise<Combined> {
  const unique = [...new Set(picks)];
  const kept: string[] = [];
  for (const pick of unique) {
    let covered = false;
    for (const other of unique) if (other !== pick && await contains(repo, pick, other)) { covered = true; break; }
    if (!covered) kept.push(pick);
  }
  let acc = kept[0]!;
  for (const next of kept.slice(1)) {
    let tree: string;
    try {
      tree = (await git(repo, ["merge-tree", "--write-tree", "--no-messages", acc, next])).split("\n")[0]!;
    } catch (error) {
      // 冲突时 git 以 1 退出、照样把带冲突标记的树写在第一行；别的失败（读不到对象、git 太老）第一行没有树。
      const conflicted = /^[0-9a-f]{40,64}$/.test(String((error as { stdout?: string }).stdout ?? "").split("\n")[0]!.trim());
      if (conflicted) return { ok: false, reason: "base_conflict" };
      throw error;
    }
    acc = await git(repo, ["commit-tree", tree, "-p", acc, "-p", next, "-m", "ash: 任务改动的对比基准"],
      { ...process.env, ...ASH_FIXED_IDENTITY });
  }
  return { ok: true, commit: acc, synthesized: kept.length > 1 };
}

/** `carried` = 开工点这一侧别人交来的那几版（提交清单的排除项里要有它们）。 */
async function changeBase(repo: string, taskId: string, head: string, start: string | null, target: string | null,
): Promise<{ ok: true; base: string; carried: string[] } | { ok: false; reason: ChangeScopeFailure }> {
  // 目标分支读不到：没有可扣的，开工点就是能给出的全部。
  if (!target) return { ok: true, base: start!, carried: [] };
  try {
    const shape = await shapes.get([repo, head, start ?? "", target].join("\0"), () => readShape(repo, head, start, target));
    if (!start && !shape.related) return { ok: false, reason: "no_merge_base" };
    if (start && !shape.merged.length) return { ok: true, base: start, carried: [] };
    let picks = shape.merged;
    let carried: string[] = [];
    if (start && !shape.startInside) {
      // 开工点不在合进来的那段目标分支里：它带着别处的代码（前置、父任务、另一条基线分支）。
      // 其中已经进了那段目标分支的不再另算，判据在 task-change-sources.ts（要读库，按需加载）。
      const { startSideOf } = await import("./task-change-sources.js");
      const side = await startSideOf(repo, taskId, head, start, shape.merged);
      picks = [...shape.merged, ...side.pending];
      carried = side.carried;
    }
    const key = [repo, ...picks].join("\0");
    const compute = () => combine(repo, picks);
    let combined = await combinations.get(key, compute);
    // 合成的提交没有引用指着，仓库整理可能把它收走：记着的那个读不到了就重新合一次。
    if (combined.ok && combined.synthesized && !await commitOf(repo, combined.commit)) {
      combinations.forget(key);
      combined = await combinations.get(key, compute);
    }
    return combined.ok ? { ok: true, base: combined.commit, carried } : combined;
  } catch {
    return { ok: false, reason: "base_unreadable" };
  }
}

export async function taskChangeScope(repoPath: string, task: ChangeScopeTask): Promise<TaskChangeScope> {
  const repo = expandHome(repoPath);
  // 分支名走 resolveWorktreeBranchName：改名成 ash 之后新任务是 `ash/xxx`，改名前建的
  // 老任务还挂在 `harness/xxx` 上，这里得两边都认，否则老任务一律报 source_branch_missing。
  const sourceBranch = await resolveWorktreeBranchName(repo, task.id);
  const fail = (targetBranch: string | null, reason: ChangeScopeFailure): TaskChangeScope =>
    ({ ok: false, sourceBranch, targetBranch, reason });
  if (!(await isGitRepo(repo))) return fail(null, "not_git_repo");
  const targetBranch = await resolveTaskMergeTarget(repo, task.mergeTargetBranch || task.worktreeBase);
  const recorded = task.worktreeStartCommit?.trim() || null;
  // 已经合入的任务：目标分支里有它自己，拿现在的目标分支去扣等于把它整个扣没。
  // 这时「目标分支上本来就有的」指合入之前那一版（验收时冻结的 acceptedBaseCommit）。
  const settled = task.stage === "merged" || task.stage === "accepted" ? task.acceptedBaseCommit?.trim() || null : null;
  const [head, start, frozenTarget, liveTarget] = await Promise.all([
    commitOf(repo, `refs/heads/${sourceBranch}`),
    recorded ? commitOf(repo, recorded) : null,
    settled ? commitOf(repo, settled) : null,
    // 判据是**本地分支还在不在**，同名 tag 不算（理由见 git.ts staleBaseFallback）。
    targetBranch ? commitOf(repo, `refs/heads/${targetBranch}`) : null,
  ]);
  if (!head) return fail(targetBranch, "source_branch_missing");
  if (recorded && !start) return fail(targetBranch, "start_commit_unreadable");
  if (!start && !targetBranch) return fail(null, "target_unresolved");
  if (!start && !liveTarget) return fail(targetBranch, "target_branch_missing");
  const target = frozenTarget ?? liveTarget;
  const base = await changeBase(repo, task.id, head, start, target);
  if (!base.ok) return fail(targetBranch, base.reason);
  return {
    ok: true, sourceBranch, targetBranch, head, base: base.base,
    exclude: [...new Set([target, start, ...base.carried].filter((commit): commit is string => !!commit))],
  };
}

export interface TaskCommitEntry { sha: string; subject: string; at: string }

/** 清单一次最多列这么多条；真实条数另给（`total`），不拿上限冒充总数。 */
export const TASK_COMMIT_LIST_LIMIT = 50;

/**
 * 这条任务自己的提交：分支上有、而从目标分支和开工点都走不到的。
 * `total` 是真实条数，`commits` 只列最近的 `limit` 条。口径算不出来时两样都是空的，原因在 `reason`。
 */
export async function taskChangeCommits(repoPath: string, task: ChangeScopeTask, limit = TASK_COMMIT_LIST_LIMIT,
): Promise<{ commits: TaskCommitEntry[]; total: number; reason?: string }> {
  const scope = await taskChangeScope(repoPath, task);
  if (!scope.ok) return { commits: [], total: 0, reason: scope.reason };
  const repo = expandHome(repoPath);
  const range = [scope.head, "--not", ...scope.exclude];
  try {
    const commits = (await git(repo, ["log", "--format=%H%x1f%s%x1f%cI", "-n", String(limit), ...range]))
      .split("\n").filter(Boolean).map((line) => {
        const [sha, subject, at] = line.split("\x1f");
        return { sha: sha!, subject: subject ?? "", at: at ?? "" };
      });
    const total = commits.length < limit ? commits.length : Number(await git(repo, ["rev-list", "--count", ...range])) || commits.length;
    return { commits, total };
  } catch {
    return { commits: [], total: 0, reason: "task_diff_unreadable" };
  }
}
