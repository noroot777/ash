import type { RemoteBranch } from "@navi/shared/task-branch";
import { execFileText as exec } from "./exec.js";
import { expandHome } from "./platform.js";

// 远端分支（`refs/remotes/<远端>/<分支>`）的几句只读查询。新建任务可以从远端分支开工
// （task-branch-plan.ts），验收目标和失效判断也要认得出它（git.ts）。
//
// 只依赖 exec / platform，不回头 import git.ts：git.ts 要用这里的判断。

async function refExists(repo: string, ref: string): Promise<boolean> {
  return exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", ref]).then(() => true, () => false);
}

export async function listRemotes(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", expandHome(repoPath), "remote"]);
    return stdout.split("\n").map((name) => name.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `origin/foo` 拆成远端和分支。远端名本身可以带斜杠，取最长的那个前缀。拆不出（没有这个远端）给 null。
 * 只看名字，不问这条远端分支此刻在不在本地 —— 还没 fetch 过的也认，调用方据此决定要不要先 fetch。
 */
export function splitRemoteRef(name: string, remotes: readonly string[]): RemoteBranch | null {
  const ref = name.trim().replace(/^refs\/remotes\//, "");
  const remote = remotes
    .filter((candidate) => ref.startsWith(`${candidate}/`) && ref.length > candidate.length + 1)
    .sort((left, right) => right.length - left.length)[0];
  return remote ? { ref, fullRef: `refs/remotes/${ref}`, remote, branch: ref.slice(remote.length + 1) } : null;
}

/**
 * 这个名字指的是不是一条远端分支。写成 `refs/remotes/origin/x` 的就是（界面选远端分支时发的就是这种）；
 * 短名 `origin/x` 照 git 自己解析 `<name>` 的先后：同名的 tag、本地分支排在远端分支前面，有就按它们算。
 */
export async function remoteBranchOf(repoPath: string, name: string | null | undefined): Promise<RemoteBranch | null> {
  const repo = expandHome(repoPath);
  const trimmed = (name ?? "").trim();
  if (trimmed.startsWith("refs/remotes/")) return splitRemoteRef(trimmed, await listRemotes(repo));
  if (!trimmed || trimmed.startsWith("refs/")) return null;
  for (const shadow of [`refs/${trimmed}`, `refs/tags/${trimmed}`, `refs/heads/${trimmed}`]) {
    if (await refExists(repo, shadow)) return null;
  }
  return splitRemoteRef(trimmed, await listRemotes(repo));
}

/** 本地此刻有没有这条远端分支的记录（`refs/remotes/<ref>`）。 */
export async function remoteTrackingExists(repoPath: string, ref: string): Promise<boolean> {
  return refExists(expandHome(repoPath), `refs/remotes/${ref.replace(/^refs\/remotes\//, "")}`);
}

/** 本地记着的全部远端分支，去掉 `origin/HEAD` 这类指向别处的符号引用。 */
export async function listRemoteBranches(repoPath: string, known?: readonly string[]): Promise<RemoteBranch[]> {
  const repo = expandHome(repoPath);
  const remotes = known ?? await listRemotes(repo);
  if (!remotes.length) return [];
  let stdout = "";
  try {
    ({ stdout } = await exec("git", ["-C", repo, "for-each-ref", "--format=%(refname)%00%(symref)", "refs/remotes"],
      { maxBuffer: 4 * 1024 * 1024 }));
  } catch {
    return [];
  }
  return stdout.split("\n").flatMap((line) => {
    const [refname, symref] = line.split("\0");
    if (!refname || symref) return [];
    const parsed = splitRemoteRef(refname, remotes);
    return parsed ? [parsed] : [];
  });
}

/** 跑一条 git 子命令（不带 `-C`，调用方自己绑仓库），返回 stdout。 */
export type GitRun = (args: string[]) => Promise<string>;

/**
 * 建一条跟踪远端分支的本地分支。
 *
 * `git branch --track` 一条命令里先建引用、再写 upstream 配置：配置写不进去（`.git/config` 被别的 git 进程
 * 锁着、没有写权限）时引用已经留下，命令却报错——拿「命令成没成」判断有没有东西要收回，就会漏掉这条分支。
 * 所以拆成两步：先建引用（单个 ref，要么有要么没有），再写 upstream；第二步失败就把刚建的分支收回。
 * upstream 用完整引用，短名会被同名 tag 抢先解析。
 *
 * 成功之后的步骤（切过去、写冻结 ref、落库）失败时，调用方用 {@link removeCreatedBranch} 收回。
 */
export async function createTrackingBranch(run: GitRun, name: string, start: string, remoteFullRef: string): Promise<void> {
  await run(["branch", "--no-track", "--end-of-options", name, start]);
  try {
    await run(["branch", `--set-upstream-to=${remoteFullRef}`, "--", name]);
  } catch (error) {
    await removeCreatedBranch(run, name, start);
    throw error;
  }
}

/**
 * 收回自己刚建的分支，连带它的 upstream 配置。两道闸，哪道不过就留着、返回 false：
 * - 有工作区正检出着它就不删。命令报错不等于没切过去（post-checkout 钩子在切换完成之后才跑，它失败时
 *   `switch` 报错、HEAD 却已经指过去了）；`update-ref -d` 又绕开了 `git branch -D` 对已检出分支的保护，
 *   删掉就是把那个工作区的 HEAD 变成「尚无提交」。
 * - 只在它还停在建出来那个提交上时删（比较并删除是 git 一步做的，删不掉说明有人动过）。
 */
export async function removeCreatedBranch(run: GitRun, name: string, start: string): Promise<boolean> {
  const ref = `refs/heads/${name}`;
  try {
    const worktrees = await run(["worktree", "list", "--porcelain"]);
    if (worktrees.split("\n").some((line) => line === `branch ${ref}`)) return false;
    await run(["update-ref", "-d", ref, start]);
  } catch {
    return false;
  }
  await run(["config", "--remove-section", `branch.${name}`]).catch(() => {});
  return true;
}
