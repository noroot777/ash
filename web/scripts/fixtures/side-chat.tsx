import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { Chats, Info } from "@phosphor-icons/react";
import { InspectorHost } from "../../src/inspector/index.ts";
import { ConversationSelection } from "../../src/side-chat/ConversationSelection.tsx";
import { SideChatPane } from "../../src/side-chat/SideChatPane.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const longSelection = `超长主会话原文：${"完整引用不能截断。".repeat(900)}`;
const agentMarkdown = "侧聊中可以继续对比方案，\n把结论送回这里。\n\n```ts\nconst selected = true;\n```";

function Fixture() {
  const [taskId, setTaskId] = useState("parent");
  const [status, setStatus] = useState("running");
  const task = { id: taskId, projectId: "p", title: "实现任务消息回传", mode: "single", agentType: "codex", executorId: "side-codex", status } as Task;
  const items: ConversationItem[] = [
    { kind: "user", id: `${taskId}-user`, text: "主任务正在实现方案 A，并记录验证结果。", attachments: [], at: "2026-09-14T08:00:00.000Z" },
    { kind: "agent", id: `${taskId}-agent`, sessionId: `${taskId}-session`, label: "Codex", at: "2026-09-14T08:00:01.000Z", endedAt: "2026-09-14T08:00:02.000Z", markdown: agentMarkdown, segments: [{ id: `${taskId}-segment`, markdown: agentMarkdown, events: [], attachments: [] }] },
  ];
  return <div style={{ display: "flex", height: "100vh" }}><InspectorHost contextKey={`fixture:${taskId}`} descriptors={[
    { id: "info", title: "信息", icon: <Info size={14} />, defaultOpen: true, render: () => <p>任务信息</p> },
    { id: "side-chat", title: "侧聊", icon: <Chats size={14} />, defaultOpen: true, render: () => <SideChatPane key={task.id} task={task} /> },
  ]} context={task} tabPolicy={{ stateKey: status, requiredTabId: "info", defaultOpenTabIds: ["info", "side-chat"], defaultActiveTabId: "info", preserveActiveTabIds: ["side-chat"] }}>
    {({ openTab }) => <main style={{ padding: 24, flex: 1, minWidth: 0, overflow: "auto" }}>
      <h2>{task.title}</h2>
      <ConversationSelection taskId={task.id} onAsk={() => openTab("side-chat")}>
        <div style={{ height: 360 }}>
          <ConversationFeed task={task} items={items} sessions={[]} questionHistory={[]} loading={false} error={null} footer={<>
            <p data-testid="selection-other">{taskId === "parent" ? "当前属于主任务 parent 的会话内容。" : "当前属于主任务 other 的会话内容。"}</p>
            <details data-testid="long-selection-details"><summary>展开超长选文测试</summary><p data-testid="selection-long" style={{ maxHeight: 140, overflow: "auto" }}>{longSelection}</p></details>
          </>} />
        </div>
      </ConversationSelection>
      <label data-testid="non-conversation-label">主任务控制标签 <input aria-label="主任务消息输入" defaultValue="主输入里的文字不能成为引用" /></label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button onClick={() => openTab("side-chat")}>打开侧聊</button>
        <button onClick={() => setStatus((value) => value === "running" ? "done" : "running")}>切换主任务状态</button>
        <button onClick={() => setTaskId((value) => value === "parent" ? "other" : "parent")}>切换主任务</button>
      </div>
      <output data-testid="parent-state">{taskId} · {status}</output>
      <button type="button" data-testid="outside-target">页面空白处</button>
    </main>}
  </InspectorHost></div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
