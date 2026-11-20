// 把合好的结果落进**项目目录里检出着的**目标分支：验收合并（git-accept.ts）在目标就检出在项目目录时走这里。
//
// 不变量：只在项目目录此刻仍检出着目标分支、它还指着合并时的那个提交、工作区干净时动，而且这三样都在持有
// 那份检出的 `index.lock` 时核（git 自己的约定：切分支、提交、合并都要先拿它，拿不到就退），核完到写完之间
// 别的 git 进不来。不能像原先那样先 `git status` 看一眼、再在项目目录里 `git merge`：两步之间另一个终端切了
// 分支，合并落进的就是那个分支（`git merge` 对的是「届时的 HEAD」）。
//
// 所以合并本身不在项目目录里跑（`git merge` 自己要拿这把锁），在一份游离在目标提交上的临时检出里合出结果
// （mergeBeside），落进项目目录只做「快进到它」（landInCheckout）—— 与推送档挪分支同一个顺序：先演（`read-tree -n`，不写文件），再带旧值挪分支
// （期间被挪过就拒），最后写文件、把新索引换进去。「合并后不提交」那一档不挪分支，只把索引和工作区换成那棵树。
// 写文件写到一半失败就停在那儿如实说，不替用户复位。
//
// 剩下的窗口是 git 自己的：`git switch -c <新分支>`（在当前提交上新建）和 `git symbolic-ref` 不拿索引锁。
// 写文件之前再核一次 HEAD：那之前切走的，目标就不再检出在这里 —— 挪了分支的照「哪儿都没检出」算（只挪 ref、
// 检出不碰，正是对的），不挪分支的那一档如实拒。核完到写文件之间切走的，与两个终端同时 `git merge` 和
// `git switch -c` 是同一种竞争，git 本身也不防。
import { copyFile, open, rename, rm } from "node:fs/promises";
import { execFileText as exec } from "./exec.js";
import { gitError, porcelainFiles } from "./git.js";
import { ACCEPT_REFLOG_PREFIX } from "./git-accept-tested.js";
import { addTemporaryWorktree, removeTemporaryWorktree, type TemporaryWorktree } from "./git-accept-temp.js";
import { isAncestor, withTemporaryCleanupOutcome, type TaskMergeResult } from "./git-accept.js";

type Names = { sourceBranch: string; targetBranch: string };

const rev = async (repo: string, ref: string) =>
  (await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref]).catch(() => null))?.stdout.trim() || null;
const symbolicHead = async (repo: string) =>
  (await exec("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"]).catch(() => null))?.stdout.trim() || null;
const shown = (head: string | null) => head ? `分支 ${head.replace(/^refs\/heads\//, "")}` : "一个游离的提交";

/**
 * 把项目目录 `repo` 里检出着的目标分支从 `from` 落到 `to`。`moveBranch` = 挪分支（`to` 是提交）；否则只把
 * 索引和工作区换成 `to` 那棵树（「合并后不提交」）。落成返回 null，落不成返回失败回执（什么都没动的
 * 会这么说，动了一半的也照实说）。
 */
export async function landInCheckout(repo: string, names: Names, from: string, to: string,
  moveBranch: boolean): Promise<TaskMergeResult | null> {
  const { targetBranch } = names;
  const fail = (message: string): TaskMergeResult => ({ ok: false, reason: "merge_failed", message, ...names, targetPath: repo });
  const ref = `refs/heads/${targetBranch}`;
  const index = (await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
  const lock = `${index}.lock`;
  // 放在真索引旁边：拆分索引（core.splitIndex）的 sharedindex 文件 git 按「索引所在目录」找。
  const scratch = `${index}.navi-land-${process.pid}-${Date.now()}`;
  let handle = await open(lock, "wx").catch(() => null);
  if (!handle) {
    return fail(`目标分支 ${targetBranch} 检出在项目目录 ${repo}，那里正有别的 git 命令在用（${lock} 在），`
      + "这次没合并，目标分支和工作区都没动；它用完再验收。");
  }
  let installed = false;
  try {
    // 持锁之后才核：这之后谁也切不了已有分支、提交不了，核到的就是要写的那一刻的样子。
    const head = await symbolicHead(repo);
    if (head !== ref) {
      return fail(`合并的同时项目目录 ${repo} 切到了${shown(head)}，不再检出着目标分支 ${targetBranch}；这次没动它，重新验收即可。`);
    }
    const now = await rev(repo, ref);
    if (now !== from) {
      return fail(`合并的同时目标分支 ${targetBranch} 被别的程序挪了（合的时候在 ${from.slice(0, 12)}，现在${now ? `在 ${now.slice(0, 12)}` : "读不到"}），`
        + "这次没动它，重新验收会按现在的目标分支重新合。");
    }
    await copyFile(index, scratch).catch(() => {});
    const git = (args: string[]) => exec("git", ["-C", repo, ...args], { env: { ...process.env, GIT_INDEX_FILE: scratch } });
    // 与锁外那道「工作区干净」同一个口径（git status，未跟踪的也算）。
    const dirtyFiles = porcelainFiles((await git(["status", "--porcelain"])).stdout);
    if (dirtyFiles.length > 0) {
      return { ok: false, reason: "target_dirty", ...names, targetPath: repo, dirtyFiles,
        message: `目标分支 ${targetBranch} 检出在项目目录，合并的同时那里有了没提交的改动；这次没合并，目标分支和工作区都没动。` };
    }
    try { await git(["read-tree", "-m", "-u", "-n", from, to]); } catch (error) {
      return fail(`把合并结果写进项目目录 ${repo} 会覆盖那里的文件（${gitError(error)}），这次没合并，目标分支和工作区都没动。`);
    }
    if (moveBranch) {
      try {
        await exec("git", ["-C", repo, "update-ref", "-m", `${ACCEPT_REFLOG_PREFIX} ${names.sourceBranch}`, ref, to, from]);
      } catch {
        return fail(`合并的同时目标分支 ${targetBranch} 被别的程序挪了（现在${(await rev(repo, ref))?.slice(0, 12) ?? "读不到"}），这次没动它，重新验收即可。`);
      }
    }
    // 写文件之前再核一次 HEAD（文件头：`switch -c` 不拿索引锁）。
    const still = await symbolicHead(repo);
    if (still !== ref) {
      if (moveBranch) return null;
      return fail(`合并的同时项目目录 ${repo} 切到了${shown(still)}，不再检出着目标分支 ${targetBranch}；这次没动它，重新验收即可。`);
    }
    try { await git(["read-tree", "-m", "-u", from, to]); } catch (error) {
      return fail(moveBranch
        ? `${targetBranch} 已经挪到 ${to.slice(0, 12)}，但把文件写进项目目录 ${repo} 时失败了（${gitError(error)}），`
          + "索引还停在原来那一版，Navi 没有替你复位；在项目目录里 `git status` 核对后用 `git reset --keep HEAD` 或手动处理。"
        : `把合并结果写进项目目录 ${repo} 时失败了（${gitError(error)}），目标分支和索引都没动，已经写下的文件 Navi 没有替你复位；`
          + "在项目目录里 `git status` 核对后用 `git checkout -- <路径>` 取回或手动处理。");
    }
    // 新索引写进锁文件再换上去 —— 跟 git 自己提交索引是同一个动作，换上的那一刻锁也就放了。
    try {
      await handle.close();
      handle = null;
      await copyFile(scratch, lock);
      await rename(lock, index);
      installed = true;
    } catch (error) {
      return fail(`${moveBranch ? `${targetBranch} 已经挪到 ${to.slice(0, 12)}、` : ""}文件也写进了项目目录 ${repo}，但换上新索引时失败了`
        + `（${error instanceof Error ? error.message : String(error)}），索引还停在原来那一版；Navi 没有替你复位，在项目目录里 \`git status\` 核对后`
        + `${moveBranch ? "用 `git reset -q`（只改索引）" : "用 `git add -A`"}或手动处理。`);
    }
    return null;
  } catch (error) {
    // 走到这里的只有挪分支之前的核对（git status 起不来之类），之后每一步都自己接住了。
    return fail(`没能核对项目目录 ${repo}（${gitError(error)}），这次没合并，目标分支和工作区都没动。`);
  } finally {
    await handle?.close().catch(() => {});
    if (!installed) await rm(lock, { force: true }).catch(() => {});
    await rm(scratch, { force: true }).catch(() => {});
  }
}

/**
 * 目标分支检出在项目目录（锁外已核过干净）时的合并。`git merge` 不能在那份检出里跑：它对的是「届时的
 * HEAD」，核完干净到它开跑之间另一个终端切了分支，合并就落进那个分支（见文件头）。
 * 所以在一份游离在目标提交上的临时检出里照常合（`run`：冲突、钩子、「内容已在目标里」的判定都和临时
 * worktree 那条路是同一段代码），合出的提交（不提交那一档是那棵树）再持锁落进项目目录。
 * `fastForwardTo` 给了、而且目标提交是它的祖先，就不合，直接快进到它。
 */
export async function mergeBeside(
  repo: string,
  names: { sourceBranch: string; targetBranch: string },
  run: (cwd: string) => Promise<TaskMergeResult>,
  fastForwardTo?: string,
): Promise<TaskMergeResult> {
  const before = await rev(repo, `refs/heads/${names.targetBranch}`);
  if (!before) return { ok: false, reason: "merge_failed", message: `读不到目标分支 ${names.targetBranch}`, ...names };
  const source = fastForwardTo ? await rev(repo, `${fastForwardTo}^{commit}`) : null;
  if (source && await isAncestor(repo, before, source)) {
    return await landInCheckout(repo, names, before, source, true) ?? { ok: true, ...names, method: "fast_forward" };
  }
  let temp: TemporaryWorktree;
  try {
    temp = await addTemporaryWorktree(repo, before, true);
  } catch (error) {
    return { ok: false, reason: "merge_failed", message: `创建临时合并 worktree 失败：${gitError(error)}`, ...names };
  }
  let result: TaskMergeResult;
  try {
    result = await run(temp.path);
    if (result.ok && result.method !== "already_merged") {
      const staged = result.method === "no_commit";
      const to = staged ? result.stagedTree : await rev(temp.path, "HEAD");
      result = !to ? { ok: false, reason: "merge_failed", message: "读不到临时 worktree 里合出的结果", ...names }
        : await landInCheckout(repo, names, before, to, !staged) ?? result;
    }
  } catch (error) {
    result = { ok: false, reason: "merge_failed", message: `合并失败：${gitError(error)}`, ...names };
  }
  return withTemporaryCleanupOutcome(result, await removeTemporaryWorktree(repo, temp), temp.path);
}
