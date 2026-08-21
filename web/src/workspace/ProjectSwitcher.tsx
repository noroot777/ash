import { useMemo, useRef, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { CaretDown, Check, FolderPlus, GearSix, MagnifyingGlass, SquaresFour } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { shortenHomePath, useHostInfo } from "../lib/useHostInfo.ts";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ALL_PROJECTS_LABEL } from "./taskScope.ts";

// 「全部项目」和某个具体项目是同一个下拉里的**同一排选项**，不是另开一个模式开关：
// 侧栏顶上那颗按钮回答的始终是「这份列表在看谁」，多一档「谁都看」正好落在这句话里。
export function ProjectSwitcher({
  projects,
  current,
  allProjects,
  onProject,
  onAllProjects,
  onCreate,
  onSettings,
}: {
  projects: ProjectView[];
  current: ProjectView | null;
  allProjects: boolean;
  onProject: (projectId: string) => void;
  onAllProjects: () => void;
  onCreate: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const host = useHostInfo();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const results = useMemo(() => {
    if (!query) return projects;
    return projects.filter(
      (project) =>
        project.name.toLocaleLowerCase().includes(query) ||
        project.repoPath.toLocaleLowerCase().includes(query),
    );
  }, [projects, query]);
  // 搜索框里打字时「全部项目」也得跟着被筛掉，否则它会挂在一堆无关结果上方；
  // 但它本身可搜（打 all 或「全部」都能找到），别让人以为只能靠鼠标够。
  const allMatches = !query || ALL_PROJECTS_LABEL.includes(query) || "all".startsWith(query);

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
        {allProjects
          ? <span className="workspace-project-avatar workspace-project-avatar--all" aria-hidden="true"><SquaresFour size={13} weight="fill" /></span>
          : current ? <ProjectAvatar project={current} /> : <span className="workspace-project-avatar" />}
        <span className="workspace-project-trigger-name">{allProjects ? ALL_PROJECTS_LABEL : current?.name ?? "选择项目"}</span>
        <CaretDown size={11} weight="bold" aria-hidden="true" />
      </button>

      {open && (
        <div className="workspace-project-menu" role="menu" aria-label="项目切换">
          {allProjects ? (
            <div className="workspace-project-current">
              <span className="workspace-project-avatar workspace-project-avatar--all is-large" aria-hidden="true"><SquaresFour size={17} weight="fill" /></span>
              <span>
                <b>{ALL_PROJECTS_LABEL}</b>
                <small>{current ? `新建任务落在 ${current.name}` : "所有项目的任务混在一起"}</small>
              </span>
            </div>
          ) : current && (
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
            {allMatches && (
              <button
                className={`workspace-project-option ui-selectable${allProjects ? " is-selected" : ""}`}
                type="button"
                role="menuitemradio"
                aria-checked={allProjects}
                onClick={() => {
                  setSearch("");
                  setOpen(false);
                  onAllProjects();
                }}
              >
                <span className="workspace-project-avatar workspace-project-avatar--all" aria-hidden="true"><SquaresFour size={13} weight="fill" /></span>
                <span>
                  <b>{ALL_PROJECTS_LABEL}</b>
                  <small>把所有项目的任务混着看</small>
                </span>
                {allProjects && <Check size={13} weight="bold" aria-hidden="true" />}
              </button>
            )}
            {results.map((project) => {
              const selected = !allProjects && project.id === current?.id;
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
            {!results.length && !allMatches && <p className="workspace-project-empty">没有匹配的项目</p>}
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
