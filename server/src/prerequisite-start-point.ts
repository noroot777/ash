// 有前置的任务开工那一刻的起点：全部前置**当时**的代码合在一起。
//
// 只在起跑那一刻算一次（建任务时不冻结 —— 那时前置多半还没写完），之后就钉在任务的
// `worktreeStartCommit` 上：diff、审查、验收都以它为界，所以这条任务的改动里不含前置的。
//
// 每条前置贡献哪一版：
//   · 站稳判定当时核实过的那一版（prerequisite-standing.ts 的 `commit`）—— 不在这里另读分支头，理由见那份文件头；
//     判定没给出的（已验收的）取它的成果提交（分支头；分支被验收清理掉了就取验收时存下的那一版）；
//   · 这一版已经进了目标分支（前置已经合入，含压缩合入、经提交历史调整后合入 —— 判据是 task-branch-plan.ts
//     `versionDelivery` 那一份，验收依赖问的也是它）→ 换成**目标分支最新一版**：既拿到它，也拿到别人后来合进去的；
//   · 不用 worktree 的前置没有分支可拿，代码就在项目目录里，只贡献顺序，不贡献提交。
// 一条已经包含另一条的（它本来就建在那条上）只留包含者，不重复合；剩下好几条时在**不碰任何工作区**的
// 前提下合成一个提交（`git merge-tree --write-tree` + `commit-tree`），合不拢就说清是哪两条。
import { execFileText as exec } from "./exec.js";
import { expandHome, resolveTaskMergeTarget, resolveWorktreeBranchName } from "./git.js";
import { commitAt, containsCommit, versionDelivery } from "./task-branch-plan.js";
import { deliveredCommit } from "./prerequisite-standing.js";
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

// 这一个提交是 ash 替任务合的，署 ash 的名：项目没配身份时 commit-tree 也不至于失败。
const ASH_IDENTITY = {
  GIT_AUTHOR_NAME: "ash", GIT_AUTHOR_EMAIL: "ash@localhost",
  GIT_COMMITTER_NAME: "ash", GIT_COMMITTER_EMAIL: "ash@localhost",
};

/** 一条前置，连同站稳判定核实过的那一版（没有就是 null）。 */
export type CertifiedPrerequisite = { task: TaskRow; commit: string | null };

export async function prerequisiteStart(repoPath: string, task: TaskRow, prerequisites: CertifiedPrerequisite[]): Promise<PrerequisiteStart> {
  const repo = expandHome(repoPath);
  const target = task.mergeTargetBranch || await resolveTaskMergeTarget(repo, null);
  const targetHead = target ? await commitAt(repo, target) : null;
  const inherited = new Map<string, string>();
  const picks: { commit: string; owners: TaskRow[] }[] = [];
  const pick = (commit: string, owner: TaskRow) => {
    const found = picks.find((entry) => entry.commit === commit);
    if (found) found.owners.push(owner);
    else picks.push({ commit, owners: [owner] });
  };
  for (const { task: prerequisite, commit: certified } of prerequisites) {
    if (!prerequisite.useWorktree) {
      if (targetHead) inherited.set(prerequisite.id, targetHead);
      continue;
    }
    const result = certified ?? await deliveredCommit(repo, prerequisite);
    if (!result) return { ok: false, reason: `${label(prerequisite)}的分支和成果提交都找不到了，拿不到它的代码` };
    const merged = !!targetHead && !!target && await versionDelivery(repo, prerequisite.id, prerequisite, result, target) !== null;
    const commit = merged ? targetHead! : result;
    inherited.set(prerequisite.id, commit);
    pick(commit, prerequisite);
  }
  // 被别的候选包含的不再单独合：它已经在那一版里了。
  const kept: typeof picks = [];
  for (const entry of picks) {
    let covered = false;
    for (const other of picks) {
      if (other !== entry && await containsCommit(repo, entry.commit, other.commit)) { covered = true; break; }
    }
    if (!covered) kept.push(entry);
  }
  if (!kept.length) {
    const base = targetHead ?? await commitAt(repo, "HEAD");
    if (!base) return { ok: false, reason: "仓库里还没有任何提交，没有可开工的起点" };
    return { ok: true, commit: base, baseBranch: targetHead ? target : null, inherited };
  }
  if (kept.length === 1) {
    const only = kept[0]!;
    const baseBranch = only.commit === targetHead ? target
      : only.owners.length === 1 ? await resolveWorktreeBranchName(repo, only.owners[0]!.id) : null;
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
          return { ok: false, reason: `${earlier.owners.map(label).join("")}和${next.owners.map(label).join("")}的改动合不到一起` };
        }
      }
      return { ok: false, reason: `${next.owners.map(label).join("")}的改动和前面几条前置合在一起时有冲突` };
    }
    const names = kept.slice(0, index + 1).flatMap((entry) => entry.owners).map(label).join("、");
    acc = (await exec("git", ["-C", repo, "commit-tree", tree, "-p", acc, "-p", next.commit, "-m", `ash: 合并前置 ${names}`],
      { env: { ...process.env, ...ASH_IDENTITY } })).stdout.trim();
  }
  return { ok: true, commit: acc, baseBranch: null, inherited };
}
