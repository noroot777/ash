import { useEffect, useRef, useState } from "react";
import type { ProjectView, Task } from "@harness/shared";
import {
  MagnifyingGlass,
  NotePencil,
  Plus,
  SidebarSimple,
} from "@phosphor-icons/react";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { TaskTree } from "./TaskTree.tsx";
import { LegacyLink } from "../components/LegacyLink.tsx";

export const WORKSPACE_SIDEBAR_MIN_WIDTH = 220;
export const WORKSPACE_SIDEBAR_MAX_WIDTH = 480;
export const WORKSPACE_SIDEBAR_DEFAULT_WIDTH = 260;

export function WorkspaceSidebar({
  projects,
  currentProject,
  tasks,
  selectedTaskId,
  connected,
  collapsed,
  width,
  onWidthChange,
  onProject,
  onTask,
  onToggleCollapsed,
  onSearch,
  onNotes,
  onCreate,
  onSettings,
}: {
  projects: ProjectView[];
  currentProject: ProjectView | null;
  tasks: Task[];
  selectedTaskId: string | null;
  connected: boolean;
  collapsed: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onProject: (projectId: string) => void;
  onTask: (task: Task) => void;
  onToggleCollapsed: () => void;
  onSearch: () => void;
  onNotes: () => void;
  onCreate: () => void;
  onSettings: () => void;
}) {
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const previousBodyStyle = useRef<{ cursor: string; userSelect: string } | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const stopResizing = () => {
      if (!dragStart.current) return;
      dragStart.current = null;
      setResizing(false);
      document.body.style.cursor = previousBodyStyle.current?.cursor ?? "";
      document.body.style.userSelect = previousBodyStyle.current?.userSelect ?? "";
      previousBodyStyle.current = null;
    };
    const resize = (event: MouseEvent) => {
      if (!dragStart.current) return;
      const nextWidth = dragStart.current.width + event.clientX - dragStart.current.x;
      onWidthChange(Math.min(WORKSPACE_SIDEBAR_MAX_WIDTH, Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH, nextWidth)));
    };
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
      stopResizing();
    };
  }, [onWidthChange]);

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
    <aside className={`workspace-sidebar${resizing ? " workspace-sidebar--resizing" : ""}`} style={{ width, minWidth: width }} aria-label="项目和任务导航">
      <div className="workspace-sidebar-top">
        <ProjectSwitcher
          projects={projects}
          current={currentProject}
          onProject={onProject}
          onSettings={onSettings}
        />
        <button className="workspace-side-icon" type="button" title="搜索 ⌘K" aria-label="搜索 ⌘K" onClick={onSearch}>
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
      <div
        className="workspace-sidebar-resize-handle"
        role="separator"
        aria-label="调整侧边栏宽度，双击恢复默认宽度"
        aria-orientation="vertical"
        aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH}
        aria-valuemax={WORKSPACE_SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        onMouseDown={(event) => {
          event.preventDefault();
          dragStart.current = { x: event.clientX, width };
          previousBodyStyle.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          setResizing(true);
        }}
        onDoubleClick={() => onWidthChange(WORKSPACE_SIDEBAR_DEFAULT_WIDTH)}
      />
    </aside>
  );
}
