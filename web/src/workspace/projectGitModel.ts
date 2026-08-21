import type { ProjectGitBranchRow, ProjectGitState, PullStrategy } from "../lib/api.ts";

// 项目主仓 git 面板的措辞与判据。真正的门禁在服务端（`git-project-ops.ts`），这里只负责
// 「提前把拦不住的原因说清楚」，让按钮在点下去之前就是灰的，措辞跟服务端保持同一套。

export const PULL_OPTIONS: { strategy: PullStrategy; label: string; hint: string }[] = [
  { strategy: "ff-only", label: "快进拉取", hint: "只在能快进时拉，分叉了就停手（推荐）" },
  { strategy: "merge", label: "合并拉取", hint: "分叉时产生一个合并提交" },
  { strategy: "rebase", label: "变基拉取", hint: "把本地提交挪到远端之后，历史保持线性" },
];

export const PULL_LABEL: Record<PullStrategy, string> = {
  "ff-only": "快进拉取",
  merge: "合并拉取",
  rebase: "变基拉取",
};

export function branchLabel(state: ProjectGitState | null): string {
  if (!state?.isRepo) return "Git";
  if (state.branch.detached) return "游离 HEAD";
  return state.branch.head || "（无分支）";
}

export function dirtyCount(state: ProjectGitState | null): number {
  if (!state) return 0;
  return state.dirty.staged + state.dirty.unstaged + state.dirty.merge;
}

/** 工作区脏在哪一类，说给用户听。未跟踪单列——它不拦任何操作。 */
export function dirtyText(state: ProjectGitState | null): string | null {
  if (!state) return null;
  const parts: string[] = [];
  if (state.dirty.staged) parts.push(`已暂存 ${state.dirty.staged}`);
  if (state.dirty.unstaged) parts.push(`已修改 ${state.dirty.unstaged}`);
  if (state.dirty.merge) parts.push(`冲突 ${state.dirty.merge}`);
  if (state.dirty.untracked) parts.push(`未跟踪 ${state.dirty.untracked}`);
  return parts.length ? parts.join(" · ") : null;
}

/** 会改工作树的操作（切分支 / 拉取）此刻能不能做。能做返回 null。 */
export function worktreeBlocker(state: ProjectGitState | null, what: string): string | null {
  if (!state?.isRepo) return "这个项目的路径不是 Git 仓库";
  const mid = midwayBlocker(state, what);
  if (mid) return mid;
  if (dirtyCount(state) > 0) return `主仓有未提交的改动，${what}前请先提交或丢弃（这里不会替你 stash）`;
  return null;
}

/** 卡在 merge / rebase 中途——写型操作一律拦，推送也不例外（服务端同样 409）。 */
function midwayBlocker(state: ProjectGitState, what: string): string | null {
  return state.operation ? `仓库正停在 ${state.operation} 中途，先到终端收尾再${what}` : null;
}

export function pullBlocker(state: ProjectGitState | null): string | null {
  if (!state?.isRepo) return "这个项目的路径不是 Git 仓库";
  if (state.branch.detached || !state.branch.head) return "当前是游离 HEAD，没有可拉取的分支";
  if (!state.branch.upstream) return "这条分支还没有 upstream，先推送一次把它发布出去";
  return worktreeBlocker(state, "拉取");
}

// 推送不看工作区脏不脏（推的是已提交的历史），但看 merge / rebase 中途：那时候的 HEAD
// 是半成品，发布出去等于把用户还没认可的历史推给别人。
export function pushBlocker(state: ProjectGitState | null): string | null {
  if (!state?.isRepo) return "这个项目的路径不是 Git 仓库";
  if (state.branch.detached || !state.branch.head) return "当前是游离 HEAD，没有可推送的分支";
  if (!state.branch.upstream && !state.remotes.length) return "这个仓库没有配置 Git 远端，暂时不能发布分支";
  return midwayBlocker(state, "推送");
}

export function fetchBlocker(state: ProjectGitState | null): string | null {
  if (!state?.isRepo) return "这个项目的路径不是 Git 仓库";
  if (!state.remotes.length) return "这个仓库没有配置 Git 远端";
  return null;
}

/** 某一条分支切不过去的原因。当前分支返回 null（点它是无害的幂等操作）。 */
export function checkoutBlocker(row: ProjectGitBranchRow, state: ProjectGitState | null): string | null {
  if (row.current) return null;
  if (row.worktree) return `正被另一个工作区占着：${row.worktree}`;
  return worktreeBlocker(state, "切换分支");
}

export function pushLabelFor(state: ProjectGitState | null): string {
  if (!state) return "推送";
  if (!state.branch.upstream) {
    const remote = state.remotes.includes("origin") ? "origin" : state.remotes[0] ?? "";
    return remote ? `发布分支到 ${remote}` : "发布分支";
  }
  const ahead = state.branch.ahead ?? 0;
  return ahead > 0 ? `推送 ${ahead} 个提交到 ${state.branch.upstream}` : `推送到 ${state.branch.upstream}`;
}

/** 发布分支时用哪个远端：只有一个就直接用，多个交给调用点让用户挑。 */
export function defaultRemote(state: ProjectGitState | null): string | null {
  if (!state?.remotes.length) return null;
  return state.remotes.includes("origin") ? "origin" : state.remotes[0] ?? null;
}
