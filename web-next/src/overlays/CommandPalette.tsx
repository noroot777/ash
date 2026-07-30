import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Group, ProjectView, SearchHit, Task } from "@harness/shared";
import { canArchive, canSingleRun, TASK_STATUS_LABELS } from "@harness/shared";
import {
  Archive,
  FolderSimple,
  GearSix,
  MagnifyingGlass,
  NotePencil,
  Play,
  Plus,
  Stack,
} from "@phosphor-icons/react";
import { api } from "../lib/api.ts";

type PaletteItem = {
  key: string;
  group: string;
  label: string;
  detail?: string;
  keys?: string;
  icon: ReactNode;
  hit?: SearchHit;
  run: () => void | Promise<void>;
};

function projectName(projects: ProjectView[], projectId: string) {
  return projects.find((project) => project.id === projectId)?.name ?? "未知项目";
}

function hitIcon(hit: SearchHit) {
  return hit.kind === "note" ? <NotePencil size={15} /> : <span className={`palette-status is-${hit.status}`} />;
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
  onSettings,
  notify,
}: {
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
  onComposer: () => void;
  onSettings: (section?: "agents" | "project" | "groups" | "archive") => void;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setActive(0);
    window.setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(() => api.search(q).then((rows) => {
      if (seq === searchSeq.current) setHits(rows);
    }).catch(() => {
      if (seq === searchSeq.current) setHits([]);
    }).finally(() => {
      if (seq === searchSeq.current) setSearching(false);
    }), 180);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const items = useMemo(() => {
    const result: PaletteItem[] = [];
    const closeRun = (run: () => void | Promise<void>) => () => {
      onClose();
      Promise.resolve(run()).catch((error) => notify(error instanceof Error ? error.message : "命令执行失败"));
    };
    if (!query.trim()) {
      tasks.filter((task) => task.status === "running" || task.status === "queued" || !!task.question).slice(0, 6).forEach((task) => result.push({
        key: `running:${task.id}`,
        group: "进行中",
        label: task.title,
        detail: `${projectName(projects, task.projectId)} · ${task.question ? "等答复" : TASK_STATUS_LABELS[task.status]}`,
        icon: <span className={`palette-status is-${task.question ? "paused" : task.status}`} />,
        run: closeRun(() => onTask(task)),
      }));
    }
    if (selectedTask) {
      if (canSingleRun(selectedTask.status) && selectedTask.mode !== "team") result.push({ key: "task:run", group: `当前任务 · ${selectedTask.title}`, label: "运行任务", detail: "R", icon: <Play size={14} weight="fill" />, run: closeRun(async () => { await api.runTask(selectedTask.id); notify("任务已启动"); }) });
      if (!selectedTask.archived && canArchive(selectedTask.status)) result.push({ key: "task:archive", group: `当前任务 · ${selectedTask.title}`, label: "归档任务", icon: <Archive size={14} />, run: closeRun(async () => { onTaskUpdated(await api.archiveTask(selectedTask.id)); notify("任务已归档"); }) });
    }
    result.push(
      { key: "new:task", group: "新建", label: "新建任务", keys: "C", icon: <Plus size={15} />, run: closeRun(onComposer) },
      { key: "new:note", group: "新建", label: "新建随手记", keys: "NI", icon: <NotePencil size={15} />, run: closeRun(() => { if (currentProject) onNote(currentProject.id, "__new__"); }) },
      { key: "manage:notes", group: "管理", label: "随手记列表", keys: "NL", icon: <NotePencil size={15} />, run: closeRun(() => { if (currentProject) onNote(currentProject.id, null); }) },
      { key: "manage:settings", group: "管理", label: "设置", icon: <GearSix size={15} />, run: closeRun(() => onSettings("project")) },
      { key: "manage:groups", group: "管理", label: "分组管理", icon: <Stack size={15} />, run: closeRun(() => onSettings("groups")) },
    );
    projects.forEach((project) => result.push({ key: `project:${project.id}`, group: "切换项目", label: project.name, detail: project.repoPath, icon: <FolderSimple size={15} />, run: closeRun(() => onProject(project.id)) }));
    groups.filter((group) => !group.ownerTaskId).forEach((group) => result.push({ key: `group:${group.id}`, group: "运行分组", label: group.name, detail: `${group.mode === "parallel" ? "并行" : "串行"} · ${tasks.filter((task) => task.groupId === group.id).length} 个任务`, icon: <Play size={14} weight="fill" />, run: closeRun(async () => { await api.runGroup(group.id); notify(group.paused ? "分组已继续" : "分组已启动"); }) }));
    const q = query.trim().toLocaleLowerCase();
    const filtered = q ? result.filter((item) => `${item.label} ${item.detail ?? ""} ${item.group} ${item.keys ?? ""}`.toLocaleLowerCase().includes(q)) : result;
    hits.forEach((hit) => filtered.push({
      key: `hit:${hit.kind}:${hit.id}`,
      group: hit.kind === "task" ? "任务" : "随手记",
      label: hit.title,
      detail: `${hit.projectName ?? "未知项目"}${hit.snippet ? ` · ${hit.snippet}` : ""}`,
      icon: hitIcon(hit),
      hit,
      run: closeRun(() => {
        if (hit.kind === "note") onNote(hit.projectId, hit.id);
        else if (hit.archived) { onProject(hit.projectId); onSettings("archive"); }
        else {
          const task = tasks.find((row) => row.id === hit.id);
          if (task) onTask(task);
          else api.task(hit.id).then(onTask).catch(() => notify("任务读取失败"));
        }
      }),
    }));
    return filtered;
  }, [currentProject, groups, hits, onClose, onComposer, onNote, onProject, onSettings, onTask, onTaskUpdated, projects, query, selectedTask, tasks, notify]);

  useEffect(() => { if (active >= items.length) setActive(Math.max(0, items.length - 1)); }, [active, items.length]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [open, onClose]);
  if (!open) return null;
  const activeHit = items[active]?.hit;
  return (
    <div className="overlay-scrim palette-scrim" role="presentation" onMouseDown={onClose}>
      <section className={`command-palette${activeHit ? " has-preview" : ""}`} role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(event) => event.stopPropagation()}>
        <label className="palette-input"><MagnifyingGlass size={18} /><input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} placeholder="搜索任务、随手记，或输入命令" onKeyDown={(event) => {
          const sequence = event.key === "Enter" ? items.find((item) => item.keys?.replaceAll(" ", "").toLowerCase() === query.toLowerCase()) : null;
          if (sequence) { event.preventDefault(); sequence.run(); }
          else if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(items.length - 1, value + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
          else if (event.key === "Enter" && items[active]) { event.preventDefault(); items[active].run(); }
        }} /><kbd>⌘K</kbd></label>
        <div className="palette-body">
          <div className="palette-results">
            {items.map((item, index) => {
              const header = index === 0 || items[index - 1]?.group !== item.group ? item.group : null;
              return <div key={item.key}>{header && <div className="palette-label">{header}</div>}<button type="button" className="palette-row ui-selectable" aria-selected={active === index} onMouseMove={() => setActive(index)} onClick={item.run}><span className="palette-row-icon">{item.icon}</span><span><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</span>{item.keys && <kbd>{item.keys}</kbd>}<em>↵</em></button></div>;
            })}
            {!items.length && <p className="palette-empty">{searching ? "搜索中…" : "没有匹配的命令、任务或随手记"}</p>}
          </div>
          {activeHit && <aside className="palette-preview"><div><span>{activeHit.kind === "task" ? "任务预览" : "随手记预览"}</span><b>{activeHit.title}</b><small>{activeHit.projectName ?? "未知项目"}</small></div><p>{activeHit.preview || activeHit.snippet || "暂无正文"}</p></aside>}
        </div>
        <footer className="palette-footer"><span>↑↓ 选择</span><span>↵ 执行</span><span>esc 关闭</span></footer>
      </section>
    </div>
  );
}
