// 目标分支就检出在项目目录时，验收在那里就地合并（git-accept.ts 的 inTargetCheckout）。
//
// 那里是用户自己的检出，合并期间别的终端随时可能切分支。git 没有「合并期间锁住 HEAD」的办法：`index.lock`
// 挡不住 `git switch -c`（同一提交上建分支不碰索引），`HEAD.lock` 又是 git 自己提交时要拿的那把，持着它 git
// 就合不了。审查第 2、3 轮试过持两把锁、借一个私有 git 目录让 git 在旁边跑，结果那个目录和项目的永远对不齐
// （钩子、没做完的操作、按目录生效的配置……），用户 2026-11-20 拍板退回原生合并。
//
// 所以这里给的是和两个终端同时操作时 git 本身一样的保证，外加如实报告：
//  · 合并之前紧贴着再核一次 HEAD 指着目标分支（锁外那道检查之后已经切走的，什么都不动）；
//  · 合并就是原生那几条命令，钩子、配置、进行中操作的检查都按 git 自己的规矩；
//  · 合完按实证判成功：目标分支确实收到了这次合并（快进、合并提交 = 目标包含来源提交；squash = 这次
//    `git commit` 建出的提交在目标上；已经合入 = 来源再合进目标什么都不变；不提交 = 项目目录还在目标上、
//    暂存的就是记下的那棵）。不看「HEAD 现在叫什么」「目标动没动」—— 切走再切回、别人同时往目标上提交，
//    这两样都会骗人（审查第 4 轮 F1）。证明不了就不报成功，说清落在哪 / 现在在哪，不替用户复位。
// 剩下的窗口是「核完到 git 读 HEAD」那几十毫秒，那是 git 自己也不防的竞争。
import { existsSync } from "node:fs";
import { execFileText as exec } from "./exec.js";
import type { TaskMergeResult } from "./git-accept.js";

type Names = { sourceBranch: string; targetBranch: string };

const headRef = async (repo: string) =>
  (await exec("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"]).catch(() => null))?.stdout.trim() || null;
const tipOf = async (repo: string, ref: string) =>
  (await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref]).catch(() => null))?.stdout.trim() || null;
const describe = (ref: string | null) => ref ? `分支 ${ref.replace(/^refs\/heads\//, "")}` : "一个游离的提交";

/** 项目目录现在还检出着 `branch` 吗；不在时说清它现在在哪（受保护发布的后置检查也用）。 */
export async function checkoutLeft(repo: string, branch: string): Promise<string | null> {
  const head = await headRef(repo);
  return head === `refs/heads/${branch}` ? null : describe(head);
}

const ancestor = (repo: string, a: string, b: string) =>
  exec("git", ["-C", repo, "merge-base", "--is-ancestor", a, b]).then(() => true, () => false);

/** 把 `source` 再合进 `commit` 什么都不变（内容上已经包含它）。 */
async function contentContains(repo: string, commit: string, source: string): Promise<boolean> {
  const merged = await exec("git", ["-C", repo, "merge-tree", "--write-tree", "--no-messages", commit, source]).catch(() => null);
  return !!merged && merged.stdout.split("\n")[0] === await tipOf(repo, `${commit}^{tree}`);
}

/** 原检出里没做完的操作留下的记号（都在每个检出自己的 git 目录里）；受保护发布不走原生合并，得自己拒。 */
const PENDING = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"];
export async function pendingOperation(repo: string): Promise<string | null> {
  const paths = (await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", ...PENDING.flatMap((name) => ["--git-path", name])])).stdout.trim().split("\n");
  const found = PENDING.filter((_, i) => paths[i] && existsSync(paths[i]!));
  return found.length ? found.join("、") : null;
}

/**
 * 在项目目录 `repo`（检出着目标分支、已核过干净）里跑 `run` 这次原生合并（`sourceRef` 是被合的来源提交）：
 * 合并前紧贴着核 HEAD，合完按实证判成功（见文件头）。
 */
export async function mergeInUserCheckout(repo: string, names: Names, sourceRef: string,
  run: () => Promise<TaskMergeResult>): Promise<TaskMergeResult> {
  const { targetBranch } = names;
  const ref = `refs/heads/${targetBranch}`;
  const fail = (message: string): TaskMergeResult => ({ ok: false, reason: "merge_failed", message, ...names, targetPath: repo });
  const left = await checkoutLeft(repo, targetBranch);
  if (left) return fail(`合并之前项目目录 ${repo} 已经不在 ${targetBranch} 上了（现在是${left}），这次没动它，重新验收即可。`);
  const before = await tipOf(repo, ref);
  const result = await run();
  const made = await tipOf(repo, "HEAD"); // 紧跟着读：squash 那一档 `git commit` 刚建出的提交
  const head = await headRef(repo);
  const where = describe(head);
  const now = await tipOf(repo, ref);
  if (!result.ok) {
    if (head === ref) return result;
    return fail(`${result.message}\n另外，合并的同时项目目录被切到了${where}，上面这次合并对的可能是那里、不是 ${targetBranch}；`
      + `${targetBranch} 现在在 ${(now ?? "读不到").slice(0, 12)}。Navi 没有替你复位，在项目目录里 \`git status\` 核对后再重新验收。`);
  }
  if (result.method === "no_commit") {
    const staged = head === ref ? (await exec("git", ["-C", repo, "write-tree"]).catch(() => null))?.stdout.trim() : null;
    if (head === ref && now === before && staged === result.stagedTree) return result;
    return fail(`改动已经暂存，但合并的同时项目目录被切过（现在是${where}），暂存的改动${head === ref ? "已经不是这次合并记下的那一份" : "跟着到了那里、不在 " + targetBranch + " 的检出里"}，`
      + `所以这次不算验收通过。Navi 没有替你复位，在项目目录里 \`git status\` 核对后处理，再重新验收。`);
  }
  const landed = now !== null && (result.method === "squash"
    ? !!made && made !== before && !!before && await ancestor(repo, before, made) && await ancestor(repo, made, now)
    : result.method === "already_merged" ? await contentContains(repo, now, sourceRef) : await ancestor(repo, sourceRef, now));
  if (landed) return result;
  return fail(`没法确认这次合并落在了 ${targetBranch} 上：${targetBranch} 现在在 ${(now ?? "读不到").slice(0, 12)}，里面没有这次合并的结果，`
    + `合并的同时项目目录多半被切换过（现在是${where}${made ? `，在 ${made.slice(0, 12)}` : ""}），这次合并可能落在了那里。所以这次不算验收通过。`
    + "Navi 没有替你复位：要撤掉，在项目目录里用 `git reflog` 找到合并之前的位置、`git reset --hard` 回去；然后重新验收。");
}
