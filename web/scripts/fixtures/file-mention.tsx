import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import "../../src/styles/global.css";

// `@` 引用文件的夹具：一个能说话的普通任务 + 一个把发出去的正文记下来的 onSend。
// 判定全在「菜单里有什么」和「选完之后正文变成什么」，所以服务端那一半用 page.route
// 假掉就够（见 test-file-mention-dom.mjs）。

const TASK: Task = {
  id: "task-mention",
  projectId: "project-1",
  groupId: null,
  parentId: null,
  title: "引用文件",
  body: "引用文件",
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
  const [log, setLog] = useState<string[]>([]);
  return (
    // 上方留白是给浮层的：菜单锚在输入框上沿往上弹，贴着视口顶会被裁掉。
    <main style={{ width: 760, margin: "360px auto 40px" }}>
      <ReplyBox
        task={TASK}
        hasConversation
        onSend={async (text) => {
          setLog((current) => [...current, `send:${text}`]);
          return { started: true };
        }}
      />
      <ul id="log">
        {log.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <DraftProvider>
    <Ash />
  </DraftProvider>,
);
