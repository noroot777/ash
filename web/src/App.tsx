import { useEffect, useState, useCallback, useMemo } from "react";
import type { Task, Project, Group, AgentEvent } from "@harness/shared";
import { api } from "./api";
import { useServerEvents } from "./useEvents";
import { TaskList, orderedTasks } from "./TaskList";
import { TaskDetail, type LogLine } from "./TaskDetail";
import { CommandPalette, type Command } from "./CommandPalette";
import { STATUSES, PRIORITIES } from "./constants";
import { CreateTask } from "./CreateTask";
import { Composer } from "./DebateComposer";
import { DebateView } from "./DebateView";
import { applyDebateEvent, emptyDebate, type DebateState } from "./debateState";

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

  const connected = useServerEvents(
    useCallback((ev) => {
      if (ev.type === "task.status") {
        setTasks((ts) => ts.map((t) => (t.id === ev.taskId ? { ...t, status: ev.status } : t)));
        if (ev.status === "done" || ev.status === "failed") setSessionsBump((n) => n + 1);
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

  const visible = tasks; // already scoped to project
  const ordered = useMemo(() => orderedTasks(visible), [visible]);
  const current = visible.find((t) => t.id === selected) ?? null;

  const patch = useCallback(
    async (id: string, p: Partial<Task>) => {
      const updated = await api.patchTask(id, p);
      setTasks((ts) => ts.map((t) => (t.id === id ? updated : t)));
    },
    [],
  );

  const run = useCallback(async (id: string) => {
    setLogs((m) => ({ ...m, [id]: [] }));
    setDebates((m) => ({ ...m, [id]: emptyDebate() }));
    await api.runTask(id);
  }, []);

  const gate = useCallback((id: string, action: Parameters<typeof api.gate>[1]) => api.gate(id, action), []);

  const del = useCallback(
    async (id: string) => {
      if (!confirm("删除该任务？")) return;
      await api.deleteTask(id);
      setTasks((ts) => ts.filter((t) => t.id !== id));
      setSelected((cur) => (cur === id ? null : cur));
    },
    [],
  );

  const newGroup = useCallback(async () => {
    if (!projectId) return;
    const name = prompt("分组名称？");
    if (!name) return;
    const mode = confirm("并行运行？（取消 = 串行）") ? "parallel" : "serial";
    const g = await api.createGroup({ projectId, name, mode });
    setGroups((gs) => [...gs, g]);
  }, [projectId]);

  // ── keyboard navigation ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (paletteOpen || createOpen) return;
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
  }, [ordered, selected, current, paletteOpen, createOpen, run]);

  useEffect(() => {
    if (selected) document.querySelector(`[data-task-id="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ── command palette commands ──────────────────────────────────────────────
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "new", label: "新建任务", hint: "C", run: () => setCreateOpen(true) },
      { id: "newgroup", label: "新建分组", run: newGroup },
    ];
    if (current) {
      cmds.push({ id: "run", label: `运行：${current.title}`, hint: "R", run: () => run(current.id) });
      cmds.push({ id: "del", label: `删除：${current.title}`, run: () => del(current.id) });
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
  }, [current, projects, projectId, groups, run, del, patch, newGroup]);

  return (
    <div className="grid h-full grid-cols-[320px_1fr]">
      <aside className="flex min-h-0 flex-col border-r border-neutral-800">
        <div className="flex items-center justify-between px-4 py-3">
          <select
            value={projectId ?? ""}
            onChange={(e) => (e.target.value === "__new" ? createProject(setProjects, setProjectId) : setProjectId(e.target.value))}
            className="max-w-[180px] rounded bg-transparent text-sm font-medium tracking-tight text-neutral-100 outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="__new">+ 新建项目…</option>
            {!projects.length && <option value="">无项目</option>}
          </select>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPaletteOpen(true)}
              className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500"
              title="命令面板"
            >
              ⌘K
            </button>
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-neutral-600"}`} />
            </span>
          </div>
        </div>
        <Composer
          projectId={projectId ?? ""}
          onCreated={(t, doRun) => {
            setTasks((ts) => [t, ...ts]);
            setSelected(t.id);
            if (doRun) {
              setDebates((m) => ({ ...m, [t.id]: emptyDebate() }));
              api.runTask(t.id);
            }
          }}
        />
        <TaskList tasks={visible} groups={groups} selected={selected} onSelect={setSelected} />
      </aside>

      {current ? (
        current.mode === "debate" ? (
          <DebateView
            key={current.id}
            task={current}
            state={debates[current.id] ?? emptyDebate()}
            sessionsBump={sessionsBump}
            onRun={() => run(current.id)}
            onGate={(a) => gate(current.id, a)}
            onDelete={() => del(current.id)}
          />
        ) : (
          <TaskDetail
            key={current.id}
            task={current}
            groups={groups}
            allTasks={visible}
            logs={logs[current.id] ?? []}
            sessionsBump={sessionsBump}
            onRun={() => run(current.id)}
            onPatch={(p) => patch(current.id, p)}
            onCreateGroup={newGroup}
            onDelete={() => del(current.id)}
          />
        )
      ) : (
        <div className="flex items-center justify-center text-sm text-neutral-600">
          选择任务，或在左上输入框新建 / 输入 /debate
        </div>
      )}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      {createOpen && projectId && (
        <CreateTask
          projectId={projectId}
          groups={groups}
          onClose={() => setCreateOpen(false)}
          onCreated={(t) => {
            setTasks((ts) => [t, ...ts]);
            setSelected(t.id);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

async function createProject(
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>,
  setProjectId: (id: string) => void,
) {
  const name = prompt("项目名称？");
  if (!name) return;
  const repoPath = prompt("git 仓库路径？") ?? "";
  const p = await api.createProject(name, repoPath);
  setProjects((ps) => [...ps, p]);
  setProjectId(p.id);
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
