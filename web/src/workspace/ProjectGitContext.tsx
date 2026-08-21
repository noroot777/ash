import type { ProjectHealth } from "@ash/shared";
import { GitBranch } from "@phosphor-icons/react";

export function ProjectGitContext({ health }: { health: ProjectHealth }) {
  if (!health.isRepo) return null;
  const branch = health.branch || "Git";
  const title = health.branch
    ? `分支 ${health.branch}${health.isWorktree ? "（worktree）" : ""}${health.dirty ? " · 有未提交改动" : ""}`
    : "正在读取 Git 分支";
  return (
    <span className="workspace-git-context" title={title}>
      <GitBranch size={10} weight="bold" aria-hidden="true" />
      <span>{branch}</span>
      {health.dirty && <i role="img" aria-label="有未提交改动" />}
      {health.isWorktree && <em>worktree</em>}
    </span>
  );
}
