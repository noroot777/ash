export type GitView =
  | "changes"
  | "history"
  | "branches"
  | "stash"
  | "tags"
  | "worktrees"
  | "log";
export interface GitFile {
  path: string;
  additions?: number;
  deletions?: number;
  origPath: string | null;
  kind: string;
  conflict: string | null;
  nested: boolean;
}
export interface GitStatus {
  branch: {
    head: string | null;
    oid: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
  };
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
  merge: GitFile[];
  truncated: boolean;
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}
export interface GitRef {
  name: string;
  sha: string;
  subject: string;
  upstream: string;
  worktree: string;
  kind: "branch" | "remote" | "tag";
}
export interface GitHistoryCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  at: string;
  refs: string;
}
export interface GitStash {
  ref: string;
  sha: string;
  subject: string;
  at: string;
  owned: boolean;
}
export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  taskId: string | null;
  taskTitle: string | null;
  locked: boolean;
  managed: boolean;
}
export interface GitJournalEntry {
  id: string;
  at: string;
  actor: string;
  root: string;
  action: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "conflict"
    | "failed"
    | "interrupted";
  message: string;
  backup?: string;
  recovery?: "head" | "branch" | "tag";
  targetName?: string;
  command?: string;
  before?: string;
  after?: string;
  branch?: string | null;
}
export interface GitWorkbenchState {
  root: string;
  repo: string;
  status: GitStatus;
  version: string;
  refs: GitRef[];
  remotes: string[];
  remoteDetails: {
    name: string;
    urls: string[];
    pushUrls: string[];
    version: string;
  }[];
  worktrees: GitWorktree[];
  stashes: GitStash[];
  journal: GitJournalEntry[];
  backups: { ref: string; sha: string; subject: string }[];
  busy: boolean;
  readOnly: string | null;
}
export interface GitDiff {
  diff: string;
  truncated: boolean;
  binary?: boolean;
}
export interface GitConflict {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  content: string | null;
  binary: boolean;
  available: { base: boolean; ours: boolean; theirs: boolean };
  version: string;
}
export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";
export interface RebaseStep {
  sha: string;
  action: RebaseAction;
  message: string;
}
export type GitAction =
  | { kind: "backup-delete"; ref: string; sha: string }
  | { kind: "rebase-cleanup" }
  | { kind: "remote-add"; name: string; url: string }
  | { kind: "remote-url"; name: string; url: string; version: string }
  | { kind: "remote-remove"; name: string; version: string }
  | {
      kind: "remote-delete-ref";
      remote: string;
      name: string;
      refKind: "branch" | "tag";
      sha: string;
    }
  | { kind: "stage" | "unstage"; paths: string[] }
  | { kind: "discard"; paths: string[]; deleteUntracked: string[] }
  | { kind: "discard-patch"; path: string; diff: string; lines: number[] }
  | {
      kind: "patch";
      path: string;
      source: "staged" | "unstaged";
      diff: string;
      lines: number[];
    }
  | { kind: "commit"; message: string; amend: boolean }
  | { kind: "checkout"; name: string }
  | { kind: "branch-create"; name: string; target: string; checkout: boolean }
  | { kind: "branch-delete"; name: string; sha: string; force: boolean }
  | { kind: "branch-rename"; name: string; next: string; sha: string }
  | { kind: "upstream"; name: string; target: string }
  | { kind: "merge"; target: string; strategy: "ff" | "no-ff" | "squash" }
  | { kind: "cherry-pick" | "revert"; target: string; mainline?: number }
  | { kind: "reset"; target: string; mode: "soft" | "mixed" | "hard" }
  | { kind: "rebase"; target: string }
  | { kind: "rebase-plan"; target: string; steps: RebaseStep[] }
  | { kind: "continue" | "abort" | "skip" }
  | { kind: "discard-conflicts" }
  | {
      kind: "resolve";
      path: string;
      version: string;
      choice: "ours" | "theirs" | "content" | "delete";
      content?: string;
    }
  | { kind: "stash-save"; message: string; untracked: boolean }
  | { kind: "stash-apply" | "stash-pop" | "stash-drop"; sha: string }
  | { kind: "tag-create"; name: string; target: string; message: string }
  | { kind: "tag-delete"; name: string; sha: string }
  | { kind: "tag-push"; name: string; sha: string; remote: string }
  | { kind: "fetch"; remote: string }
  | { kind: "pull"; strategy: "ff-only" | "merge" | "rebase" }
  | { kind: "push"; remote: string; lease?: string }
  | { kind: "worktree-add"; name: string; target: string }
  | { kind: "worktree-remove"; path: string; sha: string }
  | { kind: "worktree-lock" | "worktree-unlock"; path: string }
  | { kind: "undo"; id: string };
export interface GitActionRequest {
  root: string;
  version: string;
  confirmation?: string;
  action: GitAction;
}
export interface GitActionResult {
  ok: true;
  message: string;
  entry: GitJournalEntry;
}

type GitProgressStatus = Pick<
  GitStatus,
  "operation" | "merge" | "staged" | "unstaged" | "truncated"
>;

export function emptyCommitGuidance(status: GitProgressStatus): string | null {
  if (
    (status.operation === "cherry-pick" || status.operation === "revert") &&
    !status.merge.length &&
    !status.staged.length &&
    !status.unstaged.length &&
    !status.truncated
  ) {
    const label = status.operation === "revert" ? "反做" : "拣选";
    return `当前${label}没有可提交的改动。请选择「跳过」处理后续提交，或「中止操作」恢复操作前状态。`;
  }
  return null;
}

export function gitActionBlockReason(
  status: GitProgressStatus,
  kind?: GitAction["kind"],
): string | null {
  if (kind === "continue") {
    const guidance = emptyCommitGuidance(status);
    if (guidance) return guidance;
  }
  if (kind === "discard-conflicts")
    return !status.operation && status.merge.length
      ? null
      : "仅在没有进行中的 Git 操作且仍有未解决冲突时，可放弃冲突改动";
  if (!status.operation && !status.merge.length) return null;
  switch (kind) {
    case "resolve":
    case "continue":
    case "abort":
    case "skip":
    case "stage":
    case "unstage":
      return null;
    default:
      return "仓库正在处理冲突或中途操作，请先解决、继续或中止";
  }
}

export function gitChangeCount(
  status: Pick<GitStatus, "staged" | "unstaged" | "untracked" | "merge">,
): number {
  return (
    status.staged.length +
    status.unstaged.length +
    status.untracked.length +
    status.merge.length
  );
}
