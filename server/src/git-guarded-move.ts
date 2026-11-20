// 带护栏地挪一个本地分支（连同它在项目目录里的检出）：推送档的「远程同步进来」和「推上去之后快进本地」共用。
//
// 不变量：**只动这一个分支**，而且只在它还指着 `from` 时动。项目目录检出着它时，HEAD 指着谁、会不会覆盖检出里的改动，
// 都在持有那份检出的 `index.lock` 时核（git 自己的约定：切分支、提交、合并都要先拿它，拿不到就退），
// 核完到写完之间别的 git 进不来 —— 不能像 `git merge --ff-only` 那样先看一眼再对「届时的 HEAD」下手：
// 两条命令之间另一个终端切了分支，被快进的就是那个分支（审查第 1 轮 F2 实测）。
//
// 顺序与合并预览档的发布一样（git-accept-publish.ts 文件头）：先演（`read-tree -n`，不写文件），再带旧值挪
// 分支（被别人挪过就拒），最后才写文件、把新索引换进去。检出里有改动不拦：两树 `read-tree -m -u` 就是
// `git checkout` / `git merge --ff-only` 换版本的那套规则 —— 这次不改的路径上的改动原样留着，会被覆盖的
// （改过的文件这次也要改、挡路的未跟踪文件）git 自己拒，演的那一步就停下（审查第 3 轮 F2：用户在项目目录
// 改着一个无关文件时，同步远程不该被拦住）。写文件写到一半失败就停在那儿如实说，不替用户复位。
// 目标哪儿都没检出：先用不检出文件的临时 worktree 占住它（期间谁也检出不了），再带旧值 `update-ref`
// （git-accept-temp.ts whileBranchClaimed，那里写着为什么不能「挪完再看一眼、被检出了就退回」）。
import { open, copyFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileText as exec } from "./exec.js";
import { expandHome, gitError } from "./git.js";
import { targetCheckout } from "./git-accept.js";
import { checkoutRecovery } from "./git-worktree-state.js";
import { whileBranchClaimed } from "./git-accept-temp.js";

export type GuardedMove =
  | { ok: true; warning?: string }
  | { ok: false; reason: "target_dirty" | "target_checked_out" | "target_moved" | "target_busy" | "move_partial"; message: string };

const rev = async (repo: string, ref: string) =>
  (await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref]).catch(() => null))?.stdout.trim() || null;

/** 把 `branch` 从 `from` 挪到 `to`。`what` 是给人看的这一下在干什么（「把 origin/main 的新提交同步进 main」）。 */
export async function moveBranchGuarded(repoPath: string, branch: string, from: string, to: string, what: string): Promise<GuardedMove> {
  const repo = expandHome(repoPath);
  const ref = `refs/heads/${branch}`;
  const moved = async (): Promise<GuardedMove> => ({ ok: false, reason: "target_moved",
    message: `${what}时 ${branch} 已经不在 ${from.slice(0, 12)} 上（现在${(await rev(repo, ref))?.slice(0, 12) ?? "读不到"}），有别的程序同时动了它；Navi 没有碰它。` });
  const checkout = await targetCheckout(repo, branch);
  if (checkout.path && !checkout.atRepo) {
    return { ok: false, reason: "target_checked_out",
      message: `${what}要挪 ${branch}，但它检出在另一个 worktree ${checkout.path} 上；未操作该工作区。${checkoutRecovery(checkout) ?? ""}` };
  }
  if (!checkout.path) {
    const claim = await whileBranchClaimed(repo, branch,
      () => exec("git", ["-C", repo, "update-ref", ref, to, from]).then(() => true, () => false));
    if (!claim.claimed) {
      return claim.checkedOutAt
        ? { ok: false, reason: "target_checked_out", message: `${what}的同时 ${branch} 被检出到了 ${claim.checkedOutAt}，这次没动它。` }
        : { ok: false, reason: "target_busy", message: `${what}之前没能占住 ${branch}（${claim.message}），这次没动它。` };
    }
    if (!claim.value) return moved();
    return claim.cleanupError ? { ok: true, warning: `${what}时用来占住 ${branch} 的临时 worktree 没拆干净：${claim.cleanupError}` } : { ok: true };
  }
  return moveInCheckout(repo, branch, from, to, what, moved);
}

async function moveInCheckout(repo: string, branch: string, from: string, to: string, what: string,
  moved: () => Promise<GuardedMove>): Promise<GuardedMove> {
  const gitDir = (await exec("git", ["-C", repo, "rev-parse", "--absolute-git-dir"])).stdout.trim();
  const lock = join(gitDir, "index.lock");
  const scratch = join(gitDir, `navi-move-${process.pid}-${Date.now()}.index`);
  const ref = `refs/heads/${branch}`;
  let handle;
  try { handle = await open(lock, "wx"); } catch {
    return { ok: false, reason: "target_busy", message: `${what}时项目目录 ${repo} 正被别的 git 用着（${lock} 在），这次没动；它用完再验收。` };
  }
  let committed = false;
  try {
    // 持锁之后才核：这之后谁也切不了分支、提交不了，核到的就是要写的那一刻的样子。
    const head = (await exec("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"]).catch(() => null))?.stdout.trim();
    if (head !== ref) {
      return { ok: false, reason: "target_checked_out", message: `${what}时项目目录 ${repo} 已经不在 ${branch} 上（现在是 ${head ?? "游离的提交"}），这次没动。` };
    }
    if (await rev(repo, ref) !== from) return await moved();
    await copyFile(join(gitDir, "index"), scratch).catch(() => {});
    const git = (args: string[]) => exec("git", ["-C", repo, ...args], { env: { ...process.env, GIT_INDEX_FILE: scratch } });
    await git(["update-index", "-q", "--refresh"]).catch(() => {});
    try { await git(["read-tree", "-m", "-u", "-n", from, to]); } catch (error) {
      return { ok: false, reason: "target_dirty", message: `${what}会覆盖项目目录 ${repo} 里的文件（${gitError(error)}），这次没动。` };
    }
    try { await exec("git", ["-C", repo, "update-ref", ref, to, from]); } catch { return await moved(); }
    try { await git(["read-tree", "-m", "-u", from, to]); } catch (error) {
      return { ok: false, reason: "move_partial", message: `${branch} 已经挪到 ${to.slice(0, 12)}，但把文件写进项目目录 ${repo} 时失败了（${gitError(error)}），`
        + "索引还停在原来那一版，Navi 没有替你复位；在项目目录里 `git status` 核对后用 `git reset --keep HEAD` 或手动处理。" };
    }
    // 新索引写进锁文件再换上去 —— 跟 git 自己提交索引是同一个动作，换上的那一刻锁也就放了。
    try {
      await handle.close();
      handle = undefined;
      await copyFile(scratch, lock);
      await rename(lock, join(gitDir, "index"));
    } catch (error) {
      return { ok: false, reason: "move_partial", message: `${branch} 已经挪到 ${to.slice(0, 12)}、文件也写进了项目目录 ${repo}，但换上新索引时失败了`
        + `（${error instanceof Error ? error.message : String(error)}），索引还停在原来那一版；Navi 没有替你复位，在项目目录里 \`git status\` 核对后`
        + "用 `git reset --keep HEAD` 或手动处理。" };
    }
    committed = true;
    return { ok: true };
  } finally {
    await handle?.close().catch(() => {});
    if (!committed) await rm(lock, { force: true }).catch(() => {});
    await rm(scratch, { force: true }).catch(() => {});
  }
}
