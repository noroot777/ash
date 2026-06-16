import { useEffect, useState, useCallback, useMemo } from "react";
import type { Task, Project, Group, AgentEvent } from "@harness/shared";
import { NotePencil, CaretDown, MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "./api";
import { useServerEvents } from "./useEvents";
import { TaskList, orderedTasks } from "./TaskList";
import { TaskDetail, type LogLine } from "./TaskDetail";
import { CommandPalette, type Command } from "./CommandPalette";
import { STATUSES, PRIORITIES } from "./constants";
import { CreateTask } from "./CreateTask";
import { DebateModal } from "./DebateComposer";
import { DebateView } from "./DebateView";
import { applyDebateEvent, emptyDebate, type DebateState } from "./debateState";
import { AgentsPanel } from "./AgentsPanel";
import { Board } from "./Board";
import { Menu } from "./Menu";
import { NewProjectModal, NewGroupModal } from "./Modal";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [debates, setDebates] = useState<Record<string, DebateState>>({});
  const [sessionsBump, setSessionsBump] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [debateOpen, setDebateOpen] = useState(false);
  const [view, setView] = useState<"list" | "board">("list");

  const connected = useServerEvents(
    useCallback((ev) => {
      if (ev.type === "task.status") {
        setTasks((ts) => ts.map((t) => (t.id === ev.taskId ? { ...t, status: ev.status } : t)));
        if (ev.status === "done" || ev.status === "failed") setSessionsBump((n) => n + 1);
      } else if (ev.type === "task.title") {
        setTasks((ts) => ts.map((t) => (t.id === ev.taskId ? { ...t, title: ev.title } : t)));
      } else if (ev.type === "agent.event") {
        if (ev.role === "single") {
          const line = renderEvent(ev.event);
          if (line) setLogs((m) => ({ ...m, [ev.taskId]: [...(m[ev.taskId] ?? []), line] }));
        } else {
          setDebates((m) => ({ ...m, [ev.taskId]: applyDebateEvent(m[ev.taskId] ?? emptyDebate(), ev) }));
        }
      } else if (ev.type === "debate.progress" || ev.type === "debate.gate") {
        setDebates((m) => ({ ...m, [ev.taskId]: applyDebateEvent(m[ev.taskId] ?? emptyDebate(), ev) }));
      }
    }, []),
  );

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      if (ps.length) setProjectId((cur) => cur ?? ps[0].id);
    });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api.groups(projectId).then(setGroups);
    api.tasks().then((ts) => {
      const mine = ts.filter((t) => t.projectId === projectId);
      setTasks(mine);
      setSelected((cur) => (mine.some((t) => t.id === cur) ? cur : (mine[0]?.id ?? null)));
    });
  }, [projectId]);

  const visible = tasks;
  const ordered = useMemo(() => orderedTasks(visible), [visible]);
  const current = visible.find((t) => t.id === selected) ?? null;
  const projectName = projects.find((p) => p.id === projectId)?.name ?? "项目";

  const patch = useCallback(async (id: string, p: Partial<Task>) => {
    const updated = await api.patchTask(id, p);
    setTasks((ts) => ts.map((t) => (t.id === id ? updated : t)));
  }, []);

  const run = useCallback(async (id: string) => {
    setLogs((m) => ({ ...m, [id]: [] }));
    setDebates((m) => ({ ...m, [id]: emptyDebate() }));
    await api.runTask(id);
  }, []);

  const gate = useCallback((id: string, action: Parameters<typeof api.gate>[1]) => api.gate(id, action), []);

  const del = useCallback(async (id: string, title: string) => {
    if (!window.confirm(`删除任务「${title}」？`)) return;
    await api.deleteTask(id);
    setTasks((ts) => ts.filter((t) => t.id !== id));
    setSelected((cur) => (cur === id ? null : cur));
  }, []);

  const onTaskCreated = useCallback((t: Task, doRun = false) => {
    setTasks((ts) => [t, ...ts]);
    setSelected(t.id);
    if (doRun) {
      setDebates((m) => ({ ...m, [t.id]: emptyDebate() }));
      api.runTask(t.id);
    }
  }, []);

  const doCreateProject = useCallback(async (name: string, repoPath: string) => {
    const p = await api.createProject(name, repoPath);
    setProjects((ps) => [...ps, p]);
    setProjectId(p.id);
    setNewProjectOpen(false);
  }, []);

  const doCreateGroup = useCallback(
    async (name: string, mode: "parallel" | "serial") => {
      if (!projectId) return;
      const g = await api.createGroup({ projectId, name, mode });
      setGroups((gs) => [...gs, g]);
      setNewGroupOpen(false);
    },
    [projectId],
  );

  const anyModal = createOpen || agentsOpen || newProjectOpen || newGroupOpen || debateOpen;

  // ── keyboard navigation ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (anyModal) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (paletteOpen || anyModal) return;
      const idx = ordered.findIndex((t) => t.id === selected);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (ordered.length) setSelected(ordered[Math.min(idx + 1, ordered.length - 1)]?.id ?? selected);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (ordered.length) setSelected(ordered[Math.max(idx - 1, 0)]?.id ?? selected);
      } else if (e.key === "c") {
        e.preventDefault();
        setCreateOpen(true);
      } else if (e.key === "r" && current) {
        e.preventDefault();
        run(current.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selected, current, paletteOpen, anyModal, run]);

  useEffect(() => {
    if (selected) document.querySelector(`[data-task-id="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ── command palette ──────────────────────────────────────────────────────
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "new", label: "新建任务", hint: "C", run: () => setCreateOpen(true) },
      { id: "debate", label: "发起对抗 (/debate)", run: () => setDebateOpen(true) },
      { id: "newgroup", label: "新建分组", run: () => setNewGroupOpen(true) },
      { id: "newproject", label: "新建项目", run: () => setNewProjectOpen(true) },
      { id: "agents", label: "管理智能体执行器", run: () => setAgentsOpen(true) },
    ];
    if (current) {
      cmds.push({ id: "run", label: `运行：${current.title}`, hint: "R", run: () => run(current.id) });
      cmds.push({ id: "del", label: `删除：${current.title}`, run: () => del(current.id, current.title) });
      for (const s of STATUSES)
        cmds.push({ id: "st-" + s.key, group: "设为状态", label: s.label, run: () => patch(current.id, { status: s.key }) });
      for (const p of PRIORITIES)
        cmds.push({ id: "pr-" + p.key, group: "设为优先级", label: p.label, run: () => patch(current.id, { priority: p.key }) });
    }
    for (const p of projects)
      if (p.id !== projectId)
        cmds.push({ id: "proj-" + p.id, group: "切换项目", label: p.name, run: () => setProjectId(p.id) });
    for (const g of groups)
      cmds.push({
        id: "rg-" + g.id,
        group: "运行分组",
        label: `${g.name} · ${g.mode === "parallel" ? "并行" : "串行"}`,
        run: () => api.runGroup(g.id),
      });
    return cmds;
  }, [current, projects, projectId, groups, run, del, patch]);

  return (
    <div className="flex h-full flex-col">
      {/* Full-width top bar */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-panel px-3">
        <div className="flex items-center gap-1.5">
          <Menu
            value={projectId ?? ""}
            onChange={(v) => (v === "__new" ? setNewProjectOpen(true) : setProjectId(v))}
            options={[
              ...projects.map((p) => ({ value: p.id, label: p.name })),
              { value: "__new", label: "+ 新建项目…" },
            ]}
            menuWidth={220}
            triggerClassName="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-raised"
          >
            <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[12px] font-semibold text-accent-fg">
              {projectName.slice(0, 1).toUpperCase()}
            </span>
            <span className="max-w-[180px] truncate text-[13px] font-semibold text-ink">{projectName}</span>
            <CaretDown size={12} className="text-faint" />
          </Menu>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-faint"}`} title={connected ? "实时已连接" : "未连接"} />
          <button
            onClick={() => setCreateOpen(true)}
            className="ml-1 grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink"
            title="新建任务"
          >
            <NotePencil size={17} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-raised p-0.5 text-[12px]">
            <button onClick={() => setView("list")} className={`rounded-md px-2.5 py-1 transition-colors ${view === "list" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
              列表
            </button>
            <button onClick={() => setView("board")} className={`rounded-md px-2.5 py-1 transition-colors ${view === "board" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
              看板
            </button>
          </div>
          <button onClick={() => setAgentsOpen(true)} className="rounded-md px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink" title="智能体执行器">
            智能体
          </button>
          <button onClick={() => setPaletteOpen(true)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink" title="命令面板">
            <MagnifyingGlass size={13} />
            <span>搜索</span>
            <kbd>⌘K</kbd>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {view === "board" ? (
          <div className="min-w-0 flex-1">
            <Board tasks={visible} onMove={(id, status) => patch(id, { status })} onOpen={(id) => { setSelected(id); setView("list"); }} />
          </div>
        ) : (
          <>
            <aside className="flex w-[300px] shrink-0 flex-col border-r border-line">
              <TaskList tasks={visible} groups={groups} selected={selected} onSelect={setSelected} />
            </aside>
            <div className="min-w-0 flex-1">
              {current ? (
                current.mode === "debate" ? (
                  <DebateView key={current.id} task={current} state={debates[current.id] ?? emptyDebate()} sessionsBump={sessionsBump} onRun={() => run(current.id)} onGate={(a) => gate(current.id, a)} onDelete={() => del(current.id, current.title)} />
                ) : (
                  <TaskDetail key={current.id} task={current} groups={groups} allTasks={visible} logs={logs[current.id] ?? []} sessionsBump={sessionsBump} onRun={() => run(current.id)} onPatch={(p) => patch(current.id, p)} onCreateGroup={() => setNewGroupOpen(true)} onDelete={() => del(current.id, current.title)} />
                )
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-[13px] text-faint">
                  <span>选择左侧任务，或新建</span>
                  <span className="text-[12px]">按 <kbd>C</kbd> 新建 · <kbd>⌘K</kbd> 命令面板</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      {agentsOpen && <AgentsPanel onClose={() => setAgentsOpen(false)} />}
      {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} onCreate={doCreateProject} />}
      {newGroupOpen && <NewGroupModal onClose={() => setNewGroupOpen(false)} onCreate={doCreateGroup} />}
      {debateOpen && projectId && <DebateModal projectId={projectId} onClose={() => setDebateOpen(false)} onCreated={onTaskCreated} />}
      {createOpen && projectId && (
        <CreateTask
          projectId={projectId}
          projectName={projectName}
          groups={groups}
          onClose={() => setCreateOpen(false)}
          onCreated={(t) => onTaskCreated(t)}
          onDebate={() => {
            setCreateOpen(false);
            setDebateOpen(true);
          }}
        />
      )}
    </div>
  );
}

function renderEvent(e: AgentEvent): LogLine | null {
  switch (e.kind) {
    case "text":
      return { kind: "text", text: e.text };
    case "thinking":
      return { kind: "thinking", text: e.text };
    case "tool":
      return { kind: "tool", text: `${e.name}${e.detail ? " " + e.detail : ""}` };
    case "error":
      return { kind: "error", text: e.message };
    case "done":
      return { kind: "done", text: `— 结束 (exit ${e.exitStatus}) —` };
    default:
      return null;
  }
}
