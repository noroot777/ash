import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const session = {
  id: "system-notices",
  taskId: "t1",
  agentType: "codex",
  role: "single",
  executor: "codex@local",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  startedAt: "2026-09-01T05:00:00.000Z",
  endedAt: "2026-09-01T06:30:00.000Z",
} as unknown as Session;

const task = {
  id: "t1",
  title: "系统提示完整方案",
  body: "",
  status: "done",
  agentType: "codex",
  executorLabel: "codex@local",
} as unknown as Task;

const turn = (kind: string, text: string, at: string, extra: Record<string, string> = {}) =>
  `\x1e${JSON.stringify({ t: kind, text, at, ...extra })}`;

const conflict = [
  "【验收未通过 · 需要你解冲突】",
  "用户点了「验收通过」，后端合并任务分支到 `main` 时发生冲突，已经安全回滚（merge --abort），目标分支一个字没动。",
  "",
  "冲突文件：",
  "- server/package.json",
  "- web/src/App.tsx",
  "",
  "请你来解决：",
  "1. 在自己的工作目录合并 `main`，逐个解决冲突并提交；",
  "2. 自查完成后告诉用户重新验收。",
].join("\n");

const output = [
  "实现已经完成，准备验收。",
  turn("system", "开始验收：准备安全合并到 main；冲突时只报告并回滚。", "2026-09-01T05:10:00.000Z"),
  turn("system", "验收未完成：合并任务分支到 main 发生冲突；未强制合并。", "2026-09-01T05:10:01.000Z"),
  turn("system", "冲突交接：已叫醒该任务去解冲突，完成后重新点验收即可。", "2026-09-01T05:10:02.000Z"),
  turn("user", conflict, "2026-09-01T05:10:03.000Z", { by: "system" }),
  "冲突已经解决并提交。",
  turn("system", "已预约完成后审查：5.5审查 · 逻辑检查。", "2026-09-01T05:30:00.000Z"),
  turn("system", "验收阶段更新：验收完成（accepted）", "2026-09-01T05:40:00.000Z"),
  turn("system", "冲突交接失败：没能叫醒该任务解冲突。", "2026-09-01T05:50:00.000Z"),
  turn("system", "本回合没有交卷：产物仍保留，可直接重试。", "2026-09-01T06:00:00.000Z", { level: "notice" }),
  turn("system", "〔系统〕原工作目录(worktree 与分支)已不存在，已重建为空目录并提醒 agent 重新确认现状", "2026-09-01T06:10:00.000Z"),
].join("\n");

const items = buildConversationItems([{ session, output, trace: [] }], [session], [{
  kind: "server",
  id: "boundary",
  event: {
    type: "agent.event",
    taskId: "t1",
    sessionId: session.id,
    role: "single",
    agentType: "codex",
    event: { kind: "done", exitStatus: 0 },
  },
}] as never);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <ConversationFeed task={task} items={items} sessions={[session]} loading={false} error={null} />
    </div>
  </StrictMode>,
);
