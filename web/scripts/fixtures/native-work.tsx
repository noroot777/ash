import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Robot } from "@phosphor-icons/react";
import type { AgentEvent, Session, TaskStatus } from "@ash/shared";
import { InspectorHost, type InspectorDescriptor } from "../../src/inspector/index.ts";
import { NativeWorkInspector } from "../../src/task-detail/NativeWorkInspector.tsx";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const session = {
  id: "native-work-session",
  taskId: "native-work-task",
  agentType: "codex",
  role: "single",
  executor: "codex@fixture",
  model: "gpt-5.6",
  startedAt: "2026-09-08T00:00:00.000Z",
  endedAt: null,
} as unknown as Session;

const longText = "需要检查一个不会自然换行的超长说明：" + "NATIVE_WORK_INSPECTOR_".repeat(35);
const native = (nativeWork: NonNullable<Extract<AgentEvent, { kind: "tool" }>["nativeWork"]>, seconds = 1) => ({
  at: new Date(Date.parse(session.startedAt) + seconds * 1000).toISOString(),
  turnStartedAt: session.startedAt,
  event: { kind: "tool", name: "fixture", nativeWork } satisfies AgentEvent,
});

function trace(final: boolean, updates = 0) {
  const events = [
    native({ type: "call", id: "agent-run-call", name: "spawn_agent", input: { description: "运行中的资料搜集", prompt: longText, model: "gpt-5.6-sol" } }),
    native({ type: "result", id: "agent-run-call", result: JSON.stringify({ agent_id: "agent-run" }), failed: false }),
    native({ type: "call", id: "child-task-create", parentId: "agent-run", name: "TaskCreate", input: { subject: "核对浏览器状态", description: longText } }),
    native({ type: "result", id: "child-task-create", result: JSON.stringify({ task: { id: "17" } }), failed: false }),
    native({ type: "call", id: "agent-done-call", name: "agent", input: { description: "已完成的结构检查", prompt: "检查数据结构" } }),
    native({ type: "result", id: "agent-done-call", result: "同步执行完成", failed: false }, 96),
    native({ type: "call", id: "agent-fail-call", name: "spawn_agent", input: { description: "启动失败的执行者", prompt: "模拟失败" } }),
    native({ type: "result", id: "agent-fail-call", result: "fixture launch failed", failed: true }, 4),
    native({ type: "agent", id: "agent-stopped", title: "用户停止的执行者", status: "stopped", message: "由用户停止" }),
    native({ type: "agent", id: "agent-unknown", title: "旧记录状态未知", status: "unknown", message: "没有最终状态" }),
    native({ type: "activity", id: "agent-run", event: { kind: "thinking", text: "核对侧栏事件的归属" } }),
    native({ type: "activity", id: "agent-run", event: { kind: "tool", name: "Read", detail: JSON.stringify({ file_path: "web/src/task-detail/NativeWorkInspector.tsx" }) } }),
    native({ type: "activity", id: "agent-run", event: { kind: "text", text: "已经找到**子智能体侧栏**，正在读取执行记录。\n\n" } }),
    native({ type: "activity", id: "agent-stopped", event: { kind: "text", text: "另一个子智能体的独立记录。" } }),
  ];
  for (let index = 1; index <= updates; index++) events.push(
    native({ type: "activity", id: "agent-run", event: { kind: "tool", name: "exec", detail: `npm run verify-child -- --round=${index}` } }),
    native({ type: "activity", id: "agent-run", event: { kind: "tool", name: "exec 结果", detail: `第 ${index} 轮检查通过\n退出码：0` } }),
    native({ type: "activity", id: "agent-run", event: { kind: "text", text: `实时进展 ${index}：工具调用和输出已经接入。\n\n` } }),
  );
  if (final) events.push(
    native({ type: "activity", id: "agent-run", event: { kind: "text", text: "刷新后仍应保留的完成结果" } }),
    native({ type: "agent", id: "agent-run", title: "运行中的资料搜集", status: "completed", result: "刷新后仍应保留的完成结果" }, 481),
    native({ type: "call", id: "child-task-update", parentId: "agent-run", name: "TaskUpdate", input: { taskId: "17", status: "completed", owner: "agent-run" } }),
    native({ type: "result", id: "child-task-update", result: "updated", failed: false }),
  );
  return events;
}

function conversation(final: boolean, updates: number, planSnapshot = false) {
  return buildConversationItems(
    [{ session, output: "主会话正文", trace: (planSnapshot ? [native({ type: "call", id: "plan", name: "TodoWrite", input: { todos: [
      { content: "首次记录已经完成", status: "completed" },
      { content: "正在执行的步骤", status: "in_progress" },
      { content: "尚未开工的第三步", status: "pending" },
      { content: "尚未开工的第四步", status: "pending" },
    ] } })] : trace(final, updates)) as never }],
    [session],
    [],
  );
}

function App() {
  const [phase, setPhase] = useState(() => localStorage.getItem("native-work-phase") === "final");
  const [empty, setEmpty] = useState(false);
  const [planSnapshot, setPlanSnapshot] = useState(false);
  const [updates, setUpdates] = useState(() => Number(localStorage.getItem("native-work-updates") ?? 0));
  const items = useMemo(() => empty ? [] : conversation(phase, updates, planSnapshot), [empty, phase, updates, planSnapshot]);
  const descriptors = useMemo<InspectorDescriptor<null>[]>(() => [{
    id: "native-work",
    title: "子智能体",
    icon: <Robot size={15} />,
    render: () => <NativeWorkInspector items={items} status={phase && !planSnapshot ? "done" : "running" as TaskStatus} />,
  }], [items, phase, planSnapshot]);
  const finish = () => {
    localStorage.setItem("native-work-phase", "final");
    setPhase(true);
  };
  return <div style={{ height: "100vh", display: "flex", overflow: "hidden" }}><InspectorHost contextKey="native-work-fixture" descriptors={descriptors} context={null} defaultVisible={false}>
    {(inspector) => <main style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto" }}>
      <section style={{ padding: 24 }}>
        <h1>原生子工作 Inspector fixture</h1>
        <button type="button" onClick={() => inspector.openTab("native-work")}>打开子智能体</button>
        <button type="button" onClick={finish}>完成运行项</button>
        <button type="button" onClick={() => setEmpty((value) => !value)}>切换空状态</button>
        <button type="button" onClick={() => { setEmpty(false); setPlanSnapshot((value) => !value); }}>切换计划快照</button>
        <button type="button" onClick={() => { localStorage.setItem("native-work-updates", String(updates + 1)); setUpdates(updates + 1); }}>推送执行进展</button>
        {inspector.toggleButton}
        <div aria-label="主会话">{items.map((item) => item.kind === "agent" && <AgentTurnBody key={item.id} segments={item.segments} running={!phase} />)}</div>
      </section>
      {inspector.visible && <aside style={{ width: 320, minWidth: 0 }}>{/* InspectorHost renders its panel beside children. */}</aside>}
    </main>}
  </InspectorHost></div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
