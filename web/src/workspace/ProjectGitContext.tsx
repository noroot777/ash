import { useRef, useState } from "react";
import type { ProjectHealth } from "@ash/shared";
import { CaretDown, GitBranch } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { ProjectGitPanel } from "./ProjectGitPanel.tsx";

// 侧栏项目名右边的分支下拉。它以前是一段死文本（只带个原生 `title`），现在是**项目
// 级 git 操作的正门**：和项目切换器并排，点开就能切分支 / 更新 / 拉取 / 推送。
//
// 胶囊自己不拉 git 状态——分支名和「有未提交改动」那颗点都从 `ProjectHealth` 来，
// WorkspaceShell 已经在拉了。真正的状态（分支清单、ahead/behind、远端）只在浮层打开时
// 才拉一趟，见 `useProjectGit.ts`。

export function ProjectGitContext({
  projectId,
  health,
  onChanged,
  onOpenTerminal,
}: {
  projectId: string;
  health: ProjectHealth;
  onChanged: () => void;
  onOpenTerminal: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissable({
    enabled: open,
    containerRef: root,
    onClose: () => setOpen(false),
    restoreFocusRef: trigger,
  });

  if (!health.isRepo) return null;
  const branch = health.branch || "Git";
  const label = health.branch
    ? `Git：分支 ${health.branch}${health.isWorktree ? "（worktree）" : ""}${health.dirty ? " · 有未提交改动" : ""}`
    : "Git";

  return (
    <span className="workspace-git-context-host" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="workspace-git-context"
        aria-label={`${label}，点击切换分支或同步`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <GitBranch size={10} weight="bold" aria-hidden="true" />
        <span>{branch}</span>
        {health.dirty && <i role="img" aria-label="有未提交改动" />}
        {health.isWorktree && <em>worktree</em>}
        <CaretDown size={8} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <ProjectGitPanel projectId={projectId} onChanged={onChanged} onOpenTerminal={onOpenTerminal} />
      )}
    </span>
  );
}
