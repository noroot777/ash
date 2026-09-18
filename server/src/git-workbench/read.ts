import type {
  GitHistoryCommit,
  GitRef,
  GitStash,
  GitWorkbenchState,
} from "@ash/shared/git-workbench";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getGitOverview } from "../git-overview.js";
import { worktreePorcelain } from "../git-worktree-state.js";
import {
  readScmFileDiff,
  readScmRemotes,
  readScmStatus,
  literalPathspec,
} from "../git-status.js";
import {
  assertInsideRoot,
  assertPathShape,
  gateScmPaths,
  scmNestedPaths,
} from "../scm-paths.js";
import { cappedGitStdout } from "../git-exec.js";
import { repoKey } from "../git.js";
import { lockedRepoKeys } from "../repo-lock.js";
import { git, digest, commitOid, fail, stateVersion } from "./core.js";
import { readJournal } from "./journal.js";
import { readRemoteDetails } from "./remotes.js";
import { readBackups } from "./maintenance.js";
import { readChangeStats, withChangeStats } from "./change-stats.js";

export const ownerPrefix = (actor: string) =>
  `[ash:${digest(actor).slice(0, 12)}]`;
export async function readRefs(root: string): Promise<GitRef[]> {
  const raw = await git(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(subject)%00%(upstream:short)%00%(worktreepath)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  return raw
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, subject, upstream, worktree] = line.split("\0");
      const kind = ref.startsWith("refs/heads/")
        ? "branch"
        : ref.startsWith("refs/tags/")
          ? "tag"
          : "remote";
      return {
        name: ref.replace(/^refs\/(heads|remotes|tags)\//, ""),
        sha,
        subject,
        upstream,
        worktree,
        kind,
      };
    });
}
export async function readStashes(
  root: string,
  actor: string,
): Promise<GitStash[]> {
  const raw = await git(root, [
    "stash",
    "list",
    "--format=%gd%x00%H%x00%gs%x00%cI",
  ]);
  return raw
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, subject, at] = line.split("\0");
      return {
        ref,
        sha,
        subject,
        at,
        owned: subject.includes(ownerPrefix(actor)),
      };
    });
}
export async function readWorkbench(
  repo: string,
  root: string,
  actor: string,
): Promise<GitWorkbenchState> {
  const status = await readScmStatus(root);
  const [
    refs,
    remotes,
    overview,
    stashes,
    journal,
    version,
    porcelain,
    backups,
    stagedStats,
    unstagedStats,
  ] = await Promise.all([
    readRefs(root),
    readScmRemotes(root),
    getGitOverview(repo),
    readStashes(root, actor),
    readJournal(repo),
    stateVersion(root, status),
    worktreePorcelain(args => git(repo, args)),
    readBackups(root),
    readChangeStats(root, true),
    readChangeStats(root, false),
  ]);
  const locked = new Set(
    porcelain
      .split("\0\0")
      .filter((record) => /\0locked(?:\0| |$)/.test(record))
      .map((record) => record.split("\0")[0].slice(9)),
  );
  return {
    remoteDetails: await readRemoteDetails(root),
    root,
    repo,
    status: {
      ...status,
      staged: withChangeStats(status.staged, stagedStats),
      unstaged: withChangeStats(status.unstaged, unstagedStats),
    },
    refs,
    remotes,
    version,
    stashes,
    journal,
    backups,
    worktrees: await Promise.all(
      overview.worktrees.map(async (w) => ({
        ...w,
        path: await realpath(w.path).catch(() => resolve(w.path)),
        taskId: null,
        taskTitle: null,
        managed: false,
        locked: locked.has(w.path),
      })),
    ),
    busy: lockedRepoKeys().includes(repoKey(repo)),
    readOnly: null,
  };
}
export async function readHistory(
  root: string,
  options: { ref?: string; path?: string; skip?: number } = {},
): Promise<{ commits: GitHistoryCommit[]; more: boolean }> {
  const args = [
    "log",
    "--topo-order",
    "-z",
    "--format=%H%x00%P%x00%s%x00%an%x00%cI%x00%D",
    "-n",
    "101",
    `--skip=${options.skip || 0}`,
  ];
  if (options.ref) args.push(await commitOid(root, options.ref));
  else args.push("--branches", "--remotes", "--tags", "HEAD");
  if (options.path)
    args.push(
      "--follow",
      "--",
      literalPathspec(assertPathShape([options.path])[0]),
    );
  let raw: string;
  try {
    raw = await git(root, args);
  } catch (error) {
    if (!(await readScmStatus(root)).branch.oid)
      return { commits: [], more: false };
    throw error;
  }
  const fields = raw.split("\0");
  const commits: GitHistoryCommit[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const [sha, parents, subject, author, at, refs] = fields.slice(i, i + 6);
    commits.push({
      sha,
      parents: parents.split(" ").filter(Boolean),
      subject,
      author,
      at,
      refs,
    });
  }
  return { commits: commits.slice(0, 100), more: commits.length > 100 };
}
export async function readDetail(
  root: string,
  query: {
    sha?: string;
    path?: string;
    source?: string;
    blame?: boolean;
    stash?: string;
  },
) {
  const path = query.path;
  if (path) assertPathShape([path]);
  if (query.blame && path) {
    const sha = await commitOid(root, query.sha || "HEAD");
    return cappedGitStdout(
      root,
      ["blame", "--date=short", sha, "--", path],
      1024 * 1024,
    ).then(({ text, truncated }) => ({ diff: text, truncated }));
  }
  if (query.stash) {
    if (!/^[a-f0-9]{40,64}$/.test(query.stash)) fail("贮藏引用不合法", 400);
    const found = (await readStashes(root, "")).some(
      (s) => s.sha === query.stash,
    );
    if (!found) fail("贮藏已不存在");
    return cappedGitStdout(
      root,
      [
        "stash",
        "show",
        "--include-untracked",
        "-p",
        "--no-ext-diff",
        "--no-textconv",
        query.stash,
      ],
      1024 * 1024,
    ).then(({ text, truncated }) => ({ diff: text, truncated }));
  }
  if (query.sha) {
    const sha = await commitOid(root, query.sha);
    return cappedGitStdout(
      root,
      [
        "show",
        "--format=fuller",
        "--stat",
        "--patch",
        "--no-ext-diff",
        "--no-textconv",
        sha,
        "--",
        ...(path ? [literalPathspec(path)] : []),
      ],
      1024 * 1024,
    ).then(({ text, truncated }) => ({ diff: text, truncated }));
  }
  if (
    !path ||
    !["staged", "unstaged", "untracked"].includes(query.source || "")
  )
    fail("缺少有效的文件和差异来源", 400);
  const status = await gateScmPaths(root, { paths: [path!] });
  if (scmNestedPaths(status).has(path!))
    fail("嵌套仓库请在它自己的 Git 工作台里查看");
  if (query.source === "untracked") await assertInsideRoot(root, path!);
  const source = query.source as "staged" | "unstaged" | "untracked";
  const item = status[source].find((f) => f.path === path);
  if (!item) fail("文件状态已变化，请重新选择");
  return readScmFileDiff(root, path!, source, item?.origPath);
}
