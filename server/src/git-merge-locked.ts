// 目标分支就检出在项目目录时的验收合并：验收合并（git-accept.ts）走到「目标在项目目录、干净」时转到这里。
//
// 不变量：项目目录此刻仍检出着目标分支、工作区干净，这两样在持有那份检出的 `index.lock` 时核（git 自己的约定：
// 切分支、提交、合并都要先拿它，拿不到就退），核完到合完之间别的 git 进不来。不能像原先那样先 `git status`
// 看一眼、再在项目目录里 `git merge`：两步之间另一个终端切了分支，合并就落进那个分支（`git merge` 对的是
// 「届时的 HEAD」）。
//
// `git merge` 自己也要拿 `index.lock`，所以合并时给它一份临时索引（`GIT_INDEX_FILE`，放在真索引旁边、从它拷来）：
// 它锁的是那份的 `.lock`，我们持着的真锁照样挡住别人。合并本身还是原来那几条命令、就在项目目录里跑 —— 钩子的
// 工作目录、能看到的本地文件（被忽略的依赖、构建产物）、`ORIG_HEAD` / `SQUASH_MSG`、合并后钩子都跟原先一样
// （不能挪到另开的临时检出里合：那里没有项目被忽略的本地依赖，靠它们的钩子会失败，审查第 1 轮 F3 实测）。
// 合完把那份索引换成真索引（与 git 自己提交索引同一个动作，换上的那一刻锁也就放了）：它就是 git 刚按这次合并
// 维护好的、与工作区文件对应的那一份，冲突中止、already_merged 复位之后也一样。
//
// 剩下的窗口是 git 自己的：`git switch -c <新分支>`（在当前提交上新建）和 `git symbolic-ref` 不拿索引锁，可能在
// 合并期间把 HEAD 换成另一个分支 —— 与两个终端同时 `git merge` 和 `git switch -c` 是同一种竞争，git 本身也不防。
// 所以合完不凭「命令成功」下结论，按合完那一刻的真实状态回报：目标分支确实挪到了 HEAD 那个提交才算合进去了；
// 合进的是别的分支、或者改动暂存在了别的分支的检出里，就照实说，不替用户复位。
import { copyFile, open, rename, rm } from "node:fs/promises";
import { execFileText as exec } from "./exec.js";
import { gitError, porcelainFiles } from "./git.js";
import type { TaskMergeResult } from "./git-accept.js";

/** 在某个检出里跑一条 git（`-C` 和环境已经定好）。 */
export type GitIn = (args: string[]) => Promise<{ stdout: string }>;
export const gitIn = (cwd: string, env?: NodeJS.ProcessEnv): GitIn =>
  (args) => exec("git", ["-C", cwd, ...args], env ? { env } : {});

type Names = { sourceBranch: string; targetBranch: string };

const rev = async (repo: string, ref: string) =>
  (await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref]).catch(() => null))?.stdout.trim() || null;
const symbolicHead = async (repo: string) =>
  (await exec("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"]).catch(() => null))?.stdout.trim() || null;
const shown = (head: string | null) => head ? `分支 ${head.replace(/^refs\/heads\//, "")}` : "一个游离的提交";

/**
 * 持着项目目录 `repo` 的 `index.lock` 核过 HEAD 指着目标分支、工作区干净，再让 `run` 用临时索引在项目目录里
 * 合并（见文件头）。回报按合完的真实状态校正过。
 */
export async function mergeInLockedCheckout(repo: string, names: Names, run: (git: GitIn) => Promise<TaskMergeResult>): Promise<TaskMergeResult> {
  const { targetBranch } = names;
  const fail = (message: string): TaskMergeResult => ({ ok: false, reason: "merge_failed", message, ...names, targetPath: repo });
  const ref = `refs/heads/${targetBranch}`;
  const index = (await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
  const lock = `${index}.lock`;
  // 放在真索引旁边：拆分索引（core.splitIndex）的 sharedindex 文件 git 按「索引所在目录」找。
  const scratch = `${index}.navi-merge-${process.pid}-${Date.now()}`;
  let handle = await open(lock, "wx").catch(() => null);
  if (!handle) {
    return fail(`目标分支 ${targetBranch} 检出在项目目录 ${repo}，那里正有别的 git 命令在用（${lock} 在），`
      + "这次没合并，目标分支和工作区都没动；它用完再验收。");
  }
  let installed = false;
  let ran = false;
  try {
    // 持锁之后才核：这之后谁也切不了已有分支、提交不了，核到的就是开合那一刻的样子。
    const head = await symbolicHead(repo);
    if (head !== ref) {
      return fail(`合并的同时项目目录 ${repo} 切到了${shown(head)}，不再检出着目标分支 ${targetBranch}；这次没动它，重新验收即可。`);
    }
    const before = await rev(repo, ref);
    await copyFile(index, scratch).catch(() => {});
    const git = gitIn(repo, { ...process.env, GIT_INDEX_FILE: scratch });
    // 与锁外那道「工作区干净」同一个口径（git status，未跟踪的也算）。
    const dirtyFiles = porcelainFiles((await git(["status", "--porcelain"])).stdout);
    if (dirtyFiles.length > 0) {
      return { ok: false, reason: "target_dirty", ...names, targetPath: repo, dirtyFiles,
        message: `目标分支 ${targetBranch} 检出在项目目录，合并的同时那里有了没提交的改动；这次没合并，目标分支和工作区都没动。` };
    }
    ran = true;
    const result = await run(git);
    // 那份索引就是 git 按这次合并维护好的、与工作区文件对应的一份，先换上去再看结果（见文件头）。
    try {
      await handle.close();
      handle = null;
      await copyFile(scratch, lock);
      await rename(lock, index);
      installed = true;
    } catch (error) {
      return fail(`合并已经在项目目录 ${repo} 里跑完（${result.ok ? "成功" : result.message}），但换上它维护的索引时失败了`
        + `（${error instanceof Error ? error.message : String(error)}），索引还停在合并之前；Navi 没有替你复位，在项目目录里 \`git status\` 核对后`
        + "用 `git reset -q`（只改索引）或手动处理。");
    }
    return settled(repo, names, ref, before, result);
  } catch (error) {
    if (ran) return fail(`在项目目录 ${repo} 里合并时出错（${gitError(error)}），Navi 没有替你复位；在项目目录里 \`git status\` 核对后手动处理。`);
    return fail(`没能核对项目目录 ${repo}（${gitError(error)}），这次没合并，目标分支和工作区都没动。`);
  } finally {
    await handle?.close().catch(() => {});
    if (!installed) await rm(lock, { force: true }).catch(() => {});
    await rm(scratch, { force: true }).catch(() => {});
  }
}

/** 合完那一刻的真实状态（文件头最后一段）：合并期间 HEAD 被 `switch -c` 换走时，命令成功不等于合进了目标。 */
async function settled(repo: string, names: Names, ref: string, before: string | null, result: TaskMergeResult): Promise<TaskMergeResult> {
  if (!result.ok || result.method === "already_merged") return result;
  const [head, at, target] = await Promise.all([symbolicHead(repo), rev(repo, "HEAD"), rev(repo, ref)]);
  if (head === ref) return result;
  const where = `合并期间项目目录 ${repo} 被切到了${shown(head)}（\`git switch -c\` 不拿索引锁）`;
  if (result.method === "no_commit") {
    return { ok: false, reason: "merge_failed", ...names, targetPath: repo,
      message: `${where}，改动暂存在了它的检出里，不是目标分支 ${names.targetBranch}；Navi 没有替你复位，核对后在那里提交或用 \`git reset --hard\` 丢掉。` };
  }
  // 目标挪到了 HEAD 那个提交：合并落进了目标，切过去的新分支也是从合并结果起的，检出与索引都对得上。
  if (target && target !== before && target === at) return result;
  return { ok: false, reason: "merge_failed", ...names, targetPath: repo,
    message: `${where}，合并落在了它上面（现在在 ${at?.slice(0, 12) ?? "读不到"}），目标分支 ${names.targetBranch} 没动；Navi 没有替你复位，核对后手动处理，再重新验收。` };
}
