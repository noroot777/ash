// 详情页左边那几屉的互斥 + 右侧「派出的任务」那一格（test-task-drawers-dom.mjs）。
//
// 挂的是 TaskDetail 自己用的那一个 hook（useTaskDrawers）：互斥的接线就在它里面，夹具不抄一份。
// 三屉各从生产的入口打开：子智能体从 Inspector 里那一行，读全文从 LeftDrawer 的槽（审查格、
// 辩论气泡就是这么开的），派出的任务从右侧那一格。抽屉里那条任务画成一行字（生产里是抽屉模式的
// TaskDetail，跟团队执行者抽屉同一个）。
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentEvent, Session, Task, TaskListItem } from "@ash/shared";
import { InspectorHost } from "../../src/inspector/index.ts";
import { LeftDrawerProvider } from "../../src/components/LeftDrawer.tsx";
import { useTaskDrawers } from "../../src/task-detail/useTaskDrawers.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import type { TaskInspectorContext } from "../../src/task-detail/taskInspectors.tsx";
import "../../src/styles/global.css";

// 没有服务端：正文按 id 回空串，其余读取一律空表（各格自己会画空态）。
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/api/")) return realFetch(input, init);
  if (url.includes("/tasks/bodies")) {
    const { taskIds } = JSON.parse(String(init?.body ?? "{}")) as { taskIds: string[] };
    return Response.json(taskIds.map((taskId) => ({ taskId, body: "" })));
  }
  return Response.json([]);
};

const at = (minutes: number) => new Date(Date.parse("2026-11-15T10:00:00.000Z") + minutes * 60_000).toISOString();
function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id, projectId: "p1", groupId: null, parentId: null, title, body: "", mode: "single", status: "done", stage: null,
    labels: [], dependsOn: [], resumeDependsOn: [], workflowMode: "preset", agentType: "claude",
    createdAt: at(0), updatedAt: at(0), ...extra,
  } as Task;
}

const lead = task("lead", "拆活的分析任务", { status: "paused" });
const initial: TaskListItem[] = [
  lead,
  task("kid-a", "第一条派出去的", { dispatchedBy: "lead", queueId: "q1", status: "running", executorLabel: "codex@cpa", startedAt: at(1), createdAt: at(1) }),
  task("kid-b", "第二条派出去的", { dispatchedBy: "lead", queueId: "q1", status: "paused", question: "选哪种？", createdAt: at(2) }),
];

const session = {
  id: "s1", taskId: "lead", agentType: "claude", role: "single", executor: "claude@fixture",
  startedAt: at(0), endedAt: null,
} as unknown as Session;
const native = (nativeWork: NonNullable<Extract<AgentEvent, { kind: "tool" }>["nativeWork"]>, seconds: number) => ({
  at: new Date(Date.parse(session.startedAt) + seconds * 1000).toISOString(),
  turnStartedAt: session.startedAt,
  event: { kind: "tool", name: "fixture", nativeWork } satisfies AgentEvent,
});
const items = buildConversationItems([{ session, output: "", trace: [
  native({ type: "call", id: "agent-call", name: "agent", input: { description: "查一遍现有入口", prompt: "查" } }, 1),
  native({ type: "result", id: "agent-call", result: "查完了", failed: false }, 5),
] as never }], [session], []);
const conversation = { items, sessions: [session], refreshing: false, error: null, traceError: null, refetch: () => {} } as never;

declare global {
  interface Window { __add: (row: Partial<Task> & { id: string; title: string }) => void }
}

function App() {
  const [tasks, setTasks] = useState(initial);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    window.__add = (row) => setTasks((current) => [...current, task(row.id, row.title, row)]);
  }, []);
  const drawers = useTaskDrawers({
    task: lead, allTasks: tasks, conversation, onOpenTask: setOpened,
    renderTask: (child) => <p data-drawer-task={child.id}>{child.title} 的会话</p>,
  });
  const descriptors = useMemo(
    () => drawers.inspectors.filter((descriptor) => descriptor.id === "subagents" || descriptor.id === "dispatched"),
    [drawers.inspectors],
  );
  const context = { nativeWork: drawers.subagents.nativeWork, dispatched: drawers.dispatched.state } as unknown as TaskInspectorContext;
  return (
    <div style={{ height: "100vh", display: "flex", overflow: "hidden" }}>
      <LeftDrawerProvider value={drawers.leftDrawer.api}>
        <InspectorHost contextKey="task-drawers-fixture" descriptors={descriptors} context={context} defaultVisible>
          {(inspector) => (
            <main style={{ minWidth: 0, minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
              <header style={{ display: "flex", gap: 6, padding: "12px 24px" }}>
                <button type="button" onClick={() => inspector.openTab("subagents")}>切到子智能体</button>
                <button type="button" onClick={() => inspector.openTab("dispatched")}>切到派出的任务</button>
                <button type="button" onClick={() => drawers.leftDrawer.api.open({
                  key: "report", kind: "审查报告", title: "第 1 轮", ariaLabel: "审查报告：第 1 轮", closeLabel: "关上审查报告", body: <p>报告正文</p>,
                })}>读审查报告</button>
                <output data-opened={opened ?? ""}>{opened}</output>
              </header>
              <section className="task-detail" style={{ position: "relative", overflow: "hidden", flex: 1, minHeight: 0 }}>
                <h1>中间那一栏</h1>
                {drawers.drawers}
              </section>
            </main>
          )}
        </InspectorHost>
      </LeftDrawerProvider>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
