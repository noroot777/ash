import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, Task } from "@ash/shared";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { TaskComposerPanel, type ComposerDraft } from "../../src/composer/TaskComposerPanel.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import { snapshotConversationFork } from "../../src/task-detail/conversationFork.ts";
import "../../src/styles/global.css";

const project = { id: "p1", name: "ash", repoPath: "/tmp/ash", workflowId: null, health: { exists: true, isRepo: false } } as ProjectView;
const task = { id: "source", projectId: "p1", title: "对比两种方案", body: "研究方案 A 与 B", mode: "single", status: "done" } as Task;
const reply = (id: string, markdown: string, done = true): ConversationItem => ({
  kind: "agent", id, sessionId: "s1", label: "Codex", markdown,
  at: "2026-09-10T01:00:00Z", endedAt: done ? "2026-09-10T01:01:00Z" : null,
  segments: [{ id, markdown, events: [], attachments: id === "a1" ? ["/tmp/earlier.png"] : [] }],
});
const items: ConversationItem[] = [
  reply("a1", "方案 A 实现简单，适合先做原型。"),
  { kind: "user", id: "u2", text: "改为方案 C（后续内容）", attachments: ["/tmp/later.png"] },
  reply("a2", "方案 C 的后续结论"), reply("streaming", "正在生成的回复", false),
];

function Fixture() {
  const [view, setView] = useState<"feed" | "composer">("feed");
  const [seed, setSeed] = useState<ComposerDraft | null>(null);
  const [created, setCreated] = useState<Task | null>(null);
  const [notice, setNotice] = useState("");
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <nav><button onClick={() => { setSeed(null); setView("composer"); }}>普通新建</button>
      <button onClick={() => setView("feed")}>返回会话</button>
      <button onClick={() => setView("composer")}>回到草稿</button></nav>
    {view === "feed" ? <ConversationFeed task={task} items={items} sessions={[]} loading={false} error={null}
      onForkReply={(id) => { setSeed(snapshotConversationFork(task, items, id)); setView("composer"); }} />
      : <TaskComposerPanel project={project} groups={[]} mode="single" onModeChange={() => {}}
        initialDraft={seed} onDraftSeeded={() => setSeed(null)} onCancel={() => setView("feed")}
        onCreated={(next) => { setCreated(next); setSeed(null); setView("feed"); }}
        onCreateGroup={async () => { throw new Error("unused"); }} notify={setNotice} />}
    <output data-testid="notice">{notice}</output>
    {created && <output data-testid="created">{JSON.stringify(created)}</output>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><DraftProvider><Fixture /></DraftProvider></StrictMode>);
