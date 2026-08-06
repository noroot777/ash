import type { ProjectView, Task } from "@harness/shared";
import {
  MagnifyingGlass,
  NotePencil,
  Plus,
  SidebarSimple,
  Stack,
} from "@phosphor-icons/react";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { TaskTree } from "./TaskTree.tsx";
import { SPREAD_FILTERS, spreadBucket, type SidebarSpread } from "./useSidebarSpread.ts";
import { workspaceModifierLabel } from "./useWorkspaceShortcuts.ts";
import { WorkspaceResizeHandle } from "./WorkspaceResizeHandle.tsx";

// 铺开时才出现的一排筛选。它占的是顶部图标那一行本来就空着的左半边 —— 不新起一行，
// 否则下面每一行都会跟着下移，「铺开前后逐像素不动」当场就破了。
function SpreadFilterBar({ spread, tasks, projectId }: { spread: SidebarSpread; tasks: Task[]; projectId: string | null }) {
  const scope = tasks.filter((task) => task.projectId === projectId && !task.archived && !task.parentId);
  return (
    <div className="workspace-spread-filters">
      {SPREAD_FILTERS.map((item) => {
        const count = item.key === "all" ? scope.length : scope.filter((task) => spreadBucket(task) === item.key).length;
        return (
          <button
            key={item.key}
            className={`workspace-spread-filter${spread.filter === item.key ? " is-on" : ""}${item.key === "todo" ? " is-todo" : ""}`}
            type="button"
            aria-pressed={spread.filter === item.key}
            onClick={() => spread.setFilter(item.key)}
          >
            <b>{item.label}</b>
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function WorkspaceSidebar({
  projects,
  currentProject,
  tasks,
  selectedTaskId,
  connected,
  collapsed,
  spread,
  width,
  onWidthChange,
  onProject,
  onTask,
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
  tasks: Task[];
  selectedTaskId: string | null;
  connected: boolean;
  collapsed: boolean;
  spread: SidebarSpread;
  width: number;
  onWidthChange: (width: number) => void;
  onProject: (projectId: string) => void;
  onTask: (task: Task) => void;
  onToggleCollapsed: () => void;
  onSearch: () => void;
  onNotes: () => void;
  onGroups: () => void;
  onCreate: () => void;
  onNewProject: () => void;
  onSettings: () => void;
}) {
  const modifier = workspaceModifierLabel();
  if (collapsed) {
    return (
      <aside className="workspace-sidebar workspace-sidebar--collapsed" aria-label="已收起的侧边栏">
        {currentProject && <ProjectAvatar project={currentProject} size="large" />}
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
        <ProjectSwitcher
          projects={projects}
          current={currentProject}
          onProject={onProject}
          onCreate={onNewProject}
          onSettings={onSettings}
        />
        <div className="workspace-sidebar-tools" role="toolbar" aria-label="任务工具">
          {spread.open && <SpreadFilterBar spread={spread} tasks={tasks} projectId={currentProject?.id ?? null} />}
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
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        spread={spread}
        onTask={onTask}
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
        <button type="button" onClick={onToggleCollapsed} aria-label="收起侧边栏">
          <SidebarSimple size={14} weight="bold" aria-hidden="true" />
          收起
        </button>
      </div>
      <WorkspaceResizeHandle width={width} onChange={onWidthChange} />
    </aside>
  );
}
