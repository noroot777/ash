import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Robot } from "@phosphor-icons/react";
import type { AgentEvent, Session, TaskStatus } from "@ash/shared";
import { InspectorHost, type InspectorDescriptor } from "../../src/inspector/index.ts";
import { NativeWorkInspector } from "../../src/task-detail/NativeWorkInspector.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const session = {
  id: "native-work-session",
  taskId: "native-work-task",
  agentType: "codex",
  role: "single",
  executor: "codex@fixture",
  startedAt: "2026-09-08T00:00:00.000Z",
  endedAt: null,
} as unknown as Session;

const longText = "需要检查一个不会自然换行的超长说明：" + "NATIVE_WORK_INSPECTOR_".repeat(35);
const native = (nativeWork: NonNullable<Extract<AgentEvent, { kind: "tool" }>["nativeWork"]>) => ({
  at: "2026-09-08T00:00:01.000Z",
  turnStartedAt: session.startedAt,
  event: { kind: "tool", name: "fixture", nativeWork } satisfies AgentEvent,
});

function trace(final: boolean) {
  const events = [
    native({ type: "call", id: "agent-run-call", name: "spawn_agent", input: { description: "运行中的资料搜集", prompt: longText, model: "gpt-fixture" } }),
    native({ type: "result", id: "agent-run-call", result: JSON.stringify({ agent_id: "agent-run" }), failed: false }),
    native({ type: "call", id: "child-task-create", parentId: "agent-run", name: "TaskCreate", input: { subject: "核对浏览器状态", description: longText } }),
    native({ type: "result", id: "child-task-create", result: JSON.stringify({ task: { id: "17" } }), failed: false }),
    native({ type: "call", id: "agent-done-call", name: "agent", input: { description: "已完成的结构检查", prompt: "检查数据结构" } }),
    native({ type: "result", id: "agent-done-call", result: "同步执行完成", failed: false }),
    native({ type: "call", id: "agent-fail-call", name: "spawn_agent", input: { description: "启动失败的执行者", prompt: "模拟失败" } }),
    native({ type: "result", id: "agent-fail-call", result: "fixture launch failed", failed: true }),
    native({ type: "agent", id: "agent-stopped", title: "用户停止的执行者", status: "stopped", message: "由用户停止" }),
    native({ type: "agent", id: "agent-unknown", title: "旧记录状态未知", status: "unknown", message: "没有最终状态" }),
  ];
  if (final) events.push(
    native({ type: "agent", id: "agent-run", title: "运行中的资料搜集", status: "completed", result: "刷新后仍应保留的完成结果" }),
    native({ type: "call", id: "child-task-update", parentId: "agent-run", name: "TaskUpdate", input: { taskId: "17", status: "completed", owner: "agent-run" } }),
    native({ type: "result", id: "child-task-update", result: "updated", failed: false }),
  );
  return events;
}

function conversation(final: boolean) {
  return buildConversationItems(
    [{ session, output: "fixture conversation", trace: trace(final) as never }],
    [session],
    [],
  );
}

function App() {
  const [phase, setPhase] = useState(() => localStorage.getItem("native-work-phase") === "final");
  const [empty, setEmpty] = useState(false);
  const items = useMemo(() => empty ? [] : conversation(phase), [empty, phase]);
  const descriptors = useMemo<InspectorDescriptor<null>[]>(() => [{
    id: "native-work",
    title: "子智能体",
    icon: <Robot size={15} />,
    render: () => <NativeWorkInspector items={items} status={phase ? "done" : "running" as TaskStatus} />,
  }], [items, phase]);
  const finish = () => {
    localStorage.setItem("native-work-phase", "final");
    setPhase(true);
  };
  return <InspectorHost contextKey="native-work-fixture" descriptors={descriptors} context={null} defaultVisible={false}>
    {(inspector) => <main style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto" }}>
      <section style={{ padding: 24 }}>
        <h1>原生子工作 Inspector fixture</h1>
        <button type="button" onClick={() => inspector.openTab("native-work")}>打开子智能体</button>
        <button type="button" onClick={finish}>完成运行项</button>
        <button type="button" onClick={() => setEmpty((value) => !value)}>切换空状态</button>
        {inspector.toggleButton}
      </section>
      {inspector.visible && <aside style={{ width: 320, minWidth: 0 }}>{/* InspectorHost renders its panel beside children. */}</aside>}
    </main>}
  </InspectorHost>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
