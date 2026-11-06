import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import "../../src/styles/global.css";

/**
 * 扣住第一次写回，直到用户**下一次点击**被页面处理完才放行。「连着改两次」「改完立刻发」
 * 两条要的是「第二下动作发生时第一次写回还在飞」——从前靠第一次写回慢 1200ms 去赌，满载时
 * 点第二下本身就可能超过 1200ms，那样两条用例都退化成串行的平凡情况。这里改成按事实放行：
 * 第二下 click 派发完（它的处理函数已经跑过、该排的写回或发送已经排上），下一个任务里再放。
 * 只认 click：中间夹着的 Esc、往输入框里填字都不算「下一下动作」。
 */
function untilNextClick(): Promise<void> {
  return new Promise((resolve) => {
    document.addEventListener("click", () => {
      // 捕获阶段先于目标上的处理函数：排到下一个任务再放，等这一下点击整个处理完。
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
      channel.port2.postMessage(null);
    }, { capture: true, once: true });
  });
}

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
  const params = new URLSearchParams(window.location.search);
  // ?slow=1：第一次写回扣到用户下一次点击之后（验「连着改两次」和「改完立刻发」两条时序）。
  // ?fail=1：第一次写回直接失败（验失败时不静默按旧配置发出去）。
  const slowFirst = params.get("slow") === "1";
  const failFirst = params.get("fail") === "1";
  const saves = useRef(0);
  // 「服务端那一份」：PATCH 一返回它就是新的，随后的 reply 读到的就是它。UI 的 task
  // state 是它的回流，React 批处理会晚一拍 —— 拿 state 当服务端会把「已经写好了」误
  // 读成「还没写」，那是夹具的观测偏差，不是产品行为。
  const server = useRef(BASE);

  return (
    // 上方留白是给浮层的：@ 选择器锚在输入框上沿往上弹，贴着视口顶会被裁掉。
    <main style={{ width: 760, margin: "360px auto 40px" }}>
      <ReplyBox
        task={task}
        hasConversation
        onSend={async (text, _attachments, options) => {
          const now = server.current;
          record(`send:${text}|task=${now.agentType}/${now.model ?? "-"}`
            + `|override=${options.agent ?? "-"}/${options.model ?? "-"}/${options.reasoningEffort ?? "-"}`);
          return { started: true };
        }}
        onStandingExecutorChange={async (next) => {
          const call = ++saves.current;
          const shape = `${next.agentType}|model=${next.model ?? "-"}|effort=${next.reasoningEffort ?? "-"}`;
          record(`start${call}:${shape}`);
          if (slowFirst && call === 1) await untilNextClick();
          if (failFirst && call === 1) {
            record(`fail${call}:${shape}`);
            throw new Error("写回失败（夹具）");
          }
          server.current = { ...server.current, ...next };
          record(`done${call}:${shape}`);
          setTask(server.current);
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
  <DraftProvider>
    <Ash />
  </DraftProvider>,
);
