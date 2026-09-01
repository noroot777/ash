import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import { TeamFeed } from "../../src/team/TeamFeed.tsx";
import "../../src/styles/global.css";

const task = {
  id: "review-system-prompts",
  title: "审查系统提示",
  body: "",
  status: "done",
  mode: "single",
  agentType: "codex",
} as unknown as TaskListItem;

const reviewPrompt: ConversationItem = {
  kind: "user",
  id: "review-prompt",
  text: "【自由工作流审查未通过 · 第 1 轮】\n请先完整读取 report.md，再按报告修复并调用 complete_task。",
  at: "2026-09-02T02:00:00.000Z",
  bySystem: true,
  attachments: [],
};

const userMessage: ConversationItem = {
  kind: "user",
  id: "user-message",
  text: "这是普通用户消息。",
  at: "2026-09-02T02:01:00.000Z",
  attachments: [],
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, minHeight: "100vh", padding: 24, background: "var(--canvas)" }}>
      <section data-surface="task" style={{ minWidth: 0, height: 520, background: "var(--panel)" }}>
        <ConversationFeed task={task} items={[reviewPrompt, userMessage]} sessions={[]} loading={false} error={null} />
      </section>
      <section data-surface="team" style={{ minWidth: 0, height: 520, background: "var(--panel)" }}>
        <TeamFeed
          task={{ ...task, mode: "team" } as unknown as Task}
          rows={[
            { kind: "conv", key: reviewPrompt.id, item: reviewPrompt },
            { kind: "conv", key: userMessage.id, item: userMessage },
          ]}
          workers={[]}
          onOpenWorker={() => undefined}
          onAskLead={() => undefined}
          delegatingIds={new Set()}
          indicatorForTask={() => null}
        />
      </section>
    </main>
  </StrictMode>,
);
