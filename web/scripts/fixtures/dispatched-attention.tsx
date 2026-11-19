// 服务端那一半是这里的一份「库」（存在 localStorage 里，刷新后还在），接口走真实的 api.ts → fetch：
//   · POST /tasks/:id/answer            —— 记下请求，按服务端的做法撤下那一问；
//   · POST /tasks/:id/reply             —— 记下请求。
// window.__server 让回归像服务端那样改「库」：失败了（服务端那边除了任务状态什么都不记）、改一条、
// 再派一层。
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task, TaskListItem } from "@navi/shared";
import { api } from "../../src/lib/api.ts";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { InspectorHost } from "../../src/inspector/index.ts";
import { LeftDrawerProvider } from "../../src/components/LeftDrawer.tsx";
import { TaskTree } from "../../src/workspace/TaskTree.tsx";
import { pushTaskHistoryEntry } from "../../src/workspace/workspaceHistory.ts";
import { TaskAncestry } from "../../src/components/TaskAncestry.tsx";
import type { SidebarSpread } from "../../src/workspace/useSidebarSpread.ts";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { useTaskDrawers } from "../../src/task-detail/useTaskDrawers.tsx";
import { dispatchNotes } from "../../src/task-detail/dispatchNotes.ts";
import { DispatchNoteLine } from "../../src/task-detail/DispatchNoteLine.tsx";
import type { TaskInspectorContext } from "../../src/task-detail/taskInspectors.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/task-tree.css";

const KEY = "navi-dispatched-attention-fixture";
const base = Date.now() - 60 * 60_000;
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
const project: ProjectView = {
  id: "p1", name: "navi", repoPath: "/tmp/navi", workflowId: null, useWorktreeDefault: false, createdAt: at(0),
  health: { exists: true, isRepo: true },
};
function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id, projectId: project.id, groupId: null, parentId: null, title, body: "", mode: "single", status: "done", stage: null,
    labels: [], dependsOn: [], resumeDependsOn: [], workflowMode: "preset", agentType: "claude", archived: false,
    createdAt: at(0), updatedAt: at(0), ...extra,
  } as Task;
}

type Db = { tasks: Task[]; requests: { url: string; body: Record<string, unknown> | null }[] };
const initial = (): Db => ({
  tasks: [
    task("lead", "拆活的分析任务"),
    task("kid-a", "第一条派出去的", { dispatchedBy: "lead", status: "paused", executorLabel: "codex@cpa", createdAt: at(1),
      question: "第一条的问题：先迁数据还是先改接口？", questionOptions: ["先迁数据", "先改接口"], updatedAt: at(12) }),
    task("kid-b", "第二条派出去的", { dispatchedBy: "lead", status: "paused", executorLabel: "claude@nodemach", createdAt: at(2),
      question: "第二条的问题：要不要顺手改文档？", questionOptions: ["要", "不要"], updatedAt: at(6) }),
    task("kid-c", "第三条派出去的", { dispatchedBy: "lead", status: "running", executorLabel: "claude@nodemach", createdAt: at(3) }),
  ],
  requests: [],
});
const load = (): Db => {
  try { const stored = localStorage.getItem(KEY); if (stored) return JSON.parse(stored) as Db; } catch { /* 空库 */ }
  return initial();
};
let db = load();
const listeners = new Set<() => void>();
const commit = (next: Db) => {
  db = next;
  localStorage.setItem(KEY, JSON.stringify(db));
  for (const listener of listeners) listener();
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/api/")) return realFetch(input, init);
  const path = url.replace(/^.*\/api/, "");
  if (path.startsWith("/tasks/bodies")) {
    const { taskIds } = JSON.parse(String(init?.body ?? "{}")) as { taskIds: string[] };
    return Response.json(taskIds.map((taskId) => ({ taskId, body: "" })));
  }
  if (init?.method && init.method !== "GET") {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const answered = path.match(/^\/tasks\/([^/]+)\/answer$/)?.[1];
    commit({
      ...db,
      requests: [...db.requests, { url: path, body }],
      tasks: answered ? db.tasks.map((row) => row.id === answered
        ? { ...row, question: null, questionOptions: null, questionItems: null, status: "running" as const } : row) : db.tasks,
    });
    if (answered) return Response.json({ answered: true, resumed: true });
    if (path.endsWith("/reply")) return Response.json({ started: true });
  }
  // 侧栏的接力那一块按「没有这条接口」处理（同 dispatch-tree 夹具）；其余读取一律空表，各格自己画空态。
  if (path.startsWith("/handoff")) return new Response("not found", { status: 404 });
  return Response.json([]);
};

declare global {
  interface Window {
    __server: {
      fail: (id: string) => void;
      patch: (id: string, patch: Partial<Task>) => void;
      add: (row: Partial<Task> & { id: string; title: string }) => void;
      requests: () => Db["requests"];
      reset: () => void;
    };
  }
}
window.__server = {
  fail: (id) => commit({ ...db, tasks: db.tasks.map((row) => row.id === id ? { ...row, status: "failed" as const } : row) }),
  patch: (id, patch) => commit({ ...db, tasks: db.tasks.map((row) => row.id === id ? { ...row, ...patch } : row) }),
  add: (row) => commit({ ...db, tasks: [...db.tasks, task(row.id, row.title, { createdAt: at(30), updatedAt: at(30), ...row })] }),
  requests: () => db.requests,
  reset: () => { localStorage.removeItem(KEY); db = initial(); },
};

const items: ConversationItem[] = [
  { kind: "user", id: "u1", text: "按刚才的拆法派出去吧。", attachments: [], at: at(0) },
  { kind: "user", id: "u2", text: "第二条先别动数据库。", attachments: [], at: at(10) },
];
const conversation = { items: [], sessions: [], refreshing: false, error: null, traceError: null, refetch: () => {} } as never;
const idleSpread = {
  open: false, laidOut: false, filter: "all", setFilter: () => {}, followUps: new Map(), loaded: new Set(),
  toggle: () => {}, close: () => {},
} as unknown as SidebarSpread;

function TaskReply({ task }: { task: Task }) {
  return (
    <section className="task-detail-main" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <ReplyBox task={task} hasConversation onSend={(text) => api.replyTask(task.id, text)} onStandingExecutorChange={async () => undefined}
        onAnswer={async (answer, input) => { await api.answerTask(task.id, answer, input); }} />
    </section>
  );
}

function Fixture() {
  const [, setVersion] = useState(0);
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get("task") ?? "lead");
  useEffect(() => {
    const pop = () => setSelected(new URLSearchParams(location.search).get("task") ?? "lead");
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const listener = () => setVersion((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const tasks: TaskListItem[] = db.tasks;
  const lead = db.tasks.find((row) => row.id === selected)!;
  const navigate = (id: string) => {
    const next = db.tasks.find((row) => row.id === id);
    if (!next) return;
    pushTaskHistoryEntry(next);
    setSelected(id);
  };
  const drawers = useTaskDrawers({
    task: lead, allTasks: tasks, conversation,
  });
  const asides = dispatchNotes(lead.id, tasks).map((note) => ({
    key: `dispatch:${note.id}`, at: note.at, node: <DispatchNoteLine note={note} onOpen={navigate} />,
  }));
  const descriptors = useMemo(() => drawers.inspectors.filter((descriptor) => descriptor.id === "dispatched"), [drawers.inspectors]);
  // 右侧那一格要的那几样（这条任务、全量任务列表：格头的停 / 续、行尾名下的数都从它们算）。
  const context = {
    task: lead, allTasks: tasks, dispatchedFolds: drawers.dispatchedFolds,
    onOpenTask: navigate, onTaskUpdated: () => {}, notify: () => {},
  } as unknown as TaskInspectorContext;
  return (
    <div style={{ height: "100vh", display: "flex", overflow: "hidden", background: "var(--canvas)" }}>
      <nav style={{ width: 300, flex: "0 0 auto", overflow: "auto" }}>
        <TaskTree
          projects={[project]} currentProjectId={project.id} scope={{ kind: "project", projectId: project.id }}
          tasks={db.tasks} selectedTaskId={selected} selectedRemoteTaskId={null} spread={idleSpread}
          onTask={(next) => navigate(next.id)} onRemoteTask={() => {}} onHandoffFinished={() => {}} onQueueChanged={() => {}}
          outbound={{ outboundCount: 0, offlinePeers: [], asked: true, refreshing: false, onRefresh: () => {} }}
          notify={() => {}}
        />
      </nav>
      <LeftDrawerProvider value={drawers.leftDrawer.api}>
        <InspectorHost contextKey={`task:${lead.id}`} descriptors={descriptors} context={context} defaultVisible tabPolicy={drawers.inspectorPolicy}>
          {() => (
            <section className="task-detail" data-pane={lead.id} style={{ position: "relative", overflow: "hidden", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <TaskAncestry task={lead} tasks={tasks} onOpen={navigate} />
              <div className="task-detail-main" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <ConversationFeed task={lead} items={items} sessions={[]} loading={false} error={null} questionHistory={[]} asides={asides} />
                <TaskReply key={lead.id} task={lead} />
              </div>
              {drawers.drawers}
            </section>
          )}
        </InspectorHost>
      </LeftDrawerProvider>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<StrictMode><DraftProvider><Fixture /></DraftProvider></StrictMode>);
