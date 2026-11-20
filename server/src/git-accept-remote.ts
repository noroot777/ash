// 验收「推送到远程」那一档要动的 git：找推到哪、先把远程的新提交同步进本地目标分支、合完推上去。
//
// 为什么先同步再合，而不是合完推、被拒了再说：被拒的那一刻任务分支已经合进本地目标分支，
// 远程的新提交只能在目标分支上跟这次合并去对冲突 —— 那是用户的分支，不是智能体的，没人能
// 替他解。先同步，远程的新改动就进了本地目标分支，后面的门禁基准、合并冲突都照原来那套走：
// 撞了冲突就叫醒任务在**它自己的分支**上 `git merge <目标>` 解掉（accept-conflict.ts），
// 解完再点验收就是 fast-forward，推上去也是 fast-forward。
//
// 三条不做的事：
//  · 不强推（没有 --force / --force-with-lease）：远程上别人的提交一个都不许盖掉；
//  · 本地目标分支和远程分叉了（本地有没推的、远程也有新的）不替他合：那不是这个任务造成的；
//  · 不碰别人的工作区：目标分支检出在别的 worktree 上、或项目目录脏着，同步就不做，跟合并同一套判断。
import type { AcceptPushOutcome } from "@navi/shared/accept-gate";
import { execFileText as exec } from "./exec.js";
import { expandHome, gitError, localBranchExists, porcelainFiles } from "./git.js";
import { isAncestor, targetCheckout } from "./git-accept.js";
import { checkoutRecovery } from "./git-worktree-state.js";

/** 推到哪：远程名 + 远程上的分支名。 */
export type PushTarget = { remote: string; remoteBranch: string };

export type RemoteSync =
  | { ok: true; tip: string | null; fastForwarded: number }
  | { ok: false; reason: "push_fetch_failed" | "push_diverged" | "target_dirty" | "target_checked_out"; message: string };

export type PushOutcome = AcceptPushOutcome;

// 网络命令一律不许等人输密码：服务端没有终端，等到的只会是超时。
const NETWORK_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const FETCH_TIMEOUT_MS = 90_000;
const PUSH_TIMEOUT_MS = 180_000;

async function config(repo: string, key: string): Promise<string | null> {
  try { return (await exec("git", ["-C", repo, "config", "--get", key])).stdout.trim() || null; }
  catch { return null; }
}

async function commitOf(repo: string, ref: string): Promise<string | null> {
  try { return (await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim() || null; }
  catch { return null; }
}

const count = async (repo: string, range: string) =>
  Number((await exec("git", ["-C", repo, "rev-list", "--count", range]).catch(() => ({ stdout: "0" }))).stdout.trim()) || 0;

/**
 * 目标分支推到哪。照 git 自己 `git push` 时的口径：branch.<b>.pushRemote → remote.pushDefault →
 * branch.<b>.remote，都没有而仓库里有 origin 就用 origin。远程上的分支名跟上游走（上游就在这个远程上时），
 * 否则同名。上游是本地（remote = "."）或仓库压根没有远程 → null，这一档不提供。
 */
export async function resolvePushTarget(repoPath: string, branch: string): Promise<PushTarget | null> {
  const repo = expandHome(repoPath);
  const remotes = (await exec("git", ["-C", repo, "remote"]).catch(() => ({ stdout: "" }))).stdout
    .split("\n").map((line) => line.trim()).filter(Boolean);
  if (!remotes.length) return null;
  const upstreamRemote = await config(repo, `branch.${branch}.remote`);
  const remote = await config(repo, `branch.${branch}.pushRemote`) ?? await config(repo, "remote.pushDefault")
    ?? upstreamRemote ?? (remotes.includes("origin") ? "origin" : null);
  if (!remote || remote === "." || !remotes.includes(remote)) return null;
  const merge = upstreamRemote === remote ? await config(repo, `branch.${branch}.merge`) : null;
  const remoteBranch = merge?.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : branch;
  return { remote, remoteBranch };
}

/**
 * 拉远程那一支的最新提交到 refs/remotes/<remote>/<branch>（就是 `git fetch` 平常更新的那个），返回它。
 * 远程上还没有这一支 → tip:null（第一次推，推上去就是新建）。
 */
async function fetchTip(repo: string, target: PushTarget): Promise<{ ok: true; tip: string | null } | { ok: false; message: string }> {
  const tracking = `refs/remotes/${target.remote}/${target.remoteBranch}`;
  try {
    await exec("git", ["-C", repo, "fetch", "--no-tags", "--quiet", target.remote, `+refs/heads/${target.remoteBranch}:${tracking}`],
      { env: NETWORK_ENV, timeoutMs: FETCH_TIMEOUT_MS });
  } catch (error) {
    const message = gitError(error);
    if (/couldn't find remote ref|could not find remote ref/i.test(message)) return { ok: true, tip: null };
    return { ok: false, message };
  }
  return { ok: true, tip: await commitOf(repo, tracking) };
}

/**
 * 把远程目标分支的新提交同步进本地目标分支（只快进）。本地已经含着远程那一头（相等、或本地领先）就什么都不动。
 *
 * 快进本地目标分支跟合并时挪它是同一个分寸：检出在项目目录上要干净、用 `merge --ff-only`；检出在别的
 * worktree 上不碰；哪儿都没检出就带旧值 `update-ref`（期间被人挪过就失败，不会盖掉）。
 */
export async function syncTargetWithRemote(repoPath: string, branch: string, target: PushTarget): Promise<RemoteSync> {
  const repo = expandHome(repoPath);
  const remoteName = `${target.remote}/${target.remoteBranch}`;
  const fetched = await fetchTip(repo, target);
  if (!fetched.ok) {
    return { ok: false, reason: "push_fetch_failed",
      message: `选了「推送到 ${remoteName}」，但拉不到远程的最新状态：${fetched.message}。这次什么都没动；网络或权限好了再验收，或这次不推送。` };
  }
  const tip = fetched.tip;
  if (!tip || !(await localBranchExists(repo, branch))) return { ok: true, tip, fastForwarded: 0 };
  const local = await commitOf(repo, `refs/heads/${branch}`);
  if (!local || local === tip || await isAncestor(repo, tip, local)) return { ok: true, tip, fastForwarded: 0 };
  if (!(await isAncestor(repo, local, tip))) {
    const [ahead, behind] = await Promise.all([count(repo, `${tip}..${local}`), count(repo, `${local}..${tip}`)]);
    return { ok: false, reason: "push_diverged",
      message: `本地 ${branch} 和 ${remoteName} 分叉了：本地有 ${ahead} 个提交还没推，远程又多了 ${behind} 个本地没有的提交。`
        + `这不是这个任务造成的，Navi 不替你合；先自己把 ${branch} 跟 ${remoteName} 同步好（比如 git -C ${repo} pull），`
        + "再验收，或这次不推送。这次什么都没动。" };
  }
  const behind = await count(repo, `${local}..${tip}`);
  const checkout = await targetCheckout(repo, branch);
  try {
    if (checkout.atRepo) {
      const dirty = porcelainFiles((await exec("git", ["-C", repo, "status", "--porcelain"])).stdout);
      if (dirty.length) {
        return { ok: false, reason: "target_dirty",
          message: `要先把 ${remoteName} 的 ${behind} 个新提交同步进 ${branch}，但项目目录 ${repo} 检出着 ${branch} 且工作区不干净；未执行同步：${dirty.join("、")}` };
      }
      await exec("git", ["-C", repo, "merge", "--ff-only", "--quiet", tip]);
    } else if (checkout.path) {
      return { ok: false, reason: "target_checked_out",
        message: `要先把 ${remoteName} 的 ${behind} 个新提交同步进 ${branch}，但它检出在另一个 worktree ${checkout.path} 上；未操作该工作区。${checkoutRecovery(checkout) ?? ""}` };
    } else {
      await exec("git", ["-C", repo, "update-ref", `refs/heads/${branch}`, tip, local]);
    }
  } catch (error) {
    return { ok: false, reason: "push_fetch_failed", message: `把 ${remoteName} 同步进 ${branch} 失败：${gitError(error)}。这次没有合并。` };
  }
  return { ok: true, tip, fastForwarded: behind };
}

/** 合完之后推上去。不强推：远程在这期间又被人推过，就如实报被拒。 */
export async function pushTargetBranch(repoPath: string, branch: string, target: PushTarget): Promise<PushOutcome> {
  const repo = expandHome(repoPath);
  const base = { remote: target.remote, remoteBranch: target.remoteBranch };
  const commit = await commitOf(repo, `refs/heads/${branch}`);
  if (!commit) return { ...base, ok: false, reason: "push_failed", message: `本地分支 ${branch} 不存在` };
  try {
    const { stdout } = await exec("git", ["-C", repo, "push", "--porcelain", target.remote, `refs/heads/${branch}:refs/heads/${target.remoteBranch}`],
      { env: NETWORK_ENV, timeoutMs: PUSH_TIMEOUT_MS });
    // --porcelain 每个 ref 一行，`=` 打头 = 远程本来就是这个提交。
    const upToDate = stdout.split("\n").some((line) => line.startsWith("=\t"));
    return { ...base, ok: true, commit, upToDate };
  } catch (error) {
    // --porcelain 把每个 ref 的结局写在 stdout（`!` 打头 = 被拒），stderr 只剩一句 failed to push。
    const refs = String((error as { stdout?: string }).stdout ?? "");
    const rejected = /^!\t.*\[rejected\]|non-fast-forward|fetch first|\(stale info\)/im.test(`${refs}\n${gitError(error)}`);
    const refused = refs.split("\n").find((line) => line.startsWith("!\t"))?.split("\t").slice(2).join(" ").trim();
    const message = refused ? `${refused}（${gitError(error)}）` : gitError(error);
    return { ...base, ok: false, reason: rejected ? "push_rejected" : "push_failed", message };
  }
}
