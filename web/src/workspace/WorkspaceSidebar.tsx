import type { HandoffPeerOffline, HandoffTarget, ProjectView, TaskListItem } from "@ash/shared";
import {
  ListChecks,
  MagnifyingGlass,
  NotePencil,
  Plus,
  SidebarSimple,
  Stack,
} from "@phosphor-icons/react";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ProjectGitContext } from "./ProjectGitContext.tsx";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { SpreadFilterControls } from "./SpreadFilterControls.tsx";
import { TaskTree } from "./TaskTree.tsx";
import { TASK_MODE_LABEL, type TaskScope } from "./taskScope.ts";
import { type SidebarSpread } from "./useSidebarSpread.ts";
import { workspaceModifierLabel } from "./useWorkspaceShortcuts.ts";
import { WorkspaceResizeHandle } from "./WorkspaceResizeHandle.tsx";


export function WorkspaceSidebar({
  projects,
  currentProject,
  scope,
  tasks,
  selectedTaskId,
  selectedRemoteTaskId,
  connected,
  collapsed,
  spread,
  width,
  onWidthChange,
  onProject,
  onTaskMode,
  onTask,
  onRemoteTask,
  onTaskStarred,
  onHandoffFinished,
  offlinePeers,
  onGitChanged,
  onOpenTerminal,
  notify,
  onToggleCollapsed,
  onSearch,
  onNotes,
  onGroups,
  onCreate,
  onNewProject,
  onSettings,
}: {
  projects: ProjectView[];
  currentProject: ProjectView | null;
  /** 任务列表看哪些行：当前项目一家，还是「任务模式」——所有项目里在跑和待验收的那些。 */
  scope: TaskScope;
  tasks: TaskListItem[];
  selectedTaskId: string | null;
  selectedRemoteTaskId: string | null;
  connected: boolean;
  collapsed: boolean;
  spread: SidebarSpread;
  width: number;
  onWidthChange: (width: number) => void;
  onProject: (projectId: string) => void;
  onTaskMode: () => void;
  onTask: (task: TaskListItem) => void;
  onRemoteTask: (task: TaskListItem, target: HandoffTarget) => void;
  onTaskStarred: (taskId: string, starredAt: number | null) => void;
  onHandoffFinished: () => Promise<void> | void;
  offlinePeers: HandoffPeerOffline[];
  /** 项目主仓的 git 状态被改过了（切分支/拉取/推送），让上层重拉一次 ProjectHealth。 */
  onGitChanged: () => void;
  onOpenTerminal: (() => void) | null;
  notify: (message: string) => void;
  onToggleCollapsed: () => void;
  onSearch: () => void;
  onNotes: () => void;
  onGroups: () => void;
  onCreate: () => void;
  onNewProject: () => void;
  onSettings: () => void;
}) {
  const modifier = workspaceModifierLabel();
  const taskMode = scope.kind === "tasks";
  if (collapsed) {
    return (
      <aside className="workspace-sidebar workspace-sidebar--collapsed" aria-label="已收起的侧边栏">
        {/* 收起后这颗方块是「列表在看谁」剩下的唯一说明。任务模式下摆项目头像会说反话 ——
            那时候列表根本不是这个项目的，所以换成和下拉里同一枚清单图标。 */}
        {taskMode
          ? <span className="workspace-project-avatar workspace-project-avatar--task-mode is-large" aria-label={TASK_MODE_LABEL}><ListChecks size={17} weight="bold" /></span>
          : currentProject && <ProjectAvatar project={currentProject} size="large" />}
        <span className={`workspace-connection-light${connected ? " is-connected" : ""}`} title={connected ? "实时已连接" : "实时连接中断"} />
        <button className="workspace-side-icon" type="button" onClick={onToggleCollapsed} aria-label="展开侧边栏">
          <SidebarSimple size={17} weight="bold" aria-hidden="true" />
        </button>
      </aside>
    );
  }

  return (
    <aside className={`workspace-sidebar${spread.laidOut ? " is-spread" : ""}${spread.open ? " is-spread-open" : ""}`} aria-label="项目和任务导航">
      <div className="workspace-sidebar-top">
        <div className="workspace-sidebar-selectors">
          <ProjectSwitcher
            projects={projects}
            current={currentProject}
            taskMode={taskMode}
            onProject={onProject}
            onTaskMode={onTaskMode}
            onCreate={onNewProject}
            onSettings={onSettings}
          />
          {currentProject && (
            <ProjectGitContext
              projectId={currentProject.id}
              health={currentProject.health}
              project={taskMode ? currentProject : null}
              canManage={currentProject.myRole === "admin"}
              onChanged={onGitChanged}
              onOpenTerminal={onOpenTerminal}
            />
          )}
        </div>
        <div className="workspace-sidebar-tools" role="toolbar" aria-label="任务工具">
          <SpreadFilterControls spread={spread} tasks={tasks} scope={scope} />
          <button className="workspace-side-icon" type="button" title={`搜索 ${modifier} K`} aria-label={`搜索 ${modifier} K`} onClick={onSearch}>
            <MagnifyingGlass size={15} aria-hidden="true" />
          </button>
          <button className="workspace-side-icon" type="button" title="随手记" aria-label="随手记" onClick={onNotes}>
            <NotePencil size={15} aria-hidden="true" />
          </button>
          <button className="workspace-side-icon" type="button" title="分组管理" aria-label="分组管理" onClick={onGroups}>
            <Stack size={15} aria-hidden="true" />
          </button>
          <button className="workspace-side-icon" type="button" title="新建任务" aria-label="新建任务" onClick={onCreate}>
            <Plus size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>

      <TaskTree
        projects={projects}
        currentProjectId={currentProject?.id ?? null}
        scope={scope}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        selectedRemoteTaskId={selectedRemoteTaskId}
        spread={spread}
        onTask={onTask}
        onRemoteTask={onRemoteTask}
        onTaskStarred={onTaskStarred}
        onHandoffFinished={onHandoffFinished}
        offlinePeers={offlinePeers}
        notify={notify}
      />

      <div className="workspace-sidebar-bottom">
        <span className={`workspace-connection${connected ? " is-connected" : ""}`}>
          <i aria-hidden="true" />
          {connected ? "实时已连接" : "实时连接中断"}
        </span>
        {spread.open && (
          <span className="workspace-spread-hint">
            <kbd>J</kbd><kbd>K</kbd> 选 · <kbd>Enter</kbd> 打开 · 指住右边两列看全文 · <kbd>F</kbd>/<kbd>Esc</kbd> 收起
          </span>
        )}
        {!spread.open && (
          <span className="workspace-spread-shortcut" aria-label="按 F 打开任务列表">
            <kbd>F</kbd>
            {width < 240 ? "打开" : "打开任务列表"}
          </span>
        )}
        <button type="button" onClick={onToggleCollapsed} aria-label="收起侧边栏">
          <SidebarSimple size={14} weight="bold" aria-hidden="true" />
          收起
        </button>
      </div>
      <WorkspaceResizeHandle width={width} onChange={onWidthChange} />
    </aside>
  );
}
