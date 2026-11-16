import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentEvent, ProjectView, Session, Task, TaskListItem } from "@ash/shared";
import { InspectorHost, InspectorHeadActions } from "../../src/inspector/index.ts";
import { LeftDrawerProvider } from "../../src/components/LeftDrawer.tsx";
import { useTaskDrawers } from "../../src/task-detail/useTaskDrawers.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import type { TaskInspectorContext } from "../../src/task-detail/taskInspectors.tsx";
import { TaskHeader } from "../../src/task-detail/TaskHeader.tsx";
import { DispatchNoteLine } from "../../src/task-detail/DispatchNoteLine.tsx";
import { dispatchNotes } from "../../src/task-detail/dispatchNotes.ts";
import { rememberFamilyInspector } from "../../src/task-detail/dispatched/inspectorNavigation.ts";
import { pushTaskHistoryEntry } from "../../src/workspace/workspaceHistory.ts";
import { CommandPalette } from "../../src/overlays/CommandPalette.tsx";
import "../../src/styles/global.css";

const at = (minutes: number) => new Date(Date.now() - (60 - minutes) * 60_000).toISOString();
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, projectId: "p1", groupId: null, parentId: null, title, body: "", mode: "single", status: "done", stage: "accepted",
  labels: [], dependsOn: [], resumeDependsOn: [], workflowMode: "preset", agentType: "claude", creationOrigin: { kind: "user" }, createdAt: at(0), updatedAt: at(0), ...extra,
});
const initial = [
  task("lead", "父任务", { stage: "verified" }),
  task("kid-a", "运行的子任务", { dispatchedBy: "lead", queueId: "q1", status: "running", stage: null, executorLabel: "codex@cpa", startedAt: at(1), createdAt: at(1) }),
  task("kid-b", "提问的子任务", { dispatchedBy: "lead", queueId: "q1", status: "paused", stage: null, question: "先迁数据还是先改接口？", createdAt: at(2) }),
  task("mid", "中间任务", { dispatchedBy: "lead", stage: null, createdAt: at(3) }),
  task("leaf", "最下层任务", { dispatchedBy: "mid", createdAt: at(4) }),
  task("accepted", "验收的子任务", { dispatchedBy: "lead", createdAt: at(5) }),
  task("solo", "还没派活的任务", { stage: "verified" }),
];
let currentTasks = initial;
const project = { id: "p1", name: "ash", repoPath: "/tmp/ash", health: { exists: true, isRepo: true } } as ProjectView;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/api/")) return realFetch(input, init);
  if (url.includes("/search/stream")) {
    const query = new URL(url, location.origin).searchParams.get("q") ?? "";
    const hits = currentTasks.filter((item) => item.title.includes(query) || item.id === query).map((item) => ({
      kind: "task", ...item, projectName: "ash", archived: false, field: "title", snippet: "", preview: item.title,
    }));
    return new Response(hits.map((hit) => JSON.stringify(hit)).join("\n"));
  }
  if (url.includes("/tasks/bodies")) {
    const { taskIds } = JSON.parse(String(init?.body ?? "{}"));
    return Response.json(taskIds.map((taskId: string) => ({ taskId, body: "" })));
  }
  return Response.json([]);
};
const session = { id: "s1", taskId: "lead", agentType: "claude", role: "single", executor: "claude@fixture", startedAt: at(0), endedAt: null } as Session;
const native = (nativeWork: NonNullable<Extract<AgentEvent, { kind: "tool" }>["nativeWork"]>, seconds: number) => ({
  at: new Date(Date.parse(session.startedAt) + seconds * 1000).toISOString(), turnStartedAt: session.startedAt,
  event: { kind: "tool", name: "fixture", nativeWork } satisfies AgentEvent,
});
const items = buildConversationItems([{ session, output: "", trace: [
  native({ type: "call", id: "agent-call", name: "agent", input: { description: "查一遍现有入口", prompt: "查" } }, 1),
  native({ type: "result", id: "agent-call", result: "查完了", failed: false }, 5),
] as never }], [session], []);
const conversation = { items, sessions: [session], refreshing: false, error: null, traceError: null, refetch: () => {} } as never;
const nothing = () => {};

function Detail({ current, tasks, tasksReady, navigate }: { current: Task; tasks: Task[]; tasksReady: boolean; navigate: (id: string) => void }) {
  const drawers = useTaskDrawers({ task: current, allTasks: tasks, tasksReady, conversation });
  const readReport = () => drawers.leftDrawer.api.open({ key: "report", kind: "审查报告", title: "第 1 轮", ariaLabel: "审查报告：第 1 轮", closeLabel: "关上审查报告", body: <p>报告正文</p> });
  const descriptors = useMemo(() => drawers.inspectors.filter((descriptor) => ["info", "files", "dispatched", "subagents", "review", "memos", "side-chat"].includes(descriptor.id))
    .map((descriptor) => descriptor.id === "subagents" ? { ...descriptor, render: (context: TaskInspectorContext) => <><InspectorHeadActions><button type="button" onClick={readReport}>读审查报告</button></InspectorHeadActions>{descriptor.render(context)}</> }
      : descriptor.id === "dispatched" ? descriptor : { ...descriptor, render: () => <p>{current.title} 的{descriptor.title}</p> }), [current.title, drawers.inspectors]);
  const go = (id: string) => { rememberFamilyInspector(current.id, id, tasks); navigate(id); };
  const context = { task: current, allTasks: tasks, dispatchedFolds: drawers.dispatchedFolds, nativeWork: drawers.subagents.nativeWork, onOpenTask: go, onTaskUpdated: nothing, notify: nothing } as unknown as TaskInspectorContext;
  return <LeftDrawerProvider value={drawers.leftDrawer.api}>
    <InspectorHost contextKey={`task:${current.id}`} descriptors={descriptors} context={context} tabPolicy={drawers.inspectorPolicy}>
      {(inspector) => <main className="task-detail" data-current-task={current.id} style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <TaskHeader task={current} actions={null} allTasks={tasks} conversationMarkdown="" busy={false} refreshing={false} reviewOpen={false}
          onTitle={async () => {}} onTogglePin={async () => {}} onPrimary={nothing} onRequeue={nothing} onArchive={nothing}
          onRefresh={nothing} onReview={nothing} onOpenTask={go} onDelete={nothing} inspectorToggle={inspector.toggleButton} notify={nothing} />
        <div style={{ display: "flex", gap: 8 }}>
          {["info", "dispatched", "subagents", "files", "side-chat", "memos"].map((id) => <button key={id} onClick={() => inspector.openTab(id)}>切到{id}</button>)}
        </div>
        <p>{current.title} 的会话</p>
        {dispatchNotes(current.id, tasks).map((note) => <DispatchNoteLine key={note.id} note={note} onOpen={go} />)}
        <textarea aria-label={`回话给${current.title}`} />
        {drawers.drawers}
      </main>}
    </InspectorHost>
  </LeftDrawerProvider>;
}

declare global { interface Window {
  __add: (row: Partial<Task> & { id: string; title: string }) => void;
  __patch: (id: string, patch: Partial<Task>) => void;
  __go: (id: string) => void;
  __hydrate: (ready?: boolean) => void;
  __ready: () => void;
  __tasks: () => Task[];
} }

function App() {
  const [tasks, setTasks] = useState(() => new URLSearchParams(location.search).has("partial") ? initial.filter((item) => item.id === (new URLSearchParams(location.search).get("task") ?? "lead")) : initial);
  const [tasksReady, setTasksReady] = useState(() => !new URLSearchParams(location.search).has("partial"));
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get("task") ?? "lead");
  const [palette, setPalette] = useState(false);
  currentTasks = tasks;
  const navigate = (id: string) => { const next = tasks.find((item) => item.id === id); if (next) { pushTaskHistoryEntry(next); setSelected(id); } };
  useEffect(() => {
    window.__add = (row) => setTasks((current) => [...current, task(row.id, row.title, { createdAt: new Date().toISOString(), ...row })]);
    window.__patch = (id, patch) => setTasks((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    window.__go = navigate;
    window.__hydrate = (ready = true) => {
      setTasks((current) => [...current, ...initial.filter((item) => !current.some((known) => known.id === item.id))]);
      if (ready) setTasksReady(true);
    };
    window.__ready = () => setTasksReady(true);
    window.__tasks = () => currentTasks;
  });
  useEffect(() => {
    const pop = () => setSelected(new URLSearchParams(location.search).get("task") ?? "lead");
    const keys = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(true); } };
    addEventListener("popstate", pop); addEventListener("keydown", keys);
    return () => { removeEventListener("popstate", pop); removeEventListener("keydown", keys); };
  }, []);
  const current = tasks.find((item) => item.id === selected)!;
  return <div data-tasks-ready={String(tasksReady)} style={{ height: "100vh", display: "flex", overflow: "hidden" }}>
    <Detail key={current.id} current={current} tasks={tasks} tasksReady={tasksReady} navigate={navigate} />
    <CommandPalette open={palette} projects={[project]} currentProject={project} tasks={tasks} selectedTask={current} groups={[]} onClose={() => setPalette(false)}
      onProject={nothing} onTaskMode={nothing} onTask={(item: TaskListItem) => navigate(item.id)} onTaskUpdated={nothing} onNote={nothing} onComposer={nothing}
      onNewGroup={nothing} onNewProject={nothing} onDeleteTask={nothing} onSettings={nothing} notify={nothing} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
