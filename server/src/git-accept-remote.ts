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
//  · 不碰别人的工作区：挪本地目标分支一律走 git-guarded-move.ts（只动这一个分支、持锁核检出）。
//
// 网络那两下（拉、推）带项目里存的账号（git-credentials.ts gitNetInjection，同「更新远程」「推送」那几个入口）：
// 私有仓库在项目里配了令牌，验收这一档不能退回去只认系统凭证。
//
// 「推到哪」照 git 自己的口径：推给**远程名**，跟用户在终端里 `git push <远程>` 一样 —— 地址由用户自己的 git 配置
// 算出（pushurl、pushInsteadOf 等都算进去）。Navi 不把算好的地址再塞回 git：塞回去会被 insteadOf 这类改写规则
// 再改一遍，确认的和实际接收的反而对不上（审查第 4 轮起三轮，熔断后用户交我定，选了这条）。担保的边界因此是：
// 推给你确认的那个远程、目的地是 `git remote get-url --push` 此刻算出的那一处（确认框显示的就是它，执行时核指纹），
// 回执写的是 git 推送时自己报出的地址（`--porcelain` 的 `To` 行），推到哪一目了然。
// 拉也按远程名拉（同 `git pull`）：远程的拉取地址和推送地址指向不同仓库时，拉到的不是接收推送的那一份 —— 那样
// 推会被当成非快进拒掉（从不强推），如实报错，不会盖掉谁的提交。
import type { AcceptPushOutcome } from "@navi/shared/accept-gate";
import { execFileText as exec } from "./exec.js";
import { expandHome, gitError, localBranchExists } from "./git.js";
import { isAncestor } from "./git-accept.js";
import { moveBranchGuarded, type GuardedMove } from "./git-guarded-move.js";
import { gitNetInjection } from "./git-credentials.js";
import { redactUrlsIn } from "./git-identity.js";

/** 推到哪：远程名 + 远程上的分支名 + 此刻 git 为这个远程算出的推送地址（确认框显示、指纹核对用；推的时候只写远程名）。 */
export type PushTarget = { remote: string; remoteBranch: string; url: string };

export type RemoteSync =
  | { ok: true; tip: string | null; fastForwarded: number; warning?: string }
  /** `tip`：拉到了的远程那一头（拉不到时没有）—— 本地同步不了，调用方仍拿它判任务跟远程冲不冲突（task-accept-push.ts）。 */
  | { ok: false; reason: "push_fetch_failed" | "push_diverged" | Extract<GuardedMove, { ok: false }>["reason"]; message: string; tip?: string };

export type PushOutcome = AcceptPushOutcome;

// 网络命令一律不许等人输密码：服务端没有终端，等到的只会是超时。命令里只写远程名，地址（可能内嵌账号密码）
// 不进 argv（server/CLAUDE.md「密钥绝不进 argv」）。
async function network(repo: string, projectId: string | null, args: string[], timeoutMs: number) {
  const injection = await gitNetInjection(projectId);
  return exec("git", ["-C", repo, ...injection.args, ...args],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...injection.env }, timeoutMs });
}
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
  // 配了多个推送地址（一推推好几处）不支持：一处成一处败时说不清这一下算不算推上去了。
  const urls = (await exec("git", ["-C", repo, "remote", "get-url", "--push", "--all", remote]).catch(() => ({ stdout: "" }))).stdout
    .split("\n").map((line) => line.trim()).filter(Boolean);
  return urls.length === 1 ? { remote, remoteBranch, url: urls[0]! } : null;
}

/**
 * 从远程拉那一支的最新提交（同 `git fetch <远程>`，落进 refs/remotes/<remote>/<branch>），返回它。
 * 远程上还没有这一支 → tip:null（第一次推，推上去就是新建）。
 */
export async function fetchTip(repoPath: string, target: PushTarget, projectId: string | null): Promise<{ ok: true; tip: string | null } | { ok: false; message: string }> {
  const repo = expandHome(repoPath);
  const tracking = `refs/remotes/${target.remote}/${target.remoteBranch}`;
  try {
    await network(repo, projectId, ["fetch", "--no-tags", "--quiet", target.remote, `+refs/heads/${target.remoteBranch}:${tracking}`], FETCH_TIMEOUT_MS);
  } catch (error) {
    const message = redactUrlsIn(gitError(error));
    if (/couldn't find remote ref|could not find remote ref/i.test(message)) return { ok: true, tip: null };
    return { ok: false, message };
  }
  return { ok: true, tip: await commitOf(repo, tracking) };
}

/**
 * 把远程目标分支的新提交同步进本地目标分支（只快进）。本地已经含着远程那一头（相等、或本地领先）就什么都不动。
 *
 * 快进本地目标分支走 git-guarded-move.ts：只动这一个分支、只在它还指着刚读到的那一版时动，检出着时持锁核检出。
 */
export async function syncTargetWithRemote(repoPath: string, branch: string, target: PushTarget, projectId: string | null): Promise<RemoteSync> {
  const repo = expandHome(repoPath);
  const remoteName = `${target.remote}/${target.remoteBranch}`;
  const fetched = await fetchTip(repoPath, target, projectId);
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
    return { ok: false, reason: "push_diverged", tip,
      message: `本地 ${branch} 和 ${remoteName} 分叉了：本地有 ${ahead} 个提交还没推，远程又多了 ${behind} 个本地没有的提交。`
        + `这不是这个任务造成的，Navi 不替你合；先自己把 ${branch} 跟 ${remoteName} 同步好（比如 git -C ${repo} pull），`
        + "再验收，或这次不推送。这次什么都没动。" };
  }
  const behind = await count(repo, `${local}..${tip}`);
  const moved = await moveBranchGuarded(repo, branch, local, tip, `把 ${remoteName} 的 ${behind} 个新提交同步进 ${branch}`);
  if (!moved.ok) return { ok: false, reason: moved.reason, tip, message: `${moved.message}这次没有合并。` };
  return { ok: true, tip, fastForwarded: behind, ...(moved.warning ? { warning: moved.warning } : {}) };
}

/**
 * 把**这个提交**推上去（推送档生成的那次合并，task-accept-push.ts）—— 不读任何分支头：推那一刻目标分支指着谁
 * 跟这一次推的是什么无关（审查第 3 轮 F1）。不强推：远程在这期间又被人推过、不再是它的祖先，就如实报被拒。
 */
export async function pushCommit(repoPath: string, commit: string, target: PushTarget, projectId: string | null): Promise<PushOutcome> {
  const repo = expandHome(repoPath);
  const base = { remote: target.remote, remoteBranch: target.remoteBranch };
  try {
    const { stdout } = await network(repo, projectId, ["push", "--porcelain", target.remote, `${commit}:refs/heads/${target.remoteBranch}`], PUSH_TIMEOUT_MS);
    // --porcelain 每个 ref 一行，`=` 打头 = 远程本来就是这个提交；`To <地址>` 是 git 实际推往的地方，写进回执。
    const lines = stdout.split("\n");
    const upToDate = lines.some((line) => line.startsWith("=\t"));
    const to = lines.find((line) => line.startsWith("To "))?.slice(3).trim();
    return { ...base, ok: true, commit, upToDate, ...(to ? { to: redactUrlsIn(to) } : {}) };
  } catch (error) {
    // --porcelain 把每个 ref 的结局写在 stdout（`!` 打头 = 被拒），stderr 只剩一句 failed to push。
    const refs = String((error as { stdout?: string }).stdout ?? "");
    const rejected = /^!\t.*\[rejected\]|non-fast-forward|fetch first|\(stale info\)/im.test(`${refs}\n${gitError(error)}`);
    const refused = refs.split("\n").find((line) => line.startsWith("!\t"))?.split("\t").slice(2).join(" ").trim();
    const message = redactUrlsIn(refused ? `${refused}（${gitError(error)}）` : gitError(error));
    return { ...base, ok: false, reason: rejected ? "push_rejected" : "push_failed", message };
  }
}
