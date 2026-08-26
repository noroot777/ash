import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task } from "@ash/shared";
import { SESSION_LOST_NOTE } from "@ash/shared/session-notes";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "codex",
  role: "main",
  executor: "codex@cpa·gpt-5.6-sol",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  cliSessionId: "01a03152-a54f",
  resumeCommand: "codex resume 01a03152-a54f",
  usage: { input: 1_000, output: 200, cacheRead: 2_000, cacheWrite: 0, reasoning: 100, costUsd: null, turns: 1 },
  context: { used: 28_000, window: 100_000, windowEstimated: false },
  startedAt: "2026-08-10T03:23:00.000Z",
  endedAt: "2026-08-10T14:04:00.000Z",
} as unknown as Session;

const task = {
  id: "t1",
  title: "自由工作流 Inspector",
  body: "",
  status: "done",
  agentType: "codex",
  executorLabel: "codex@cpa·gpt-5.6-sol",
} as unknown as Task;

const turn = (kind: string, text: string, at: string) =>
  `${JSON.stringify({ t: kind, text, at })}`;

// 图二 + 图三那一串：一段说话被各种系统通告反复劈开。
const output = [
  "我会直接实现到现有自由工作流 Inspector，并严格保留当前卡片、颜色、间距等 UI：只补真实事件字段、时间展示、审查节点点击联动与底部整体收起/弹出行为。",
  turn("system", "已预约完成后审查：5.5审查 · 逻辑检查 · 自动复审 1 轮。", "2026-08-10T03:27:00.000Z"),
  "数据方案已经收敛：复用现有自由工作流事件表记录每次主任务回合的开始/结束，不新增数据库列；审查者旁路回合不会被误记成“任务执行”。",
  turn("system", "自由工作流第 2 轮审查通过（5.5审查）。", "2026-08-10T05:51:00.000Z"),
  turn("system", "验收阶段更新：验收完成（accepted）", "2026-08-10T05:52:00.000Z"),
  turn("system", "自由工作流合并&清理完成：已安全合并 ash/mpgFKC41 → feat/free-pipeline，并清理任务 worktree与分支", "2026-08-10T05:52:30.000Z"),
  turn("system", "升级迁移：上一版「合并&清理」已记录合并完成，验收标记已补上（合并区间无从考证，未伪造）。", "2026-08-10T05:52:40.000Z"),
  "实现已落到产品代码，现有视觉类名和卡片样式都保留。",
  turn("system", "自由工作流第 3 轮审查未通过，意见已发回会话；修复完成后自动复审。", "2026-08-10T06:10:00.000Z"),
  // 会话轮换旁注：中性事实（这条 CLI 会话接不回了），不是本回合失败。渲染上有两条硬要求
  // —— 不能是红的，也不能把 Markdown 标记原样露出来（服务端文案见 @ash/shared/session-notes）。
  turn("system", SESSION_LOST_NOTE, "2026-08-10T06:10:30.000Z"),
  "收到审查意见，开始修复。",
  // ash 自己插在 agent 输出里的注记走 markdown 引用块，视觉上要跟系统旁注同档。
  "\n> 正在压缩上下文…\n",
  "\n> 上下文已压缩。\n",
  turn("user", "这块再改一下，右边留白太挤了", "2026-08-10T06:30:00.000Z"),
  "好的，我调整右侧留白。",
].join("\n");

const items = buildConversationItems([{ session, output, trace: [] }], [session], [
  // 回合边界是另一档：它确实是「这里换了一段」，所以保留横贯的分隔线。
  {
    kind: "server",
    id: "live:done",
    event: {
      type: "agent.event",
      taskId: "t1",
      sessionId: "s1",
      role: "main",
      agentType: "codex",
      event: { kind: "done", exitStatus: 0 },
    },
  },
  {
    kind: "server",
    id: "live:text",
    event: {
      type: "agent.event",
      taskId: "t1",
      sessionId: "s1",
      role: "main",
      agentType: "codex",
      event: { kind: "text", text: "又被叫醒了，继续。" },
    },
  },
  // 复现刷新前的实时态：旁注到达后同一回合又报了一条工具事件。工具仍并回当前回合，
  // 统计条与执行过程都留在旁注之前，实时结构与刷新后的落盘结构一致。
  {
    kind: "server",
    id: "live:note",
    event: {
      type: "agent.event",
      taskId: "t1",
      sessionId: "s1",
      role: "main",
      agentType: "codex",
      event: { kind: "system", text: "已预约完成后审查：grok4.6 · 逻辑检查 · 自动复审 1 轮。", at: "2026-08-10T07:02:00.000Z" },
    },
  },
  {
    kind: "server",
    id: "live:tool-after-note",
    event: {
      type: "agent.event",
      taskId: "t1",
      sessionId: "s1",
      role: "main",
      agentType: "codex",
      event: { kind: "tool", name: "exec", detail: "检查同类时间布局" },
    },
  },
] as never);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <ConversationFeed task={task} items={items} sessions={[session]} loading={false} error={null} />
    </div>
  </StrictMode>,
);
