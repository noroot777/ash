import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SearchHit, Task, ProjectView } from "@harness/shared";
import { api, type GitOverview } from "./api";
import { StatusIcon } from "./StatusIcon";
import { usePresence } from "./useReveal";
import { filterSlashCommands, type SlashCommand, type SlashCommandId } from "./commandPaletteCommands";
import {
  ScopeProjectStep,
  ScopeToken,
  ScopeTypeStep,
  SCOPE_TYPE_OPTIONS,
  type SearchScope,
  type SearchScopeType,
} from "./CommandPaletteScope";
import { GitOverviewPanel, GitProjectStep } from "./CommandPaletteGit";
import { SearchHitList, SearchPreview } from "./CommandPaletteSearch";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  group?: string;
  run: () => void;
};

type PaletteStep = "search" | "scope-project" | "scope-type" | "git-project" | "git-overview";

export function CommandPalette({
  open,
  commands,
  runningTasks,
  projects,
  currentProjectId,
  onClose,
  onOpenHit,
  onOpenTask,
}: {
  open: boolean;
  commands: Command[];
  runningTasks: Task[];
  projects: ProjectView[];
  currentProjectId: string | null;
  onClose: () => void;
  onOpenHit: (hit: SearchHit) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [q, setQ] = useState("");
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
  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const { mounted, closing } = usePresence(open, "--modal-close-dur");

  useEffect(() => {
    if (!open) return;
    const closeFirst = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", closeFirst, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", closeFirst, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setStep("search");
    setActive(0);
    setHits([]);
    setScope(null);
    setGitOverview(null);
    setGitError(null);
    mouseRef.current = null;
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const slashMode = step === "search" && q.startsWith("/");
  const slashCommands = useMemo(() => slashMode ? filterSlashCommands(q) : [], [slashMode, q]);
  const filtered = useMemo(() => {
    if (slashMode) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ""} ${command.keys ?? ""} ${command.group ?? ""}`.toLowerCase().includes(needle),
    );
  }, [q, commands, slashMode]);
  const leadingTasks = step === "search" && !slashMode && !q.trim() ? runningTasks : [];
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  useEffect(() => {
    const query = q.trim();
    if (step !== "search" || slashMode || query.length < 2) {
      seqRef.current += 1;
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      api.search(query, { projectId: scope?.projectId ?? undefined, type: scope?.type ?? undefined })
        .then((result) => {
          if (seqRef.current !== seq) return;
          setHits(result);
          setSearching(false);
        })
        .catch(() => {
          if (seqRef.current !== seq) return;
          setHits([]);
          setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [q, scope, slashMode, step]);

  const normalTotal = leadingTasks.length + filtered.length + hits.length;
  const total = step === "scope-project" ? projects.length + 1
    : step === "scope-type" ? SCOPE_TYPE_OPTIONS.length
      : step === "git-project" ? projects.length
        : step === "git-overview" ? 0
          : slashMode ? slashCommands.length
            : normalTotal;
  useEffect(() => {
    if (active >= total) setActive(0);
  }, [total, active]);

  if (!mounted) return null;

  const resetActive = () => {
    setActive(0);
    mouseRef.current = null;
  };
  const focusInput = () => setTimeout(() => inputRef.current?.focus(), 0);
  const enterScope = () => {
    setPendingProjectId(scope?.projectId ?? null);
    setStep("scope-project");
    setQ("");
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
    setQ("");
    resetActive();
    focusInput();
  };
  const loadGitOverview = (projectId: string) => {
    setGitProjectId(projectId);
    setStep("git-overview");
    setQ("");
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
        const projectId = scope?.projectId ?? currentProjectId;
        if (projectId) loadGitOverview(projectId);
        else {
          setStep("git-project");
          setQ("");
          resetActive();
        }
      },
    };
    handlers[command.id]();
  };
  const run = (command: Command | undefined) => {
    if (!command) return;
    command.run();
    onClose();
  };
  const openHit = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpenHit(hit);
    onClose();
  };
  const openRunningTask = (task: Task | undefined) => {
    if (!task) return;
    onOpenTask(task.id);
    onClose();
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
    if (index < leadingTasks.length) openRunningTask(leadingTasks[index]);
    else if (index < leadingTasks.length + filtered.length) run(filtered[index - leadingTasks.length]);
    else openHit(hits[index - leadingTasks.length - filtered.length]);
  };
  const hover = (index: number, event: ReactMouseEvent) => {
    const previous = mouseRef.current;
    mouseRef.current = { x: event.clientX, y: event.clientY };
    if (!previous || (previous.x === event.clientX && previous.y === event.clientY)) return;
    setActive(index);
  };

  const gitProject = projects.find((project) => project.id === gitProjectId);
  const hitStart = leadingTasks.length + filtered.length;
  const activeHit = active >= hitStart ? hits[active - hitStart] : undefined;
  const hasHits = step === "search" && !slashMode && hits.length > 0;
  const wide = hasHits || step === "git-overview";
  const placeholder = step === "scope-project" ? "选择项目…"
    : step === "scope-type" ? "选择类型…"
      : step === "git-project" ? "选择项目以查看 Git…"
        : step === "git-overview" ? "Git 概览"
          : "搜索任务，或输入 / 命令…";

  return (
    <div className={`t-modal-overlay ${closing ? "is-closing" : ""} fixed inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[15vh]`} onClick={onClose}>
      <div
        className={`t-modal ${closing ? "is-closing" : ""} ${wide ? "w-[860px]" : "w-[560px]"} max-w-[92vw] overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-[49px] items-center gap-2 border-b border-line px-3">
          {step === "search" && scope && (
            <ScopeToken scope={scope} projects={projects} onEdit={enterScope} onRemove={() => setScope(null)} />
          )}
          {(step === "scope-project" || step === "scope-type") && (
            <span className="shrink-0 rounded-md bg-overlay px-2 py-1 font-mono text-[11px] text-accent">/scope</span>
          )}
          {step === "scope-type" && (
            <span className="shrink-0 rounded-md bg-overlay px-2 py-1 text-[11px] text-muted">
              {pendingProjectId ? projectNames.get(pendingProjectId) ?? "未知项目" : "不限项目"}
            </span>
          )}
          {(step === "git-project" || step === "git-overview") && (
            <span className="shrink-0 rounded-md bg-overlay px-2 py-1 font-mono text-[11px] text-accent">/git</span>
          )}
          {step === "git-overview" && gitProject && (
            <button
              className="shrink-0 rounded-md bg-overlay px-2 py-1 text-[11px] text-muted outline-none hover:text-ink focus-visible:text-ink"
              onClick={() => { setStep("git-project"); resetActive(); focusInput(); }}
            >
              {gitProject.name}
            </button>
          )}
          <input
            ref={inputRef}
            value={step === "search" ? q : ""}
            readOnly={step !== "search"}
            onChange={(event) => { setQ(event.target.value); resetActive(); }}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-faint"
            onKeyDown={(event) => {
              const sequence = step === "search" && !slashMode && event.key === "Enter" && !event.nativeEvent.isComposing
                ? commands.find((command) => command.keys?.replace(/\s+/g, "").toLowerCase() === q.toLowerCase())
                : undefined;
              if (sequence) {
                event.preventDefault();
                run(sequence);
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
        </div>

        {step === "scope-project" && (
          <div className="max-h-[50vh] overflow-y-auto">
            <ScopeProjectStep projects={projects} active={active} selectedProjectId={pendingProjectId} onChoose={chooseScopeProject} onHover={hover} />
          </div>
        )}
        {step === "scope-type" && (
          <div className="max-h-[50vh] overflow-y-auto">
            <ScopeTypeStep active={active} selectedType={scope?.type ?? null} onChoose={chooseScopeType} onHover={hover} />
          </div>
        )}
        {step === "git-project" && (
          <div className="max-h-[50vh] overflow-y-auto"><GitProjectStep projects={projects} active={active} onChoose={loadGitOverview} onHover={hover} /></div>
        )}
        {step === "git-overview" && <GitOverviewPanel project={gitProject} overview={gitOverview} loading={gitLoading} error={gitError} />}

        {step === "search" && slashMode && (
          <div className="max-h-[50vh] overflow-y-auto py-1">
            <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">命令</div>
            {slashCommands.map((command, index) => (
              <button
                key={command.id}
                onMouseMove={(event) => hover(index, event)}
                onClick={() => chooseSlashCommand(command)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none ${active === index ? "bg-overlay" : ""}`}
              >
                <span className="w-16 shrink-0 font-mono text-sm font-medium text-accent">{command.trigger}</span>
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{command.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-faint">{command.description}</span>
                </span>
              </button>
            ))}
            {!slashCommands.length && <p className="px-4 py-8 text-center text-xs text-faint">没有匹配的命令</p>}
          </div>
        )}

        {step === "search" && !slashMode && (
          <div className={hasHits ? "grid h-[50vh] min-h-[320px] grid-cols-[42%_58%]" : "max-h-[50vh] overflow-y-auto"}>
            <div className={hasHits ? "min-h-0 overflow-y-auto border-r border-line py-1" : "py-1"}>
              {leadingTasks.length > 0 && <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">进行中</div>}
              {leadingTasks.map((task, index) => (
                <button
                  key={task.id}
                  onMouseMove={(event) => hover(index, event)}
                  onClick={() => openRunningTask(task)}
                  className={`flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left text-sm outline-none ${index === active ? "bg-overlay" : ""}`}
                >
                  <StatusIcon status={task.status} stage={task.stage} awaitingAnswer={!!task.question} />
                  <span className="min-w-0 truncate text-ink">{task.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-faint">{projectNames.get(task.projectId) ?? "未知项目"}</span>
                </button>
              ))}
              {filtered.map((command, commandIndex) => {
                const index = leadingTasks.length + commandIndex;
                const header = command.group && command.group !== filtered[commandIndex - 1]?.group ? command.group : null;
                return (
                  <div key={command.id}>
                    {header && <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">{header}</div>}
                    <button
                      onMouseMove={(event) => hover(index, event)}
                      onClick={() => run(command)}
                      className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm outline-none ${index === active ? "bg-overlay" : ""}`}
                    >
                      <span className="text-ink">{command.label}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {command.keys && (
                          <span className="flex gap-1" aria-label={`快捷键序列 ${command.keys}`}>
                            {command.keys.replace(/\s+/g, "").toUpperCase().split("").map((key, keyIndex) => <kbd key={`${key}:${keyIndex}`}>{key}</kbd>)}
                          </span>
                        )}
                        {command.hint && <span className="text-xs text-muted">{command.hint}</span>}
                      </span>
                    </button>
                  </div>
                );
              })}
              <SearchHitList hits={hits} active={active} startIndex={hitStart} query={q} onHover={hover} onOpen={openHit} />
              {searching && !hits.length && <p className="px-4 py-2 text-center text-xs text-faint">搜索中…</p>}
              {!normalTotal && !searching && (
                <p className="px-4 py-6 text-center text-xs text-faint">{q.trim().length >= 2 ? "没有匹配的命令、任务或随手记" : "无匹配命令"}</p>
              )}
            </div>
            {hasHits && <SearchPreview hit={activeHit} query={q} />}
          </div>
        )}
      </div>
    </div>
  );
}
