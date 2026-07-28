import { useMemo, useState } from "react";
import type { ProjectView } from "@harness/shared";
import { CaretDown, GearSix, ListChecks, MagnifyingGlass, Plus, Robot, SidebarSimple } from "@phosphor-icons/react";
import { Menu } from "./Menu";
import { HealthDot, ProjectAvatar } from "./ui";
import { shortPath } from "./util";

export function ProjectRail({
  projects,
  projectId,
  railCollapsed,
  taskCount,
  connected,
  onProject,
  onSettings,
  onNewProject,
  onAgents,
  onPalette,
  onToggleCollapsed,
}: {
  projects: ProjectView[];
  projectId: string | null;
  railCollapsed: boolean;
  taskCount: number;
  connected: boolean;
  onProject: (id: string) => void;
  onSettings: () => void;
  onNewProject: () => void;
  onAgents: () => void;
  onPalette: () => void;
  onToggleCollapsed: () => void;
}) {
  const [search, setSearch] = useState("");
  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectName = project?.name ?? "项目";
  const otherProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter(
      (p) => p.id !== projectId && (!q || p.name.toLowerCase().includes(q) || p.repoPath.toLowerCase().includes(q)),
    );
  }, [projects, projectId, search]);

  return (
    <aside className={`flex shrink-0 flex-col border-r border-line bg-panel p-2 ${railCollapsed ? "w-[52px]" : "w-[228px]"}`}>
      <Menu
        value={projectId ?? ""}
        onChange={(v) => { setSearch(""); onProject(v); }}
        menuWidth={300}
        maxHeight={520}
        options={otherProjects.map((p) => ({
          value: p.id,
          label: p.name,
          detail: shortPath(p.repoPath),
          icon: (
            <span className="relative">
              <ProjectAvatar name={p.name} size={22} />
              {!p.health.isRepo && (
                <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-panel">
                  <HealthDot health={p.health} size={7} />
                </span>
              )}
            </span>
          ),
        }))}
        header={({ close }) => (
          <div className="flex flex-col gap-1.5">
            {project && (
              <div className="flex items-center gap-2 rounded-md px-1 py-0.5">
                <ProjectAvatar name={project.name} size={30} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-semibold text-ink">{project.name}</span>
                  <span className="truncate text-[11px] text-faint">{shortPath(project.repoPath) || "未设置工作目录"}</span>
                </span>
                <button
                  onClick={() => { close(); onSettings(); }}
                  title="项目设置"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
                >
                  <GearSix size={15} />
                </button>
              </div>
            )}
            {projects.length > 6 && (
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索项目…"
                className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
              />
            )}
            {otherProjects.length > 0 && (
              <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-faint">切换到</div>
            )}
          </div>
        )}
        footer={({ close }) => (
          <button
            onClick={() => { close(); onNewProject(); }}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] text-muted hover:bg-raised hover:text-ink"
          >
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md border border-dashed border-line2">
              <Plus size={13} />
            </span>
            新建项目
          </button>
        )}
        triggerClassName={
          railCollapsed
            ? "flex items-center justify-center rounded-md p-1 hover:bg-raised"
            : "flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-raised"
        }
      >
        <ProjectAvatar name={projectName} size={24} />
        {!railCollapsed && (
          <>
            <span className="max-w-[150px] truncate text-[13px] font-semibold text-ink">{projectName}</span>
            {project && !project.health.isRepo && <HealthDot health={project.health} />}
            <CaretDown size={12} className="ml-auto text-faint" />
          </>
        )}
      </Menu>

      <nav className="mt-1.5 flex flex-col gap-px">
        {!railCollapsed && (
          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.07em] text-faint">执行</div>
        )}
        <div
          title={railCollapsed ? `任务 (${taskCount})` : undefined}
          className={`flex items-center rounded-md bg-raised text-[13px] font-medium text-ink ${railCollapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-1.5"}`}
        >
          <ListChecks size={16} className="text-accent" />
          {!railCollapsed && (
            <>
              任务
              <span className="ml-auto rounded-full bg-overlay px-1.5 text-[11px] text-faint">{taskCount}</span>
            </>
          )}
        </div>
      </nav>

      <div className="flex-1" />

      <div className="flex flex-col gap-px border-t border-line pt-1.5">
        <button
          onClick={onAgents}
          title={railCollapsed ? "智能体" : undefined}
          className={`flex items-center rounded-md text-[13px] text-muted hover:bg-raised hover:text-ink ${railCollapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-1.5"}`}
        >
          <Robot size={14} />
          {!railCollapsed && "智能体"}
        </button>
        <button
          onClick={onPalette}
          title={railCollapsed ? "搜索 (⌘K)" : undefined}
          className={`flex items-center rounded-md text-[13px] text-muted hover:bg-raised hover:text-ink ${railCollapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-1.5"}`}
        >
          <MagnifyingGlass size={14} />
          {!railCollapsed && (
            <>
              搜索 <kbd className="ml-auto">⌘K</kbd>
            </>
          )}
        </button>
        <div
          className={`flex items-center text-[12px] text-faint ${railCollapsed ? "justify-center p-1.5" : "gap-2 px-2 py-1.5"}`}
          title={railCollapsed ? (connected ? "实时已连接" : "未连接") : undefined}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-faint"}`} />
          {!railCollapsed && (connected ? "实时已连接" : "未连接")}
        </div>
        <button
          onClick={onToggleCollapsed}
          title={railCollapsed ? "展开侧栏" : "收起侧栏"}
          className={`flex items-center rounded-md text-[12px] text-faint hover:bg-raised hover:text-muted ${railCollapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-1.5"}`}
        >
          <SidebarSimple size={14} className={railCollapsed ? "" : "rotate-180"} />
          {!railCollapsed && "收起侧栏"}
        </button>
      </div>
    </aside>
  );
}
