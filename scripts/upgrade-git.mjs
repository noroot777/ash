// 升级要问 git 的那几件事。都是只读的,除了 fastForward / resetKeep 两条:它们只在调用方确认过「工作区干净、
// 能快进」之后才动,而且 `--ff-only` / `--keep` 动不了就原样失败,不会把工作区弄成半截。
import { spawnSync } from "node:child_process";

/** 问 git 时别让它停下来要密码(没有终端可答,只会卡住);拉不动就如实失败。 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

export function git(repo, args, { timeout = 60_000 } = {}) {
  const res = spawnSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8", windowsHide: true, timeout, stdio: ["ignore", "pipe", "pipe"] });
  return {
    ok: res.status === 0,
    out: (res.stdout ?? "").trim(),
    err: (res.stderr ?? "").trim() || (res.error ? res.error.message : ""),
  };
}

export const short = (sha) => (sha ? sha.slice(0, 9) : "?");

/**
 * 这份检出能不能升:在不在 git 仓库、在不在一个跟着远端的分支上、有没有没提交的改动。
 * 返回 { problems:[…] } 或 { branch, remote, upstream, head }。
 */
export function inspectCheckout(repo) {
  const problems = [];
  if (!git(repo, ["rev-parse", "--is-inside-work-tree"]).ok) {
    return { problems: [`${repo} 不是 git 检出(压缩包解出来的?),升级命令靠 git pull 拿新代码 —— 换个新包解到旁边,照 docs/install.md 装`] };
  }
  const head = git(repo, ["rev-parse", "HEAD"]).out;
  const branch = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]).out;
  if (!branch) {
    problems.push(`现在不在分支上(detached HEAD @ ${short(head)}),不知道该升到哪儿。先 git checkout main(或你平时跟的那个分支)`);
    return { problems };
  }
  const upstream = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).out;
  const remote = git(repo, ["config", "--get", `branch.${branch}.remote`]).out;
  if (!upstream || !remote || remote === ".") {
    problems.push(`分支 ${branch} 没有跟着远端分支,不知道从哪儿拉。先 git branch --set-upstream-to=origin/main ${branch}(或你平时跟的那个)`);
  }
  // 只看跟踪着的文件:没跟踪的新文件不挡快进(真挡的那几个由 untrackedCollisions 单独查)。
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=no"]).out.split("\n").filter(Boolean);
  if (dirty.length) {
    problems.push(`工作区有没提交的改动(${dirty.length} 个文件),升级会跟它们打架:\n${dirty.slice(0, 8).map((l) => `       ${l}`).join("\n")}`
      + `${dirty.length > 8 ? "\n       …" : ""}\n     提交掉、git stash 收起来,或者 git checkout -- <文件> 放弃,再跑一次`);
  }
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (git(repo, ["rev-parse", "-q", "--verify", marker]).ok) problems.push(`有一次 git ${marker.split("_")[0].toLowerCase()} 没做完,先收拾掉再升级`);
  }
  return { problems, branch, remote, upstream, head };
}

export function fetchRemote(repo, remote) {
  return git(repo, ["fetch", "--quiet", remote], { timeout: 180_000 });
}

export const revParse = (repo, ref) => git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).out || null;
export const isAncestor = (repo, a, b) => git(repo, ["merge-base", "--is-ancestor", a, b]).ok;
export const countBetween = (repo, a, b) => Number(git(repo, ["rev-list", "--count", `${a}..${b}`]).out) || 0;

/** head 相对 target:same 一样 / behind 落后、能快进 / ahead 本地多出提交 / diverged 分叉了。 */
export function relation(repo, head, target) {
  if (head === target) return "same";
  if (isAncestor(repo, head, target)) return "behind";
  if (isAncestor(repo, target, head)) return "ahead";
  return "diverged";
}

/** 没跟踪、但新版本里有同名文件的那些 —— 快进会因为它们停下来。 */
export function untrackedCollisions(repo, head, target) {
  const untracked = new Set(git(repo, ["ls-files", "--others", "--exclude-standard"]).out.split("\n").filter(Boolean));
  if (!untracked.size) return [];
  return git(repo, ["diff", "--name-only", "--diff-filter=A", head, target]).out.split("\n").filter((f) => untracked.has(f));
}

export function showFile(repo, rev, path) {
  const r = git(repo, ["show", `${rev}:${path}`]);
  return r.ok ? r.out : null;
}

export const fastForward = (repo, target) => git(repo, ["merge", "--ff-only", "--quiet", target]);

/** 退回 sha(只在「这一次刚快进过来、工作区干净」时用):--keep 遇到会被覆盖的本地改动就拒绝,不硬来。 */
export const resetKeep = (repo, sha) => git(repo, ["reset", "--keep", sha]);

/**
 * 上一次 `git pull` 之前在哪个提交 —— 第一次升级时用户先手动 pull 了,升级前跑的是哪一版只有 reflog 记得。
 * HEAD 最近那条记录不是 pull 就不猜,返回 null。
 */
export function beforeLastPull(repo) {
  const subject = git(repo, ["reflog", "-n", "1", "--format=%gs", "HEAD"]).out;
  if (!/^pull\b/.test(subject)) return null;
  const prev = revParse(repo, "HEAD@{1}");
  const head = revParse(repo, "HEAD");
  return prev && prev !== head && isAncestor(repo, prev, head) ? prev : null;
}
