import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "claude",
  role: "main",
  executor: "claude@ccb",
  model: "claude-opus-5",
  reasoningEffort: "high",
  cliSessionId: "f753c251-1839-4d0e-9d2a-3b71c0c5e412",
  resumeCommand: "cd /tmp/demo && claude --resume f753c251-1839-4d0e-9d2a-3b71c0c5e412",
  usage: { input: 1_000, output: 200, cacheRead: 2_000, cacheWrite: 0, reasoning: 100, costUsd: null, turns: 1 },
  context: { used: 28_000, window: 100_000, windowEstimated: false },
  startedAt: "2026-08-10T03:23:00.000Z",
  endedAt: "2026-08-10T04:04:00.000Z",
} as unknown as Session;

// 独立派审的审查会话。它的发言会被收进审查卡，卡头已经把身份和时间说过一遍，卡里首条
// 气泡于是头部一个元素都不剩（AgentMessage 的 headless）——复制入口这时落在尾栏，
// 正是用户截图里那颗「复制这条回复」的处境。
const reviewSession = {
  id: "s2",
  taskId: "t1",
  agentType: "claude",
  role: "reviewer",
  executor: "claude@ccb",
  model: "claude-opus-5",
  reasoningEffort: "high",
  cliSessionId: "9c41b7ad-2210-44e6-9a0f-0d61c2f5aa30",
  resumeCommand: "cd /tmp/demo && claude --resume 9c41b7ad-2210-44e6-9a0f-0d61c2f5aa30",
  usage: { input: 800, output: 120, cacheRead: 400, cacheWrite: 0, reasoning: 40, costUsd: null, turns: 1 },
  context: { used: 12_000, window: 100_000, windowEstimated: false },
  startedAt: "2026-08-10T04:10:00.000Z",
  endedAt: "2026-08-10T04:12:00.000Z",
} as unknown as Session;

const task = {
  id: "t1",
  title: "复制反馈",
  body: "",
  status: "done",
  agentType: "claude",
  executorLabel: "claude@ccb",
} as unknown as Task;

const turn = (kind: string, text: string, at: string) => `\u001e${JSON.stringify({ t: kind, text, at })}`;

// 一条被系统旁注劈开的发言：续写段的头部只剩用时，复制入口仍在头部；审查卡里的首条
// 发言才是头部空空、复制入口落到尾栏的那种。两种都要有反馈。
const output = [
  "先探索一下现有结构。",
  turn("user", "这块再改一下，右边留白太挤了", "2026-08-10T03:30:00.000Z"),
  "好的，我调整右侧留白。",
  turn("system", "已预约完成后审查：逻辑检查 · 自动复审 1 轮。", "2026-08-10T03:40:00.000Z"),
  "前端构建全过（含所有 DOM 测试与约定检查）。",
  turn("system", "自由工作流第 1 轮审查开始（逻辑检查）。", "2026-08-10T04:09:00.000Z"),
].join("\n");

const reviewOutput = "审查结论：改动符合预期，四处复制入口都有就地反馈。";

const items = buildConversationItems(
  [
    { session, output, trace: [] },
    // trace 里的 run 事件带着轮号：审查卡靠它认出「这条发言属于第 1 轮」，卡内首条
    // 气泡才会被判成 lead（头部整条省掉）。
    {
      session: reviewSession,
      output: reviewOutput,
      trace: [{ at: "2026-08-10T04:10:00.000Z", event: { kind: "run", verifyRound: 1 } }],
    },
  ],
  [session, reviewSession],
  [] as never,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <ConversationFeed task={task} items={items} sessions={[session, reviewSession]} loading={false} error={null} />
    </div>
  </StrictMode>,
);
