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
//  · 合完再核一次 HEAD：还在目标分支上就照常；被切走了，就按目标分支到底有没有收到这次合并如实说 ——
//    收到了算合进去了（之后切走是用户自己的事），没收到就是落在了别处，说清落在哪、怎么找回，不替用户复位。
// 剩下的窗口是「核完到 git 读 HEAD」那几十毫秒，那是 git 自己也不防的竞争。
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

/** 在项目目录 `repo`（检出着目标分支、已核过干净）里跑 `run` 这次原生合并，前后各核一次 HEAD（见文件头）。 */
export async function mergeInUserCheckout(repo: string, names: Names, run: () => Promise<TaskMergeResult>): Promise<TaskMergeResult> {
  const { targetBranch } = names;
  const ref = `refs/heads/${targetBranch}`;
  const fail = (message: string): TaskMergeResult => ({ ok: false, reason: "merge_failed", message, ...names, targetPath: repo });
  const left = await checkoutLeft(repo, targetBranch);
  if (left) return fail(`合并之前项目目录 ${repo} 已经不在 ${targetBranch} 上了（现在是${left}），这次没动它，重新验收即可。`);
  const before = await tipOf(repo, ref);
  const result = await run();
  const head = await headRef(repo);
  if (head === ref) return result;
  const where = describe(head);
  if (!result.ok) {
    return fail(`${result.message}\n另外，合并的同时项目目录被切到了${where}，上面这次合并对的可能是那里、不是 ${targetBranch}；`
      + `${targetBranch} 现在在 ${(await tipOf(repo, ref) ?? "读不到").slice(0, 12)}。Navi 没有替你复位，在项目目录里 \`git status\` 核对后再重新验收。`);
  }
  if (result.method === "no_commit") {
    return fail(`改动已经暂存，但合并的同时项目目录被切到了${where}，暂存的改动跟着到了那里、不在 ${targetBranch} 的检出里，`
      + `所以这次不算验收通过。Navi 没有替你复位，在项目目录里 \`git status\` 核对后处理，再重新验收。`);
  }
  // 目标分支动了 = 合并落在了它上面，之后才被切走；已经合入的本来就什么都不写。
  if (result.method === "already_merged" || await tipOf(repo, ref) !== before) return result;
  const landed = head ? await tipOf(repo, head) : await tipOf(repo, "HEAD");
  return fail(`合并的同时项目目录被切到了${where}，这次合并落在了那里（它现在在 ${(landed ?? "读不到").slice(0, 12)}），`
    + `目标分支 ${targetBranch} 没动。Navi 没有替你复位：要撤掉，在项目目录里用 \`git reflog\` 找到合并之前的位置、`
    + "`git reset --hard` 回去；然后重新验收。");
}
