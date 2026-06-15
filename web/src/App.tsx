import { useEffect, useState, useCallback } from "react";
import type { Task, Project, TaskStatus, AgentEvent } from "@harness/shared";
import { api } from "./api";
import { useServerEvents } from "./useEvents";
import { TaskDetail, type LogLine } from "./TaskDetail";

const STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: "bg-neutral-600",
  queued: "bg-amber-400",
  running: "bg-sky-400 animate-pulse",
  awaiting_review: "bg-violet-400",
  done: "bg-emerald-400",
  failed: "bg-red-400",
  canceled: "bg-neutral-500",
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [sessionsBump, setSessionsBump] = useState(0);

  const connected = useServerEvents(
    useCallback((ev) => {
      if (ev.type === "task.status") {
        setTasks((ts) => ts.map((t) => (t.id === ev.taskId ? { ...t, status: ev.status } : t)));
        if (ev.status === "done" || ev.status === "failed") setSessionsBump((n) => n + 1);
      } else if (ev.type === "agent.event") {
        const line = renderEvent(ev.event);
        if (line) setLogs((m) => ({ ...m, [ev.taskId]: [...(m[ev.taskId] ?? []), line] }));
      }
    }, []),
  );

  useEffect(() => {
    api.projects().then(setProjects);
    api.tasks().then((ts) => {
      setTasks(ts);
      if (ts.length && !selected) setSelected(ts[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCreate = async (t: Parameters<typeof api.createTask>[0]) => {
    const task = await api.createTask(t);
    setTasks((ts) => [task, ...ts]);
    setSelected(task.id);
  };

  const onRun = async (id: string) => {
    setLogs((m) => ({ ...m, [id]: [] }));
    await api.runTask(id);
  };

  const current = tasks.find((t) => t.id === selected) ?? null;

  return (
    <div className="grid h-full grid-cols-[300px_1fr]">
      <aside className="flex flex-col border-r border-neutral-800">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium tracking-tight">Harness</span>
          <span className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-neutral-600"}`} />
            {connected ? "live" : "off"}
          </span>
        </div>
        <NewTask projects={projects} onCreate={onCreate} onNewProject={(p) => setProjects((ps) => [...ps, p])} />
        <div className="mt-1 flex-1 overflow-y-auto">
          {tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-neutral-900 ${
                selected === t.id ? "bg-neutral-900" : ""
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[t.status]}`} />
              <span className="truncate text-neutral-200">{t.title}</span>
              <span className="ml-auto shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                {t.mode}
              </span>
            </button>
          ))}
          {!tasks.length && <p className="px-4 py-6 text-xs text-neutral-600">还没有任务</p>}
        </div>
      </aside>

      {current ? (
        <TaskDetail
          key={current.id}
          task={current}
          logs={logs[current.id] ?? []}
          sessionsBump={sessionsBump}
          onRun={() => onRun(current.id)}
        />
      ) : (
        <div className="flex items-center justify-center text-sm text-neutral-600">选择或新建一个任务</div>
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
      return null; // session events handled via credential chips
  }
}

function NewTask({
  projects,
  onCreate,
  onNewProject,
}: {
  projects: Project[];
  onCreate: (t: Parameters<typeof api.createTask>[0]) => void;
  onNewProject: (p: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const addProject = async () => {
    const name = prompt("项目名称？");
    if (!name) return;
    const repoPath = prompt("git 仓库路径？") ?? "";
    const p = await api.createProject(name, repoPath);
    onNewProject(p);
    setProjectId(p.id);
  };

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="mx-4 rounded-md border border-neutral-800 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900"
      >
        + 新建任务
      </button>
    );

  return (
    <div className="mx-3 flex flex-col gap-2 rounded-md border border-neutral-800 p-3">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="任务标题"
        className="rounded bg-neutral-900 px-2 py-1 text-sm outline-none placeholder:text-neutral-600"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="给 agent 的目标 / prompt"
        rows={3}
        className="resize-none rounded bg-neutral-900 px-2 py-1 text-sm outline-none placeholder:text-neutral-600"
      />
      <div className="flex items-center gap-1">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="min-w-0 flex-1 rounded bg-neutral-900 px-1.5 py-1 text-xs text-neutral-300 outline-none"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button onClick={addProject} className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
          +项目
        </button>
      </div>
      <div className="flex justify-end gap-2 text-xs">
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-neutral-500">
          取消
        </button>
        <button
          disabled={!title || !projectId}
          onClick={() => {
            onCreate({ projectId, title, body, mode: "single", agentType: "claude" });
            setTitle("");
            setBody("");
            setOpen(false);
          }}
          className="rounded bg-neutral-200 px-3 py-1 font-medium text-neutral-900 disabled:opacity-40"
        >
          创建
        </button>
      </div>
    </div>
  );
}
