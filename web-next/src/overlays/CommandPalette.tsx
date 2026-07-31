import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { Group, ProjectView, SearchHit, Task } from "@harness/shared";
import { canArchive, canSingleRun, TASK_STATUS_LABELS } from "@harness/shared";
import {
  Archive,
  ArrowCounterClockwise,
  FolderPlus,
  FolderSimple,
  GearSix,
  ListNumbers,
  MagnifyingGlass,
  NotePencil,
  Play,
  Plus,
  Scales,
  Stack,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import { api, type GitOverview } from "../lib/api.ts";
import { TaskModeIcon, taskModeLabel, taskParentLink, taskParentMode } from "../components/TaskOrigin.tsx";
import { GitOverviewPanel, GitProjectStep } from "./CommandPaletteGit.tsx";
import { SearchHitList, SearchPreview } from "./CommandPaletteSearch.tsx";
import {
  ScopeProjectStep,
  ScopeToken,
  ScopeTypeStep,
  SCOPE_TYPE_OPTIONS,
  type SearchScope,
  type SearchScopeType,
} from "./CommandPaletteScope.tsx";
import { filterSlashCommands, type SlashCommand, type SlashCommandId } from "./commandPaletteCommands.ts";

type PaletteStep = "search" | "scope-project" | "scope-type" | "git-project" | "git-overview";

type PaletteItem = {
  key: string;
  group: string;
  label: string;
  detail?: string;
  keys?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
};

type CommandPaletteProps = {
  open: boolean;
  projects: ProjectView[];
  currentProject: ProjectView | null;
  tasks: Task[];
  selectedTask: Task | null;
  groups: Group[];
  onClose: () => void;
  onProject: (projectId: string) => void;
  onTask: (task: Task) => void;
  onTaskUpdated: (task: Task) => void;
  onNote: (projectId: string, noteId: string | null) => void;
  onComposer: (mode?: "single" | "team" | "debate") => void;
  onNewGroup: () => void;
  onNewProject: () => void;
  onDeleteTask: (task: Task) => void;
  onSettings: (section?: "agents" | "project" | "groups" | "archive") => void;
  notify: (message: string) => void;
};

function projectName(projects: ProjectView[], projectId: string) {
  return projects.find((project) => project.id === projectId)?.name ?? "未知项目";
}

export function CommandPalette({
  open,
  projects,
  currentProject,
  tasks,
  selectedTask,
  groups,
  onClose,
  onProject,
  onTask,
  onTaskUpdated,
  onNote,
  onComposer,
  onNewGroup,
  onNewProject,
  onDeleteTask,
  onSettings,
  notify,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<PaletteStep>("search");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState<SearchScope | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [gitProjectId, setGitProjectId] = useState<string | null>(null);
  const [gitOverview, setGitOverview] = useState<GitOverview | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const mouse = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setStep("search");
    setActive(0);
    setHits([]);
    setScope(null);
    setGitOverview(null);
    setGitError(null);
    mouse.current = null;
    window.setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [open, onClose]);

  const slashMode = step === "search" && query.startsWith("/");
  const slashCommands = useMemo(() => slashMode ? filterSlashCommands(query) : [], [query, slashMode]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  useEffect(() => {
    const q = query.trim();
    if (!open || step !== "search" || slashMode || q.length < 2) {
      searchSeq.current += 1;
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(() => {
      api.search(q, { projectId: scope?.projectId ?? undefined, type: scope?.type ?? undefined })
        .then((rows) => {
          if (seq === searchSeq.current) setHits(rows);
        })
        .catch(() => {
          if (seq === searchSeq.current) setHits([]);
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, query, scope, slashMode, step]);

  const items = useMemo(() => {
    if (slashMode || step !== "search") return [];
    const result: PaletteItem[] = [];
    const closeRun = (run: () => void | Promise<void>) => () => {
      onClose();
      Promise.resolve(run()).catch((error) => notify(error instanceof Error ? error.message : "命令执行失败"));
    };
    if (!query.trim()) {
      tasks
        .filter((task) => task.status === "running" || task.status === "queued" || !!task.question)
        .slice(0, 6)
        .forEach((task) => result.push({
          key: `running:${task.id}`,
          group: "进行中",
          label: task.title,
          detail: `${projectName(projects, task.projectId)} · ${task.question ? "等答复" : TASK_STATUS_LABELS[task.status]}`,
          icon: <span className={`palette-status is-${task.question ? "paused" : task.status}`} />,
          run: closeRun(() => onTask(task)),
        }));
    }
    if (selectedTask) {
      const taskGroup = `当前任务 · ${selectedTask.title}`;
      const dispatchedWorker = selectedTask.parentId !== null;
      const parent = taskParentLink(selectedTask, tasks);
      if (parent?.task) {
        result.push({
          key: "task:parent",
          group: taskGroup,
          label: `${parent.kind === "team" ? "打开所属团队" : `打开来源${taskModeLabel(taskParentMode(parent))}`} · ${parent.task.title}`,
          icon: <TaskModeIcon mode={taskParentMode(parent)} />,
          run: closeRun(() => onTask(parent.task!)),
        });
      }
      if (!selectedTask.archived && canSingleRun(selectedTask.status)) {
        const retry = selectedTask.status === "failed";
        const label = retry ? "重试任务" : selectedTask.status === "paused" ? "继续任务" : "运行任务";
        result.push({
          key: "task:run",
          group: taskGroup,
          label,
          detail: "R",
          icon: <Play size={14} weight="fill" />,
          run: closeRun(async () => {
            if (retry) await api.retryTask(selectedTask.id);
            else await api.runTask(selectedTask.id);
            onTaskUpdated(await api.task(selectedTask.id));
            notify(retry ? "任务已重试" : selectedTask.status === "paused" ? "任务已继续" : "任务已启动");
          }),
        });
      }
      if (
        !dispatchedWorker
        && !selectedTask.archived
        && !!selectedTask.queueId
        && (selectedTask.status === "failed" || selectedTask.status === "canceled")
      ) {
        result.push({
          key: "task:requeue",
          group: taskGroup,
          label: "重新排队",
          detail: "回到队列等待",
          icon: <ListNumbers size={14} />,
          run: closeRun(async () => {
            const response = await api.requeueTask(selectedTask.id);
            onTaskUpdated(response.task);
            notify(response.movedToEnd ? "已重新排队并移到队尾" : "已重新排队");
          }),
        });
      }
      if (!selectedTask.archived && selectedTask.status === "running") {
        result.push({
          key: "task:stop",
          group: taskGroup,
          label: selectedTask.mode === "team" ? "停止全组" : "停止运行",
          icon: <Stop size={14} weight="fill" />,
          run: closeRun(async () => {
            if (selectedTask.mode === "team") await api.teamHalt(selectedTask.id);
            else await api.stopTask(selectedTask.id);
            onTaskUpdated(await api.task(selectedTask.id));
            notify(selectedTask.mode === "team" ? "已停止全组" : "任务已停止");
          }),
        });
      }
      if (!dispatchedWorker) {
        if (selectedTask.archived) {
          result.push({ key: "task:unarchive", group: taskGroup, label: "取消归档", icon: <ArrowCounterClockwise size={14} />, run: closeRun(async () => { onTaskUpdated(await api.unarchiveTask(selectedTask.id)); notify("任务已取回"); }) });
        } else if (canArchive(selectedTask.status)) {
          result.push({ key: "task:archive", group: taskGroup, label: "归档任务", icon: <Archive size={14} />, run: closeRun(async () => { onTaskUpdated(await api.archiveTask(selectedTask.id)); notify("任务已归档"); }) });
        }
        result.push({ key: "task:delete", group: taskGroup, label: "删除任务", icon: <Trash size={14} />, run: closeRun(() => onDeleteTask(selectedTask)) });
      }
    }
    result.push(
      { key: "new:task", group: "新建", label: "新建任务", keys: "C", icon: <Plus size={15} />, run: closeRun(() => onComposer("single")) },
      { key: "new:debate", group: "新建", label: "新建辩论 · 给你答案", icon: <Scales size={15} />, run: closeRun(() => onComposer("debate")) },
      { key: "new:note", group: "新建", label: "新建随手记", keys: "NI", icon: <NotePencil size={15} />, run: closeRun(() => { if (currentProject) onNote(currentProject.id, "__new__"); }) },
      { key: "new:group", group: "新建", label: "新建分组", icon: <Stack size={15} />, run: closeRun(onNewGroup) },
      { key: "new:project", group: "新建", label: "新建项目", icon: <FolderPlus size={15} />, run: closeRun(onNewProject) },
      { key: "manage:notes", group: "管理", label: "随手记列表", keys: "NL", icon: <NotePencil size={15} />, run: closeRun(() => { if (currentProject) onNote(currentProject.id, null); }) },
      { key: "manage:agents", group: "管理", label: "管理智能体执行器", icon: <GearSix size={15} />, run: closeRun(() => onSettings("agents")) },
      { key: "manage:settings", group: "管理", label: "项目设置", icon: <GearSix size={15} />, run: closeRun(() => onSettings("project")) },
      { key: "manage:groups", group: "管理", label: "分组管理", icon: <Stack size={15} />, run: closeRun(() => onSettings("groups")) },
    );
    projects.forEach((project) => result.push({
      key: `project:${project.id}`,
      group: "切换项目",
      label: project.name,
      detail: project.repoPath,
      icon: <FolderSimple size={15} />,
      run: closeRun(() => onProject(project.id)),
    }));
    groups.filter((group) => !group.ownerTaskId).forEach((group) => result.push({
      key: `group:${group.id}`,
      group: "运行分组",
      label: group.name,
      detail: `${group.mode === "parallel" ? "并行" : "串行"} · ${tasks.filter((task) => task.groupId === group.id).length} 个任务`,
      icon: <Play size={14} weight="fill" />,
      run: closeRun(async () => { await api.runGroup(group.id); notify(group.paused ? "分组已继续" : "分组已启动"); }),
    }));
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? result.filter((item) => `${item.label} ${item.detail ?? ""} ${item.group} ${item.keys ?? ""}`.toLocaleLowerCase().includes(needle))
      : result;
  }, [currentProject, groups, notify, onClose, onComposer, onDeleteTask, onNewGroup, onNewProject, onNote, onProject, onSettings, onTask, onTaskUpdated, projects, query, selectedTask, slashMode, step, tasks]);

  const normalTotal = items.length + hits.length;
  const total = step === "scope-project" ? projects.length + 1
    : step === "scope-type" ? SCOPE_TYPE_OPTIONS.length
      : step === "git-project" ? projects.length
        : step === "git-overview" ? 0
          : slashMode ? slashCommands.length
            : normalTotal;

  useEffect(() => {
    if (active >= total) setActive(0);
  }, [active, total]);

  if (!open) return null;

  const resetActive = () => {
    setActive(0);
    mouse.current = null;
  };
  const focusInput = () => window.setTimeout(() => input.current?.focus(), 0);
  const enterScope = () => {
    setPendingProjectId(scope?.projectId ?? null);
    setStep("scope-project");
    setQuery("");
    resetActive();
    focusInput();
  };
  const chooseScopeProject = (projectId: string | null) => {
    setPendingProjectId(projectId);
    setStep("scope-type");
    resetActive();
  };
  const chooseScopeType = (type: SearchScopeType) => {
    setScope({ projectId: pendingProjectId, type });
    setStep("search");
    setQuery("");
    resetActive();
    focusInput();
  };
  const loadGitOverview = (projectId: string) => {
    setGitProjectId(projectId);
    setStep("git-overview");
    setQuery("");
    setGitOverview(null);
    setGitError(null);
    setGitLoading(true);
    resetActive();
    void api.projectGitOverview(projectId)
      .then(setGitOverview)
      .catch((error: unknown) => setGitError(error instanceof Error ? error.message : String(error)))
      .finally(() => setGitLoading(false));
  };
  const chooseSlashCommand = (command: SlashCommand | undefined) => {
    if (!command) return;
    const handlers: Record<SlashCommandId, () => void> = {
      scope: enterScope,
      git: () => {
        const projectId = scope?.projectId ?? currentProject?.id;
        if (projectId) loadGitOverview(projectId);
        else {
          setStep("git-project");
          setQuery("");
          resetActive();
        }
      },
    };
    handlers[command.id]();
  };
  const runItem = (item: PaletteItem | undefined) => {
    if (item) void item.run();
  };
  const openHit = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onClose();
    void Promise.resolve().then(async () => {
      if (hit.kind === "note") {
        onNote(hit.projectId, hit.id);
        return;
      }
      const task = tasks.find((row) => row.id === hit.id) ?? await api.task(hit.id);
      onTask(task);
      if (hit.archived) onSettings("archive");
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : "搜索结果打开失败"));
  };
  const activate = (index: number) => {
    if (step === "scope-project") return chooseScopeProject(index === 0 ? null : projects[index - 1]?.id ?? null);
    if (step === "scope-type") return chooseScopeType(SCOPE_TYPE_OPTIONS[index]?.value ?? null);
    if (step === "git-project") {
      const projectId = projects[index]?.id;
      if (projectId) loadGitOverview(projectId);
      return;
    }
    if (step === "git-overview") return;
    if (slashMode) return chooseSlashCommand(slashCommands[index]);
    if (index < items.length) runItem(items[index]);
    else openHit(hits[index - items.length]);
  };
  const hover = (index: number, event: ReactMouseEvent) => {
    const previous = mouse.current;
    mouse.current = { x: event.clientX, y: event.clientY };
    if (!previous || (previous.x === event.clientX && previous.y === event.clientY)) return;
    setActive(index);
  };

  const gitProject = projects.find((project) => project.id === gitProjectId);
  const hitStart = items.length;
  const activeHit = active >= hitStart ? hits[active - hitStart] : undefined;
  const hasHits = step === "search" && !slashMode && hits.length > 0;
  const wide = hasHits || step === "git-overview";
  const placeholder = step === "scope-project" ? "选择项目…"
    : step === "scope-type" ? "选择类型…"
      : step === "git-project" ? "选择项目以查看 Git…"
        : step === "git-overview" ? "Git 概览"
          : "搜索任务、随手记，或输入 / 命令";

  return (
    <div className="overlay-scrim palette-scrim" role="presentation" onMouseDown={onClose}>
      <section className={`command-palette${wide ? " has-preview" : ""}`} role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <MagnifyingGlass size={18} className="shrink-0" />
          {step === "search" && scope && <ScopeToken scope={scope} projects={projects} onEdit={enterScope} onRemove={() => setScope(null)} />}
          {(step === "scope-project" || step === "scope-type") && <span className="shrink-0 rounded-md bg-overlay px-2 py-1 font-mono text-[11px] text-accent">/scope</span>}
          {step === "scope-type" && (
            <span className="shrink-0 rounded-md bg-overlay px-2 py-1 text-[11px] text-muted">
              {pendingProjectId ? projectNames.get(pendingProjectId) ?? "未知项目" : "不限项目"}
            </span>
          )}
          {(step === "git-project" || step === "git-overview") && <span className="shrink-0 rounded-md bg-overlay px-2 py-1 font-mono text-[11px] text-accent">/git</span>}
          {step === "git-overview" && gitProject && (
            <button type="button" className="shrink-0 rounded-md bg-overlay px-2 py-1 text-[11px] text-muted outline-none hover:text-ink focus-visible:text-ink" onClick={() => { setStep("git-project"); resetActive(); focusInput(); }}>
              {gitProject.name}
            </button>
          )}
          <input
            ref={input}
            value={step === "search" ? query : ""}
            readOnly={step !== "search"}
            onChange={(event) => { setQuery(event.target.value); resetActive(); }}
            placeholder={placeholder}
            onKeyDown={(event) => {
              const sequence = step === "search" && !slashMode && event.key === "Enter" && !event.nativeEvent.isComposing
                ? items.find((item) => item.keys?.replace(/\s+/g, "").toLowerCase() === query.toLowerCase())
                : undefined;
              if (sequence) {
                event.preventDefault();
                runItem(sequence);
              } else if (event.key === "ArrowDown" && total > 0) {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, total - 1));
              } else if (event.key === "ArrowUp" && total > 0) {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter" && total > 0) {
                event.preventDefault();
                activate(active);
              }
            }}
          />
          {step === "search" && <kbd>⌘K</kbd>}
        </div>

        {step === "scope-project" && (
          <div className="max-h-[min(58vh,520px)] overflow-y-auto"><ScopeProjectStep projects={projects} active={active} selectedProjectId={pendingProjectId} onChoose={chooseScopeProject} onHover={hover} /></div>
        )}
        {step === "scope-type" && (
          <div className="max-h-[min(58vh,520px)] overflow-y-auto"><ScopeTypeStep active={active} selectedType={scope?.type ?? null} onChoose={chooseScopeType} onHover={hover} /></div>
        )}
        {step === "git-project" && (
          <div className="max-h-[min(58vh,520px)] overflow-y-auto"><GitProjectStep projects={projects} active={active} onChoose={loadGitOverview} onHover={hover} /></div>
        )}
        {step === "git-overview" && <GitOverviewPanel project={gitProject} overview={gitOverview} loading={gitLoading} error={gitError} />}

        {step === "search" && slashMode && (
          <div className="max-h-[min(58vh,520px)] overflow-y-auto p-1">
            <div className="palette-label">命令</div>
            {slashCommands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                aria-selected={active === index}
                onMouseMove={(event) => hover(index, event)}
                onClick={() => chooseSlashCommand(command)}
                className="ui-selectable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none"
              >
                <span className="w-16 shrink-0 font-mono text-sm font-medium text-accent">{command.trigger}</span>
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{command.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-faint">{command.description}</span>
                </span>
              </button>
            ))}
            {!slashCommands.length && <p className="palette-empty">没有匹配的命令</p>}
          </div>
        )}

        {step === "search" && !slashMode && (
          <div className="palette-body">
            <div className="palette-results">
              {items.map((item, index) => {
                const header = index === 0 || items[index - 1]?.group !== item.group ? item.group : null;
                return (
                  <div key={item.key}>
                    {header && <div className="palette-label">{header}</div>}
                    <button type="button" className="palette-row ui-selectable" aria-selected={active === index} onMouseMove={(event) => hover(index, event)} onClick={() => runItem(item)}>
                      <span className="palette-row-icon">{item.icon}</span>
                      <span><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</span>
                      {item.keys && <kbd>{item.keys}</kbd>}
                      <em>↵</em>
                    </button>
                  </div>
                );
              })}
              <SearchHitList hits={hits} active={active} startIndex={hitStart} query={query} onHover={hover} onOpen={openHit} />
              {!normalTotal && <p className="palette-empty">{searching ? "搜索中…" : query.trim().length >= 2 ? "没有匹配的命令、任务或随手记" : "无匹配命令"}</p>}
              {searching && normalTotal > 0 && !hits.length && <p className="px-4 py-2 text-center text-[10px] text-faint">搜索中…</p>}
            </div>
            {hasHits && <SearchPreview hit={activeHit} query={query} />}
          </div>
        )}

        <footer className="palette-footer"><span>↑↓ 选择</span><span>↵ 执行</span><span>esc 关闭</span></footer>
      </section>
    </div>
  );
}
