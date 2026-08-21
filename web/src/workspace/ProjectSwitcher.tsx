import { useMemo, useRef, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { CaretDown, Check, FolderPlus, GearSix, MagnifyingGlass } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { shortenHomePath, useHostInfo } from "../lib/useHostInfo.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ProjectGitContext } from "./ProjectGitContext.tsx";

export function ProjectSwitcher({
  projects,
  current,
  onProject,
  onCreate,
  onSettings,
}: {
  projects: ProjectView[];
  current: ProjectView | null;
  onProject: (projectId: string) => void;
  onCreate: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const host = useHostInfo();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const results = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return projects;
    return projects.filter(
      (project) =>
        project.name.toLocaleLowerCase().includes(query) ||
        project.repoPath.toLocaleLowerCase().includes(query),
    );
  }, [projects, search]);

  useDismissable({
    enabled: open,
    containerRef: root,
    onClose: () => setOpen(false),
    restoreFocusRef: trigger,
  });

  return (
    <div className="workspace-project-switcher" ref={root}>
      <button
        ref={trigger}
        className="workspace-project-trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {current ? <ProjectAvatar project={current} /> : <span className="workspace-project-avatar" />}
        <span className="workspace-project-trigger-copy">
          <span className="workspace-project-trigger-name">{current?.name ?? "选择项目"}</span>
          {current && <ProjectGitContext health={current.health} />}
        </span>
        <CaretDown size={11} weight="bold" aria-hidden="true" />
      </button>

      {open && (
        <div className="workspace-project-menu" role="menu" aria-label="项目切换">
          {current && (
            <div className="workspace-project-current">
              <ProjectAvatar project={current} size="large" />
              <span>
                <b>{current.name}</b>
                <small>{shortenHomePath(current.repoPath, host) || "未设置工作目录"}</small>
              </span>
            </div>
          )}

          <button
            className="workspace-project-settings"
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <GearSix size={15} aria-hidden="true" />
            <span>
              设置
              <small>智能体 · 项目 · 分组 · 归档</small>
            </span>
          </button>

          <label className="workspace-project-search">
            <MagnifyingGlass size={14} aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索项目…"
              aria-label="搜索项目"
              autoFocus
            />
          </label>

          <div className="workspace-project-menu-label">切换到</div>
          <div className="workspace-project-results">
            {results.map((project) => {
              const selected = project.id === current?.id;
              return (
                <button
                  key={project.id}
                  className={`workspace-project-option ui-selectable${selected ? " is-selected" : ""}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    setSearch("");
                    setOpen(false);
                    onProject(project.id);
                  }}
                >
                  <ProjectAvatar project={project} />
                  <span>
                    <b>{project.name}</b>
                    <small>{shortenHomePath(project.repoPath, host)}</small>
                  </span>
                  {selected && <Check size={13} weight="bold" aria-hidden="true" />}
                </button>
              );
            })}
            {!results.length && <p className="workspace-project-empty">没有匹配的项目</p>}
          </div>
          <button
            className="workspace-project-create"
            type="button"
            role="menuitem"
            onClick={() => {
              setSearch("");
              setOpen(false);
              onCreate();
            }}
          >
            <FolderPlus size={15} aria-hidden="true" />
            <span>新建项目</span>
          </button>
        </div>
      )}
    </div>
  );
}
