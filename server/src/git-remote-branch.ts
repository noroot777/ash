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
