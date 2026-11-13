// 「入口不在被测的树里」那句话的后半句：它在**目标分支**上有没有。
//
// 快照那一侧问的是内核（accept-gate-entry.ts 的 entryOnDisk），这一侧问的是**目标提交的树**，不看
// 目标分支此刻的检出 —— 检出可能脏、可能不在磁盘上。两边必须回答同一个问题：「shell 照这个路径
// 去找，找得到吗」。所以逐级走树，任何一级碰上 git 树里不能直接解释的东西就说「读不出来」（null），
// 卡片据此写「这次没读出来」，绝不把「没找到直接条目」当成「没有」：
//  · 软链（120000）：`./launcher/x.sh` 里 launcher 是目录软链时，`git ls-tree <c> -- launcher/x.sh`
//    是空的，而 shell 照样跑得到（第 1 轮审查 F2 实测）。软链的目标得按检出语义另解，这里不解；
//  · `..`：要靠前面那一级的真实落点才解释得了，跟软链同一回事；
//  · 子模块（160000）：树里只有一个提交号，里面有什么这一层看不到；
//  · 大小写只差一点的同名条目：检出在不分大小写的文件系统上时 shell 也找得到它。
// 读的是 `git --literal-pathspecs ls-tree`：路径里的 `:!`、`*` 不许被当成 pathspec 魔法。
import { readOnlyGit } from "./accept-gate-preview.js";
import { entryCertainlyMissing, probeGateEntry, type GateEntryProbe } from "./accept-gate-entry.js";

type Plan = { command: string; repoPath: string; targetBranch: string | null; targetCommit: string | null };

/**
 * 起跑前那份入口事实。核得准、又不在快照里的时候，顺带核一眼它在目标分支上有没有，跟着这一行落盘。
 */
export async function probeGateEntryWithTarget(snapshotCwd: string, plan: Plan): Promise<GateEntryProbe | null> {
  const probe = probeGateEntry(snapshotCwd, plan.command);
  if (!probe || !entryCertainlyMissing(probe) || !plan.targetBranch || !plan.targetCommit) return probe;
  const has = await entryInCommit(plan.repoPath, plan.targetCommit, probe.file).catch(() => null);
  return { ...probe, target: { branch: plan.targetBranch, has } };
}

/** 这个相对路径在那次提交的树里找不找得到。true = 一个普通文件；false = 确定没有；null = 说不准。 */
export async function entryInCommit(repo: string, commit: string, file: string): Promise<boolean | null> {
  const parts = file.split("/").filter(part => part && part !== ".");
  if (!parts.length || parts.includes("..")) return null;
  for (let at = 0; at < parts.length; at++) {
    const path = parts.slice(0, at + 1).join("/");
    const entry = await treeEntry(repo, commit, path);
    if (!entry) {
      const siblings = await treeNames(repo, commit, parts.slice(0, at).join("/"));
      return siblings.some(name => name.toLowerCase() === parts[at]!.toLowerCase()) ? null : false;
    }
    if (entry.mode === "120000" || entry.mode === "160000") return null;
    // 中间那一级是个文件：内核报 ENOTDIR，跟「没有」同一回事。
    if (at < parts.length - 1) { if (entry.type !== "tree") return false; continue; }
    return entry.type === "blob" ? true : null;
  }
  return null;
}

async function treeEntry(repo: string, commit: string, path: string): Promise<{ mode: string; type: string } | null> {
  const { stdout } = await readOnlyGit(repo, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path]);
  const line = stdout.split("\0").find(row => row.split("\t")[1] === path);
  if (!line) return null;
  const [mode = "", type = ""] = line.split("\t")[0]!.split(" ");
  return { mode, type };
}

/** 那一级目录下的全部名字（大小写比对用）。根目录是空串。 */
async function treeNames(repo: string, commit: string, dir: string): Promise<string[]> {
  const { stdout } = await readOnlyGit(repo, ["ls-tree", "-z", "--name-only", dir ? `${commit}:${dir}` : commit]);
  return stdout.split("\0").filter(Boolean);
}
