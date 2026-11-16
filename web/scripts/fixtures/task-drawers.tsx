// 详情页左边那几屉的互斥 + 右侧「派出的任务」那一格（test-task-drawers-dom.mjs）。
//
// 挂的是 TaskDetail 自己用的那一个 hook（useTaskDrawers）：互斥的接线就在它里面，夹具不抄一份。
// 三屉各从生产的入口打开：子智能体从 Inspector 里那一行，读全文从 LeftDrawer 的槽（审查格、
// 辩论气泡就是这么开的），派出的任务从右侧那一格。
//
// 抽屉里那条任务是 NestedDetail：生产里是抽屉模式的完整 TaskDetail，这里只留它跟抽屉有关的那一半
// —— 自己也调 useTaskDrawers、自己也有三屉（往下一层的派出任务、子智能体、读全文），三颗键各开
// 一屉。整页只有一屉这条（往下一层看是替换、不叠出越来越窄的抽屉）就是靠它钉住的。
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

const NESTED_INSPECTORS = [{ id: "info", title: "信息", icon: <span aria-hidden="true">i</span>, render: () => <p>这条任务的信息</p> }];

function NestedDetail({ task, allTasks, onOpenTask }: { task: Task; allTasks: TaskListItem[]; onOpenTask: (id: string) => void }) {
  const drawers = useTaskDrawers({
    task, allTasks, conversation, onOpenTask,
    renderTask: (child) => <NestedDetail key={child.id} task={child} allTasks={allTasks} onOpenTask={onOpenTask} />,
  });
  const agent = drawers.subagents.nativeWork.rows.find((row) => row.kind === "agent");
  // 它自己的 Inspector（生产里是任务详情的那一栏）：在抽屉里开它，不能把会话和回复框挤成一条。
  return (
    <LeftDrawerProvider value={drawers.leftDrawer.api}>
      <InspectorHost contextKey={`nested:${task.id}`} descriptors={NESTED_INSPECTORS} context={{}} defaultVisible={false}>
      {({ toggleButton }) => (
      <section className="task-detail" data-drawer-task={task.id} style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {toggleButton}
        <p>{task.title} 的会话</p>
        {/* 回复框那一行（附件、派审查、预览、接力、执行器胶囊、发送键，收成图标之后）大约这么宽。 */}
        <div className="reply-row-probe" style={{ width: 320, height: 4 }} aria-hidden="true" />
        {drawers.dispatched.state.tasks.map((kid) => (
          <button key={kid.id} type="button" onClick={() => drawers.dispatched.state.open(kid.id)}>在{task.title}里打开：{kid.title}</button>
        ))}
        <button type="button" onClick={() => agent && drawers.subagents.nativeWork.onOpenAgent(agent.id)}>在{task.title}里看子智能体</button>
        <button type="button" onClick={() => drawers.leftDrawer.api.open({
          key: `report-${task.id}`, kind: "审查报告", title: task.title, ariaLabel: `审查报告：${task.title}`, closeLabel: "关上审查报告", body: <p>{task.title} 的报告</p>,
        })}>在{task.title}里读审查报告</button>
        {drawers.drawers}
      </section>
      )}
      </InspectorHost>
    </LeftDrawerProvider>
  );
}

function App() {
  const [tasks, setTasks] = useState(initial);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    window.__add = (row) => setTasks((current) => [...current, task(row.id, row.title, row)]);
  }, []);
  const drawers = useTaskDrawers({
    task: lead, allTasks: tasks, conversation, onOpenTask: setOpened,
    renderTask: (child) => <NestedDetail key={child.id} task={child} allTasks={tasks} onOpenTask={setOpened} />,
  });
  const descriptors = useMemo(
    () => drawers.inspectors.filter((descriptor) => descriptor.id === "subagents" || descriptor.id === "dispatched"),
    [drawers.inspectors],
  );
  // 挂着的这两格读的那几样都给上（「派出的任务」那一格还要这条任务自己、整张任务表和几个回调）。
  const context = {
    nativeWork: drawers.subagents.nativeWork, dispatched: drawers.dispatched.state, task: lead, allTasks: tasks,
    onOpenTask: setOpened, onTaskUpdated: () => {}, notify: () => {},
  } as unknown as TaskInspectorContext;
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
