import type { Group, ProjectView, Task } from "@harness/shared";
import {
  MagnifyingGlass,
  NotePencil,
  Plus,
  SidebarSimple,
} from "@phosphor-icons/react";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { TaskTree } from "./TaskTree.tsx";
import { workspaceModifierLabel } from "./useWorkspaceShortcuts.ts";
import { LegacyLink } from "../components/LegacyLink.tsx";

export function WorkspaceSidebar({
  projects,
  currentProject,
  groups,
  tasks,
  selectedTaskId,
  connected,
  collapsed,
  onProject,
  onTask,
  onToggleCollapsed,
  onSearch,
  onNotes,
  onCreate,
  onNewProject,
  onSettings,
}: {
  projects: ProjectView[];
  currentProject: ProjectView | null;
  groups: Group[];
  tasks: Task[];
  selectedTaskId: string | null;
  connected: boolean;
  collapsed: boolean;
  onProject: (projectId: string) => void;
  onTask: (task: Task) => void;
  onToggleCollapsed: () => void;
  onSearch: () => void;
  onNotes: () => void;
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
        <LegacyLink projectId={currentProject?.id ?? null} taskId={selectedTaskId} compact />
        <button className="workspace-side-icon" type="button" onClick={onToggleCollapsed} aria-label="展开侧边栏">
          <SidebarSimple size={17} weight="bold" aria-hidden="true" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="workspace-sidebar" aria-label="项目和任务导航">
      <div className="workspace-sidebar-top">
        <ProjectSwitcher
          projects={projects}
          current={currentProject}
          onProject={onProject}
          onCreate={onNewProject}
          onSettings={onSettings}
        />
        <button className="workspace-side-icon" type="button" title={`搜索 ${modifier} K`} aria-label={`搜索 ${modifier} K`} onClick={onSearch}>
          <MagnifyingGlass size={15} aria-hidden="true" />
        </button>
        <button className="workspace-side-icon" type="button" title="随手记" aria-label="随手记" onClick={onNotes}>
          <NotePencil size={15} aria-hidden="true" />
        </button>
        <button className="workspace-side-icon" type="button" title="新建任务" aria-label="新建任务" onClick={onCreate}>
          <Plus size={16} weight="bold" aria-hidden="true" />
        </button>
      </div>

      <TaskTree
        projects={projects}
        currentProjectId={currentProject?.id ?? null}
        groups={groups}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        onTask={onTask}
      />

      <div className="workspace-sidebar-bottom">
        <span className={`workspace-connection${connected ? " is-connected" : ""}`}>
          <i aria-hidden="true" />
          {connected ? "实时已连接" : "实时连接中断"}
        </span>
        <LegacyLink projectId={currentProject?.id ?? null} taskId={selectedTaskId} />
        <button type="button" onClick={onToggleCollapsed} aria-label="收起侧边栏">
          <SidebarSimple size={14} weight="bold" aria-hidden="true" />
          收起
        </button>
      </div>
    </aside>
  );
}
