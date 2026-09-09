import { useEffect, useRef, useState } from "react";
import type { ProjectHealth, ProjectView } from "@ash/shared";
import { ArrowsClockwise, CaretDown, GitBranch } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ProjectGitPanel } from "./ProjectGitPanel.tsx";
import { gitOpLabel } from "./projectGitModel.ts";
import { markProjectGitPanelOpen } from "./projectGitRuns.ts";
import { useProjectGit } from "./useProjectGit.ts";

// 侧栏项目名右边的分支下拉。它以前是一段死文本（只带个原生 `title`），现在是**项目
// 级 git 操作的正门**：和项目切换器并排，点开就能切分支 / 更新 / 拉取 / 推送。
//
// 胶囊自己不拉 git 状态——分支名和「有未提交改动」那颗点都从 `ProjectHealth` 来，
// WorkspaceShell 已经在拉了。真正的状态（分支清单、ahead/behind、远端）只在浮层打开时
// 才拉一趟，见 `useProjectGit.ts`。
//
// **在途的 git 操作不跟浮层同生共死。** hook 提到这一层（浮层只是它的一块显示面），账本
// 更是在 React 树外面（`projectGitRuns.ts`）。这里管两件事：
// ① 操作跑着的时候点外面不收浮层——那几秒里的点击九成是手滑，收掉等于把过程从视野里抹了；
// ② 浮层真收起来了（Esc、切项目、点了胶囊自己），胶囊转圈顶上。
// 结果落定时那句话由 `useProjectGitAnnouncer` 在更外面说——它连切项目都能盖住。

export function ProjectGitContext({
  projectId,
  health,
  project = null,
  canManage,
  onOpenTerminal,
}: {
  projectId: string;
  health: ProjectHealth;
  // 左边那颗按钮读着「任务模式」时，这条分支属于谁就没人说了 —— 传项目进来，胶囊自己
  // 把归属补在分支前面。单项目态传 null：旁边就是项目名，再标一次是重复。
  project?: ProjectView | null;
  /** 项目管理员 / 实例管理员才动得了主仓，理由见 `projectGitModel.ts` 的 `roleBlocker`。 */
  canManage: boolean;
  onOpenTerminal: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const git = useProjectGit(projectId, open);
  const busyLabel = git.busy ? gitOpLabel(git.busy) : null;
  useDismissable({
    enabled: open,
    containerRef: root,
    onClose: () => setOpen(false),
    restoreFocusRef: trigger,
    // 操作跑着的这几秒不认「点外面」。Esc 和再点一次胶囊照旧收得掉——要的是别被误触收走，
    // 不是把人困在浮层里。
    closeOnOutside: !git.busy,
  });

  // 告诉播报口「此刻这个项目的浮层开着」：结果落在开着的浮层上就不必再弹 toast，那一格
  // 里已经写着了。
  useEffect(() => {
    if (!open) return;
    markProjectGitPanelOpen(projectId);
    return () => markProjectGitPanelOpen(null);
  }, [open, projectId]);

  if (!health.isRepo) return null;
  const branch = health.branch || "Git";
  const label = `${project ? `${project.name}：` : ""}${health.branch
    ? `Git：分支 ${health.branch}${health.isWorktree ? "（worktree）" : ""}${health.dirty ? " · 有未提交改动" : ""}`
    : "Git"}`;

  return (
    <span className="workspace-git-context-host" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`workspace-git-context${project ? " has-project" : ""}${busyLabel ? " is-busy" : ""}`}
        aria-label={busyLabel ? `${label}，正在${busyLabel}` : `${label}，点击切换分支或同步`}
        aria-busy={busyLabel ? true : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {project ? <ProjectAvatar project={project} size="small" /> : <GitBranch size={10} weight="bold" aria-hidden="true" />}
        <span>{branch}</span>
        {health.dirty && <i role="img" aria-label="有未提交改动" />}
        {health.isWorktree && <em>worktree</em>}
        {busyLabel
          ? <ArrowsClockwise size={9} weight="bold" className="is-spinning" aria-hidden="true" />
          : <CaretDown size={8} weight="bold" aria-hidden="true" />}
      </button>
      {open && (
        <ProjectGitPanel git={git} canManage={canManage} onOpenTerminal={onOpenTerminal} />
      )}
    </span>
  );
}
