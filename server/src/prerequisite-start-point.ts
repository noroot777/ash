// 有前置的任务开工那一刻的起点：**最新的目标分支**和全部前置**当时**的代码合在一起。
//
// 只在起跑那一刻算一次（建任务时不冻结 —— 那时前置多半还没写完），之后就钉在任务的
// `worktreeStartCommit` 上：diff、审查、验收都以它为界，所以这条任务的改动里不含前置的。
// 下游后来又把目标分支合进来时，「界」是它加上合进来的那一段（读法在 task-change-scope.ts）；
// 这个值本身不跟着挪。
//
// 目标分支最新那一版始终是一个候选（「开工先把最新 main 合进自己的分支」）：前置还没合入时，别人已经合进
// 目标分支的代码也要在起点里；前置建得早、目标分支后来动过，两边一起合。
//
// 每条前置贡献哪一版：
//   · 站稳判定当时核实过的那一版（prerequisite-standing.ts 的 `commit`）—— 不在这里另读分支头，理由见那份文件头；
//     用 worktree 的交出分支上的提交，不用 worktree 的交出项目目录当时检出的提交，一视同仁；
//     判定没给出的（已验收的）取它此刻读得到的成果提交（`deliveredCommit`）；读不到就不开工 ——
//     「已验收」只说明它进过自己的目标分支，不说明下游的目标里有；
//   · 这一版已经进了目标分支（前置已经合入，含压缩合入、经提交历史调整后合入 —— 判据是 task-branch-plan.ts
//     `versionDelivery` 那一份，验收依赖问的也是它）→ 不再单独合，记成目标分支那一版。
// 一条已经包含另一条的（它本来就建在那条上）只留包含者，不重复合；剩下好几条时在**不碰任何工作区**的
// 前提下合成一个提交（`git merge-tree --write-tree` + `commit-tree`），合不拢就说清是哪两条。
//
// 不用 worktree 的下游不在这里定起点：它在项目目录里干活，能拿到的只有那里检出的代码（`checkoutHasPrerequisites`）。
import { execFileText as exec } from "./exec.js";
import { expandHome, resolveTaskMergeTarget, resolveWorktreeBranchName } from "./git.js";
import { NAVI_GIT_IDENTITY_ENV } from "./navi-commit-identity.js";
import { commitAt, containsCommit, versionDelivery } from "./task-branch-plan.js";
import { deliveredCommit } from "./prerequisite-standing.js";
import { isAcceptedStage, type TaskStage } from "@ash/shared";
import type { tasks } from "./db/schema.js";

type TaskRow = typeof tasks.$inferSelect;

export type PrerequisiteStart =
  | { ok: true; commit: string; baseBranch: string | null; inherited: Map<string, string> }
  | { ok: false; reason: string };

const label = (task: TaskRow) => `「${task.title || task.id}」`;

/** 两版能不能干净地合在一起；能就给出合好的树。 */
async function mergeTree(repo: string, ours: string, theirs: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "merge-tree", "--write-tree", "--no-messages", ours, theirs]);
    return stdout.split("\n")[0]!.trim() || null;
  } catch { return null; }
}

/** 一条前置，连同站稳判定核实过的那一版（没有就是 null）。 */
export type CertifiedPrerequisite = { task: TaskRow; commit: string | null };

/** 起点候选：一个提交，和它代表谁（前置；`owners` 为空 = 目标分支）。 */
type Pick = { commit: string; owners: TaskRow[]; target: boolean };

// 已验收的也一样：交出的那一版读不到，就证明不了下游拿得到它的代码（见 prerequisite-standing.ts `deliveredCommit`）。
const missing = (task: TaskRow) => isAcceptedStage(task.stage as TaskStage | null)
  ? `${label(task)}已经验收，但它交出的那一版在仓库里读不到了（分支、验收记下的提交都找不到），证明不了能拿到它的代码；恢复那些提交，或去掉这条前置`
  : `${label(task)}的分支和成果提交都找不到了，拿不到它的代码`;

export async function prerequisiteStart(repoPath: string, task: TaskRow, prerequisites: CertifiedPrerequisite[]): Promise<PrerequisiteStart> {
  const repo = expandHome(repoPath);
  const target = task.mergeTargetBranch || await resolveTaskMergeTarget(repo, null);
  const targetHead = target ? await commitAt(repo, target) : null;
  const inherited = new Map<string, string>();
  const picks: Pick[] = targetHead ? [{ commit: targetHead, owners: [], target: true }] : [];
  const pick = (commit: string, owner: TaskRow) => {
    const found = picks.find((entry) => entry.commit === commit);
    if (found) found.owners.push(owner);
    else picks.push({ commit, owners: [owner], target: false });
  };
  for (const { task: prerequisite, commit: certified } of prerequisites) {
    const result = certified ?? await deliveredCommit(repo, prerequisite);
    if (!result) return { ok: false, reason: missing(prerequisite) };
    if (targetHead && target && await versionDelivery(repo, prerequisite.id, prerequisite, result, target) !== null) {
      inherited.set(prerequisite.id, targetHead);
      continue;
    }
    inherited.set(prerequisite.id, result);
    pick(result, prerequisite);
  }
  // 被别的候选包含的不再单独合：它已经在那一版里了。
  const kept: Pick[] = [];
  for (const entry of picks) {
    let covered = false;
    for (const other of picks) {
      if (other !== entry && await containsCommit(repo, entry.commit, other.commit)) { covered = true; break; }
    }
    if (!covered) kept.push(entry);
  }
  const named = (entry: Pick) => [...entry.target ? [`目标分支 ${target}`] : [], ...entry.owners.map(label)].join("、");
  if (!kept.length) {
    const base = await commitAt(repo, "HEAD");
    if (!base) return { ok: false, reason: "仓库里还没有任何提交，没有可开工的起点" };
    return { ok: true, commit: base, baseBranch: null, inherited };
  }
  if (kept.length === 1) {
    const only = kept[0]!;
    const owner = only.owners.length === 1 && !only.target ? only.owners[0]! : null;
    const baseBranch = only.target ? target : owner?.useWorktree ? await resolveWorktreeBranchName(repo, owner.id) : null;
    return { ok: true, commit: only.commit, baseBranch, inherited };
  }
  let acc = kept[0]!.commit;
  for (let index = 1; index < kept.length; index++) {
    const next = kept[index]!;
    const tree = await mergeTree(repo, acc, next.commit);
    if (!tree) {
      // 找出跟它合不拢的是前面哪一条：两两试，说得出名字才知道该去改哪边。
      for (const earlier of kept.slice(0, index)) {
        if (!await mergeTree(repo, earlier.commit, next.commit)) {
          return { ok: false, reason: `${named(earlier)}和${named(next)}的改动合不到一起` };
        }
      }
      return { ok: false, reason: `${named(next)}的改动和前面几条合在一起时有冲突` };
    }
    const names = kept.slice(0, index + 1).map(named).join("、");
    acc = (await exec("git", ["-C", repo, "commit-tree", tree, "-p", acc, "-p", next.commit, "-m", `navi: 合并前置 ${names}`],
      { env: { ...process.env, ...NAVI_GIT_IDENTITY_ENV } })).stdout.trim();
  }
  return { ok: true, commit: acc, baseBranch: null, inherited };
}

/**
 * 不用 worktree 的下游在项目目录里干活：每条前置交出的那一版都得已经在那里检出的代码里，它才拿得到。
 * 判据跟验收依赖同一份（`versionDelivery`，对着项目目录的 HEAD 问）；交出的那一版读不到的不开工。
 * 给出每条前置交给它的那一版。
 */
export async function checkoutHasPrerequisites(repoPath: string, task: TaskRow, prerequisites: CertifiedPrerequisite[]): Promise<PrerequisiteStart> {
  const repo = expandHome(repoPath);
  const head = await commitAt(repo, "HEAD");
  if (!head) return { ok: false, reason: "项目目录里还没有任何提交，没有可开工的起点" };
  const inherited = new Map<string, string>();
  for (const { task: prerequisite, commit: certified } of prerequisites) {
    const result = certified ?? await deliveredCommit(repo, prerequisite);
    if (!result) return { ok: false, reason: missing(prerequisite) };
    if (await versionDelivery(repo, prerequisite.id, prerequisite, result, head) === null) {
      return { ok: false, reason: `${label(task)}不用独立工作区，项目目录当前检出的代码里还没有${label(prerequisite)}交出的那一版；把它合进项目目录当前的分支后会自动开工` };
    }
    inherited.set(prerequisite.id, result);
  }
  return { ok: true, commit: head, baseBranch: null, inherited };
}
