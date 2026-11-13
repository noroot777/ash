import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const task = { id: "quote", projectId: "p", title: "引用气泡", mode: "single", agentType: "codex", status: "done" } as Task;
const longQuote = "codex 有些工具调用 ash 实时看不到，算速度时会把它们的耗时当成模型在出字，审查连续两轮因此打回；按审查要求只要凭据不全就不计的话，大部分回合都不会显示速度。codex 自己写在磁盘上的运行记录里，每一次工具调用的起止都有。";
// 「添加到对话」写进对话框的就是这个形状：每行 `> `，引文和回复之间空一行。
const items: ConversationItem[] = [
  { kind: "user", id: "long", text: `> ${longQuote}\n\n改成回合结束时读 codex 自己写的运行记录来算`, attachments: [], at: "2026-11-13T06:00:00.000Z" },
  { kind: "user", id: "short", text: "> 要不要我在它的说明里补一句？\n> 它正在跑，补了也不会打断它。\n\n补。你是怎么做到补了但是不打断它的", attachments: [], at: "2026-11-13T06:01:00.000Z" },
  { kind: "user", id: "fenced", text: "跑一下这个：\n```\n> npm run build\n```", attachments: [], at: "2026-11-13T06:02:00.000Z" },
];

createRoot(document.getElementById("root")!).render(<StrictMode>
  <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <ConversationFeed task={task} items={items} sessions={[]} questionHistory={[]} loading={false} error={null} />
  </div>
</StrictMode>);
