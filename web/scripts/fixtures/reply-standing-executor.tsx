import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { TaskReplyDraftProvider } from "../../src/task-detail/TaskReplyDrafts.tsx";
import "../../src/styles/global.css";

const BASE: Task = {
  id: "task-standing",
  projectId: "project-1",
  groupId: null,
  parentId: null,
  title: "常设执行器",
  body: "常设执行器",
  mode: "single",
  status: "idle",
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  agentType: "codex",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function Ash() {
  // 服务端那一半用本地 state 替身：PATCH 成功后任务字段跟着变，正是真实回流的形状。
  const [task, setTask] = useState<Task>(BASE);
  const [log, setLog] = useState<string[]>([]);
  const record = (line: string) => setLog((current) => [...current, line]);
  // ?slow=1：第一次写回慢 1200ms，用来验「连着改两次」不会被先发后到的旧响应盖回去。
  const slowFirst = new URLSearchParams(window.location.search).get("slow") === "1";
  const saves = useRef(0);

  return (
    // 上方留白是给浮层的：@ 选择器锚在输入框上沿往上弹，贴着视口顶会被裁掉。
    <main style={{ width: 760, margin: "360px auto 40px" }}>
      <ReplyBox
        task={task}
        hasConversation
        onSend={async (text, _attachments, options) => {
          record(`send:${text}|agent=${options.agent ?? "-"}|model=${options.model ?? "-"}|effort=${options.reasoningEffort ?? "-"}`);
          return { started: true };
        }}
        onStandingExecutorChange={async (next) => {
          const call = ++saves.current;
          const shape = `${next.agentType}|model=${next.model ?? "-"}|effort=${next.reasoningEffort ?? "-"}`;
          record(`start${call}:${shape}`);
          if (slowFirst && call === 1) await new Promise((resolve) => { setTimeout(resolve, 1200); });
          record(`done${call}:${shape}`);
          setTask((current) => ({ ...current, ...next }));
        }}
      />
      <ul id="log">
        {log.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
      </ul>
      <p id="task-config">{`task:${task.agentType}|model=${task.model ?? "-"}|effort=${task.reasoningEffort ?? "-"}`}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <TaskReplyDraftProvider>
    <Ash />
  </TaskReplyDraftProvider>,
);
