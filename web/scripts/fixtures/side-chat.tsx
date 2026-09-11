import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { Chats, Info } from "@phosphor-icons/react";
import { InspectorHost } from "../../src/inspector/index.ts";
import { SideChatPane } from "../../src/side-chat/SideChatPane.tsx";
import "../../src/styles/global.css";

function Fixture() {
  const [taskId, setTaskId] = useState("parent");
  const [status, setStatus] = useState("running");
  const task = { id: taskId, projectId: "p", title: "实现任务消息回传", mode: "single", agentType: "codex", executorId: "side-codex", status } as Task;
  return <div style={{ display: "flex", height: "100vh" }}><InspectorHost contextKey={`fixture:${taskId}`} descriptors={[
    { id: "info", title: "信息", icon: <Info size={14} />, defaultOpen: true, render: () => <p>任务信息</p> },
    { id: "side-chat", title: "侧聊", icon: <Chats size={14} />, defaultOpen: true, render: () => <SideChatPane key={task.id} task={task} /> },
  ]} context={task} tabPolicy={{ stateKey: status, requiredTabId: "info", defaultOpenTabIds: ["info", "side-chat"], defaultActiveTabId: "info", preserveActiveTabIds: ["side-chat"] }}>
    {({ openTab }) => <main style={{ padding: 24, flex: 1 }}><h2>实现任务消息回传</h2><p>主任务正在实现方案 A，并记录验证结果。</p><p>侧聊中可以继续对比方案，把结论送回这里。</p><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button onClick={() => openTab("side-chat")}>打开侧聊</button><button onClick={() => setStatus((value) => value === "running" ? "done" : "running")}>切换主任务状态</button><button onClick={() => setTaskId((value) => value === "parent" ? "other" : "parent")}>切换主任务</button></div><output data-testid="parent-state">{taskId} · {status}</output></main>}
  </InspectorHost></div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
