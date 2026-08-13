import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task } from "@harness/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

// 就地验证跑在被验任务自己的会话上（role=single，同一个执行器），所以「我在做需求」
// 和「我在验刚才那份产物」两种发言原本长得一模一样 —— 这份 fixture 就是那种最难分的
// 情形：一条会话、一个执行器、中间只隔着一行旁注。
const session = {
  id: "s1",
  taskId: "t1",
  agentType: "codex",
  role: "single",
  executor: "codex@cpa·gpt-5.6-sol",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  startedAt: "2026-08-10T03:23:00.000Z",
  endedAt: "2026-08-10T14:04:00.000Z",
} as unknown as Session;

// 自由派审的独立审查回合另开一条会话，身份写在 role 上，没有轮次号。
const reviewSession = {
  id: "s2",
  taskId: "t1",
  agentType: "claude",
  role: "reviewer",
  executor: "claude@5.5审查",
  model: "claude-opus-5",
  reasoningEffort: "high",
  startedAt: "2026-08-10T15:00:00.000Z",
  endedAt: "2026-08-10T15:12:00.000Z",
} as unknown as Session;

const task = {
  id: "t1",
  title: "会话里区分审查者",
  body: "",
  status: "done",
  agentType: "codex",
  executorLabel: "codex@cpa·gpt-5.6-sol",
} as unknown as Task;

// 回合哨兵行:落盘格式是 \x1e + 一行 JSON(见 shared 的 parseSessionOutput)。
const turn = (kind: string, text: string, at: string) =>
  `\x1e${JSON.stringify({ t: kind, text, at })}`;

const output = [
  "徽标、旁注竖条和头像都改完了，气泡本体没动。",
  turn("system", "第 2 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-10T03:40:00.000Z"),
  "起了无头浏览器复核，盾形头像和「审查者 · 第 2 轮」都在，但打回那条旁注仍是灰的。",
  turn("system", "第 2 轮验证未通过，意见已发回会话；修复完成后自动复验。", "2026-08-10T04:10:00.000Z"),
  "收到，改成红色竖条。",
].join("\n");

const reviewOutput = "另开一条会话做完成后审查：改动范围和验收标准对得上，通过。";

// run 事件是会话里唯一能把审查者的发言认出来的信号（它同时落 trace、随 SSE 直播）。
const trace = [
  { at: "2026-08-10T03:23:01.000Z", turnStartedAt: "2026-08-10T03:23:00.000Z", event: { kind: "run", model: "gpt-5.6-sol", reasoningEffort: "xhigh" } },
  { at: "2026-08-10T03:40:01.000Z", turnStartedAt: "2026-08-10T03:40:00.000Z", event: { kind: "run", model: "gpt-5.6-sol", reasoningEffort: "xhigh", verifyRound: 2 } },
  { at: "2026-08-10T04:10:01.000Z", turnStartedAt: "2026-08-10T04:10:00.000Z", event: { kind: "run", model: "gpt-5.6-sol", reasoningEffort: "xhigh" } },
];

const items = buildConversationItems(
  [
    { session, output, trace: trace as never },
    { session: reviewSession, output: reviewOutput, trace: [] },
  ],
  [session, reviewSession],
  [],
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <ConversationFeed task={task} items={items} sessions={[session]} loading={false} error={null} />
    </div>
  </StrictMode>,
);
