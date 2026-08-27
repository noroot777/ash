import { execFileText } from "./exec.js";
import { expandHome, gitError, isGitRepo } from "./git.js";
import { gitNetInjection, type GitNetInjection } from "./git-credentials.js";
import { readScmRemotes, readScmStatus, type ScmBranchInfo, type ScmStatus } from "./git-status.js";
import { ScmOperationError } from "./scm-paths.js";
import { withRepoLock } from "./repo-lock.js";

// ── 项目主仓的 git 操作：切分支 / fetch / pull / push ────────────────────────
//
// 这里跟 `git-workspace-ops.ts` 是**两个尺度**，故意分成两个文件：那边管的是「某个任务
// 自己的工作目录」，只做暂存/提交/推送；这边管的是**项目登记的那个仓库路径本身**，做的
// 是会改变历史和工作树的操作。那边第 36 行那条注释（「pull / fetch / 切分支会改变 agent
// 脚下的历史或工作树，仍不属于这个面板」）说的就是要分到这里来。
//
// 四条贯穿全文件的决定：
//
// ① **写操作一律走 withRepoLock。** 主仓的 `.git` 是所有任务 worktree 共用的那一份：
//    切分支写 HEAD、pull 写 refs 和工作树，跟验收合并撞在一起会互相拆台（原因在
//    `repo-lock.ts` 顶部）。排队等待，不是拒绝。
//
// ② **工作区不干净就不动手，绝不自动 stash。** stash 是「东西还在，但不在你看得见的
//    地方」——出问题时用户根本不知道去哪找。所以这三个写操作在锁内重读一次状态，脏就
//    带着原因拒绝，让用户自己决定先提交还是先丢弃。未跟踪文件不算脏：git 不会碰它们，
//    切分支后还在原地。
//
// ③ **失败绝不留半截状态。** pull 撞冲突会把仓库停在 merge/rebase 中途——而这是**项目
//    主仓**，下一个任务、下一次验收都踩在它上面。所以失败后一律探一次 `operation`，真进
//    了中途就 abort 回去，再把原始报错原样交给用户。这跟验收合并冲突后 `merge --abort`
//    是同一条规矩。
//
// ④ **分支名只从 for-each-ref 的输出里来。** 前端传上来的名字必须在这份清单里对上号才
//    动手，既挡住了 `--flag` 形状的参数，也顺带挡住了「切到一条刚被别人删掉的分支」。

const exec = execFileText;
const NET_TIMEOUT_MS = 120_000;

/**
 * 联网命令统一的执行参数：禁掉终端凭据提示，否则无人值守的服务端会永久挂住。
 *
 * `injection` 是这个项目自己的 HTTPS 凭证（`git-credentials.ts`）。没配就是两个空的，
 * 于是这里退回原样 —— 走 SSH 或者已经有系统级凭证的仓库不受任何影响。
 */
function netOptions(injection: GitNetInjection) {
  return {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...injection.env },
    timeout: NET_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  };
}

/** `-c` 只有排在子命令前面才算数，所以统一在这里拼，别在各个调用点手工插。 */
const netArgs = (root: string, injection: GitNetInjection, rest: string[]) =>
  ["-C", root, ...injection.args, ...rest];

export type PullStrategy = "ff-only" | "merge" | "rebase";

export interface ProjectGitBranchRow {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** upstream 配着、但远端那条已经没了（`[gone]`）。 */
  gone: boolean;
  /**
   * 这条分支正被哪个 worktree 检出着（主仓自己那份不算）。git 不允许同一条分支在两处
   * 同时检出，所以清单上要提前标出来说明「切不过去，因为任务 X 正在用」。
   */
  worktree: string | null;
}

export interface ProjectGitState {
  isRepo: boolean;
  /** 项目登记的仓库路径（已展开 `~`）。 */
  root: string;
  branch: ScmBranchInfo;
  /** 工作区脏不脏，按四类分开数——面板要说清「拦住你的是哪一类」。 */
  dirty: { staged: number; unstaged: number; untracked: number; merge: number };
  operation: ScmStatus["operation"];
  remotes: string[];
  branches: ProjectGitBranchRow[];
}

export interface ProjectGitResult {
  ok: true;
  message: string;
  state: ProjectGitState;
}

/** git 的报错常有三四行，压成一行进提示语。 */
function oneLine(text: string): string {
  const joined = text.split("\n").map((line) => line.trim()).filter(Boolean).join("；");
  return joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
}

/** `[ahead 1, behind 2]` / `[gone]` / 空 —— for-each-ref 的 track 字段只有这几种形状。 */
function parseTrack(track: string): { ahead: number | null; behind: number | null; gone: boolean } {
  if (/\[gone\]/.test(track)) return { ahead: null, behind: null, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : null,
    behind: behind ? Number(behind[1]) : null,
    gone: false,
  };
}

async function readBranchRows(root: string, current: string | null): Promise<ProjectGitBranchRow[]> {
  // `%(worktreepath)` 要 git ≥ 2.23；老版本给空串，清单照样列得出来，只是少了「被占用」
  // 那条提示，checkout 失败时由 git 自己的报错兜底。
  const format = "%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(worktreepath)";
  let stdout = "";
  try {
    ({ stdout } = await exec("git", ["-C", root, "for-each-ref", `--format=${format}`, "refs/heads"], {
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch {
    return [];
  }
  const selfPaths = new Set([root, await topLevel(root)].filter(Boolean) as string[]);
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [name, upstream, track, worktree] = line.split("\0");
    const { ahead, behind, gone } = parseTrack(track ?? "");
    return {
      name: name ?? "",
      current: name === current,
      upstream: upstream || null,
      ahead,
      behind,
      gone,
      worktree: worktree && !selfPaths.has(worktree) ? worktree : null,
    };
  }).filter((row) => row.name);
}

async function topLevel(root: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", root, "rev-parse", "--show-toplevel"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const EMPTY_BRANCH: ScmBranchInfo = {
  head: null, detached: false, oid: null, upstream: null, ahead: null, behind: null,
};

export async function readProjectGitState(repoPath: string | null | undefined): Promise<ProjectGitState> {
  const root = expandHome(repoPath ?? "");
  const empty: ProjectGitState = {
    isRepo: false, root, branch: EMPTY_BRANCH,
    dirty: { staged: 0, unstaged: 0, untracked: 0, merge: 0 },
    operation: null, remotes: [], branches: [],
  };
  if (!root || !(await isGitRepo(root))) return empty;
  const status = await readScmStatus(root);
  const [remotes, branches] = await Promise.all([
    readScmRemotes(root).catch(() => []),
    readBranchRows(root, status.branch.head),
  ]);
  return {
    isRepo: true,
    root,
    branch: status.branch,
    dirty: {
      staged: status.staged.length,
      unstaged: status.unstaged.length,
      untracked: status.untracked.length,
      merge: status.merge.length,
    },
    operation: status.operation,
    remotes,
    branches,
  };
}

/**
 * 仓库正卡在 merge / rebase / cherry-pick / revert 中途。**所有写型操作都要过这一道**，
 * 包括不碰工作树的推送：中途状态下的 HEAD 是半成品（冲突还没解、变基只走了一半），
 * 把它发布出去，远端就多了一份本地根本还没认可的历史。
 */
function operationBlocker(state: ProjectGitState, what: string): string | null {
  if (!state.operation) return null;
  return `仓库正处在 ${state.operation} 中途，先在终端把它收尾或 abort，再${what}。`;
}

/** 未跟踪文件不算脏：git 切分支不会碰它们。挡住的是已暂存 / 已修改 / 冲突中。 */
function dirtyBlocker(state: ProjectGitState, what: string): string | null {
  const mid = operationBlocker(state, what);
  if (mid) return mid;
  const { staged, unstaged, merge } = state.dirty;
  const total = staged + unstaged + merge;
  if (!total) return null;
  return `项目主仓有 ${total} 个未提交的改动（已暂存 ${staged} · 已修改 ${unstaged}${merge ? ` · 冲突 ${merge}` : ""}），`
    + `${what}会把它们带过去。请先提交或丢弃——这里不会替你 stash。`;
}

async function requireRepo(repoPath: string | null | undefined): Promise<ProjectGitState> {
  const state = await readProjectGitState(repoPath);
  if (!state.isRepo) throw new ScmOperationError("这个项目的路径不是 Git 仓库。", 400);
  return state;
}

export async function checkoutProjectBranch(repoPath: string, branch: string): Promise<ProjectGitResult> {
  return withRepoLock(repoPath, async () => {
    const state = await requireRepo(repoPath);
    const row = state.branches.find((item) => item.name === branch);
    if (!row) throw new ScmOperationError(`本地没有分支 ${branch}，请刷新后重试。`, 409);
    if (row.current) return { ok: true, message: `已经在 ${branch} 上了。`, state };
    if (row.worktree) {
      throw new ScmOperationError(
        `分支 ${branch} 正被另一个工作区检出着（${row.worktree}），git 不允许同一条分支在两处同时检出。`,
        409,
      );
    }
    const blocked = dirtyBlocker(state, "切换分支");
    if (blocked) throw new ScmOperationError(blocked, 409);
    try {
      await exec("git", ["-C", state.root, "checkout", row.name], { timeout: 60_000 });
    } catch (error) {
      throw new ScmOperationError(`切换分支失败：${oneLine(gitError(error))}`, 409);
    }
    return { ok: true, message: `已切换到 ${branch}。`, state: await readProjectGitState(repoPath) };
  });
}

export async function fetchProject(
  repoPath: string,
  remote: string | null,
  projectId: string | null = null,
): Promise<ProjectGitResult> {
  return withRepoLock(repoPath, async () => {
    const state = await requireRepo(repoPath);
    if (!state.remotes.length) throw new ScmOperationError("这个仓库没有配置 Git 远端。", 409);
    if (remote && !state.remotes.includes(remote)) {
      throw new ScmOperationError(`远端 ${remote} 不存在，请刷新后重试。`, 409);
    }
    const injection = await gitNetInjection(projectId);
    // `--prune` 顺手清掉远端已删的分支引用，否则清单上的 upstream 会一直显示 `[gone]`。
    const args = netArgs(state.root, injection, ["fetch", "--prune", ...(remote ? [remote] : ["--all"])]);
    try {
      await exec("git", args, netOptions(injection));
    } catch (error) {
      throw new ScmOperationError(`更新失败：${oneLine(gitError(error))}`, 409);
    }
    const next = await readProjectGitState(repoPath);
    const behind = next.branch.behind ?? 0;
    return {
      ok: true,
      message: behind > 0
        ? `已更新远端信息，${next.branch.head} 落后 ${behind} 个提交。`
        : "已更新远端信息。",
      state: next,
    };
  });
}

const PULL_ARGS: Record<PullStrategy, string[]> = {
  "ff-only": ["--ff-only"],
  merge: ["--no-rebase"],
  rebase: ["--rebase"],
};

const PULL_LABEL: Record<PullStrategy, string> = {
  "ff-only": "快进",
  merge: "合并",
  rebase: "变基",
};

/**
 * 拉取。三种策略都由调用方明说，不读 `pull.rebase` 配置——同一颗按钮在两台机器上做出
 * 两种不同的历史，是最不该有的惊喜。
 *
 * 失败后必须把仓库收干净：merge 冲突停在中途、rebase 冲突停在 detached HEAD 上，而这是
 * **项目主仓**——留着它，下一个建 worktree 的任务、下一次验收全都踩在半截状态上。
 */
export async function pullProject(
  repoPath: string,
  strategy: PullStrategy,
  projectId: string | null = null,
): Promise<ProjectGitResult> {
  return withRepoLock(repoPath, async () => {
    const state = await requireRepo(repoPath);
    if (state.branch.detached || !state.branch.head) {
      throw new ScmOperationError("当前是游离 HEAD，没有可拉取的分支。", 409);
    }
    if (!state.branch.upstream) {
      throw new ScmOperationError(`分支 ${state.branch.head} 还没有 upstream，先推送一次把它发布出去。`, 409);
    }
    const blocked = dirtyBlocker(state, "拉取");
    if (blocked) throw new ScmOperationError(blocked, 409);
    const before = state.branch.oid;
    const injection = await gitNetInjection(projectId);
    try {
      await exec("git", netArgs(state.root, injection, ["pull", ...PULL_ARGS[strategy]]), netOptions(injection));
    } catch (error) {
      const message = oneLine(gitError(error));
      const stuck = await readProjectGitState(repoPath);
      if (stuck.operation) {
        const abort = stuck.operation === "rebase" ? ["rebase", "--abort"] : ["merge", "--abort"];
        let rolled = true;
        try {
          await exec("git", ["-C", state.root, ...abort], { timeout: 60_000 });
        } catch {
          rolled = false;
        }
        throw new ScmOperationError(
          rolled
            ? `拉取（${PULL_LABEL[strategy]}）撞上冲突，已经回滚到拉取前的状态。请到终端手动处理：${message}`
            : `拉取（${PULL_LABEL[strategy]}）撞上冲突，而且回滚也没成功——仓库现在停在 ${stuck.operation} 中途，`
              + `必须到终端收尾：${message}`,
          409,
        );
      }
      throw new ScmOperationError(
        strategy === "ff-only" && /non-fast-forward|not possible to fast-forward|diverge/i.test(message)
          ? `本地和远端已经分叉，快进拉不动。换「合并」或「变基」再来一次：${message}`
          : `拉取失败：${message}`,
        409,
      );
    }
    const next = await readProjectGitState(repoPath);
    return {
      ok: true,
      message: next.branch.oid && next.branch.oid === before
        ? "已经是最新的了。"
        : `已拉取（${PULL_LABEL[strategy]}）${next.branch.upstream ?? ""} 到 ${next.branch.head}。`,
      state: next,
    };
  });
}

/**
 * 推送当前分支。目标写全为 `remote HEAD:refs/heads/<branch>`，不读 `push.default`，
 * 不 force，不偷偷先 pull —— 跟任务面板那颗 ↑ 是同一套规矩，只是作用在主仓上。
 *
 * 脏工作区**不拦**（推的是已提交的历史，未提交的改动本来就不参与），但 merge / rebase
 * 中途要拦：那时候的 HEAD 还不是用户认可的结果。
 */
export async function pushProject(
  repoPath: string,
  requestedRemote: string | null,
  projectId: string | null = null,
): Promise<ProjectGitResult> {
  return withRepoLock(repoPath, async () => {
    const state = await requireRepo(repoPath);
    const midway = operationBlocker(state, "推送");
    if (midway) throw new ScmOperationError(midway, 409);
    const branch = state.branch.head;
    if (!branch || state.branch.detached) {
      throw new ScmOperationError("当前是游离 HEAD 或还没有分支，没有可推送的东西。", 409);
    }
    let remote: string;
    let remoteBranch = branch;
    let published = false;
    if (state.branch.upstream) {
      try {
        const [{ stdout: remoteOut }, { stdout: mergeOut }] = await Promise.all([
          exec("git", ["-C", state.root, "config", "--get", `branch.${branch}.remote`]),
          exec("git", ["-C", state.root, "config", "--get", `branch.${branch}.merge`]),
        ]);
        remote = remoteOut.trim();
        const mergeRef = mergeOut.trim();
        if (!mergeRef.startsWith("refs/heads/")) throw new Error("unsupported upstream ref");
        remoteBranch = mergeRef.slice("refs/heads/".length);
      } catch {
        throw new ScmOperationError(`分支 ${branch} 显示有 upstream，但读不到它对应的远端。`, 409);
      }
      if (!remote || remote === ".") {
        throw new ScmOperationError(`分支 ${branch} 的 upstream 不是可推送的远端。`, 409);
      }
    } else {
      remote = requestedRemote?.trim() || "";
      if (!remote) throw new ScmOperationError("这个分支还没有 upstream；请选择远端后发布分支。", 409);
      published = true;
    }
    if (!state.remotes.includes(remote)) {
      throw new ScmOperationError(`远端 ${remote} 不存在，请刷新后重试。`, 409);
    }
    const injection = await gitNetInjection(projectId);
    const args = netArgs(state.root, injection, ["push"]);
    if (published) args.push("--set-upstream");
    args.push("--", remote, `HEAD:refs/heads/${remoteBranch}`);
    try {
      await exec("git", args, netOptions(injection));
    } catch (error) {
      throw new ScmOperationError(`推送失败：${oneLine(gitError(error))}`, 409);
    }
    const pushed = state.branch.ahead;
    return {
      ok: true,
      message: published
        ? `已发布 ${branch} 到 ${remote}。`
        : `已推送${pushed ? ` ${pushed} 个提交` : ""}到 ${remote}/${remoteBranch}。`,
      state: await readProjectGitState(repoPath),
    };
  });
}
