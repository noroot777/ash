import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import { outputEvent, wakePayload } from "./monitor-wake-data.ts";
import "../../src/styles/global.css";

// 一轮自由派审正在跑：审查者说过两回合（中间挂过一次哨兵、被它叫醒），最新那一回合还在说、正在跑
// 一条命令。`?phase=question|monitor|checkpoint` 把任务换成停在那儿等着的样子；`?opener=1` 接上
// 右侧审查格（出了结论点气泡去那一轮）；`?earlier=1` 同一回合之前已经审过一场（重新派审）。window 上的
// 几个钩子推进这一轮：再冒半句、整段换成另一句、出结论。
const params = new URLSearchParams(location.search);
const started = "2026-11-14T08:22:00.000Z";
const reviewer = (id: string, markdown: string, endedAt: string | null, events: { kind: "tool"; label: string; detail: string }[] = []) => ({
  kind: "agent" as const, id, sessionId: "rs", label: "codex@nodemach", agentType: "codex", reviewer: { round: 1 },
  at: started, endedAt, markdown, run: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
  segments: [
    { id: `${id}:0`, markdown, events: [], attachments: [] },
    ...(events.length ? [{ id: `${id}:1`, markdown: "", events, attachments: [] }] : []),
  ],
});
const bash = (command: string) => ({ kind: "tool" as const, label: "Bash", detail: JSON.stringify({ command }) });
const wake = wakePayload([outputEvent]);

// 同一份产出之前那一场：开始、审查者说过话、通过。
const earlier: ConversationItem[] = [
  { kind: "event", id: "e-start", text: "自由工作流第 1 轮审查开始：老审查 · 逻辑检查。", at: "2026-11-14T08:21:10.000Z", aside: true, variant: "note" },
  {
    kind: "agent", id: "e-say", sessionId: "rs0", label: "codex@old", agentType: "codex", reviewer: { round: 1 }, at: "2026-11-14T08:21:20.000Z",
    endedAt: "2026-11-14T08:21:40.000Z", markdown: "上一场看过了。", segments: [{ id: "e-say:0", markdown: "上一场看过了。", events: [], attachments: [] }],
  },
  { kind: "event", id: "e-end", text: "自由工作流第 1 轮审查通过（老审查）。", at: "2026-11-14T08:21:50.000Z", aside: true, variant: "note" },
];

const base: ConversationItem[] = [
  {
    kind: "agent", id: "impl", sessionId: "s1", label: "claude@nodemach", agentType: "claude", at: "2026-11-14T08:00:00.000Z",
    endedAt: "2026-11-14T08:21:00.000Z", markdown: "MCP 接入已经改成起跑时注入。",
    segments: [{ id: "impl:0", markdown: "MCP 接入已经改成起跑时注入。", events: [], attachments: [] }],
  },
  ...(params.get("earlier") ? earlier : []),
  { kind: "event", id: "start", text: "自由工作流第 1 轮审查开始：5.5审查 · 逻辑检查。", at: started, aside: true, variant: "note" },
  reviewer("r1", "我先核对需求、实际改动和回归登记，再逐面审查。", "2026-11-14T08:23:00.000Z", [bash("npm test")]),
  { kind: "user", id: "wake", at: "2026-11-14T08:24:00.000Z", bySystem: true, attachments: [], sessionId: "rs", sessionRole: "reviewer", ...wake },
  reviewer("r2", "回归收到了，改动面已过一遍。", "2026-11-14T08:25:00.000Z"),
];
const liveText = "接下来验证配置冲突和启动状态误判。";

const reviews = [{
  id: "fr1", reviewerName: "5.5审查", model: "gpt-6.1-sol", reasoningEffort: "medium", note: "重点看 Windows 启动路径。",
  retryLimit: 6, currentRound: 1, target: { kind: "workspace" },
  rounds: [{ round: 1, status: "reviewing", startedAt: started, reportMarkdown: "" }],
}] as never;

const facts: Record<string, Partial<Task>> = {
  question: { status: "paused", question: "要不要连 Windows 一起验？" },
  monitor: { status: "paused", monitorRunning: true },
  checkpoint: { status: "paused" },
};

declare global {
  interface Window { __stream: (text: string) => void; __say: (text: string) => void; __conclude: () => void }
}

function Fixture() {
  const [live, setLive] = useState(liveText);
  const [concluded, setConcluded] = useState(false);
  useEffect(() => {
    window.__stream = (text) => setLive((value) => value + text);
    window.__say = (text) => setLive(text);
    window.__conclude = () => setConcluded(true);
  }, []);
  const phase = params.get("phase");
  const task = {
    id: "t1", title: "审查进行中", status: concluded ? "done" : "running", workflowMode: "free", agentType: "claude",
    ...(!concluded && phase ? facts[phase] : {}),
  } as unknown as Task;
  const running = !concluded && !phase;
  const items: ConversationItem[] = [
    ...base,
    reviewer("r3", live, running ? null : "2026-11-14T08:26:00.000Z", running ? [bash("git diff --stat feat/ui-revamp...HEAD")] : []),
    ...(concluded ? [{ kind: "event" as const, id: "end", text: "自由工作流第 1 轮审查通过（5.5审查）。", at: "2026-11-14T08:28:10.000Z", aside: true, variant: "note" as const }] : []),
  ];
  return (
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <ConversationFeed task={task} items={items} sessions={[]} reviews={reviews} loading={false} error={null}
        onOpenReviewPanel={params.get("opener") ? () => undefined : undefined} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
