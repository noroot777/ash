import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { HandoffTarget, ProjectView, TaskListItem } from "@ash/shared";
import { BulkHandoffDialog } from "../../src/workspace/BulkHandoffDialog.tsx";
import "../../src/styles/global.css";

// 批量接力弹窗的排版夹具：弹窗的主体必须是「哪些任务会被搬走」，其余（身份、加密、
// 带走什么）退到一行元信息。这里造一个混合局面：两条能搬、一条预检失败。

const preflight = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  target: { url: "http://mac-mini:4317", host: "192.168.5.5" },
  taskScopedReturn: false,
  peer: {
    fingerprint: "d".repeat(64),
    short: "D67F-CD07-48E7-1DDF-59B9",
    trust: "matched",
    peerStatus: "approved",
    encrypted: true,
  },
  projects: [{ id: "ash", name: "ash", repoPath: "/Users/fjh/code/ash", isRepo: true }],
  suggestedProjectId: "ash",
  local: {
    status: "running",
    running: true,
    sessions: 1,
    sessionFilesFound: 1,
    uploads: 0,
    pendingMessages: 0,
    schedule: null,
    git: "none",
    notes: [],
    ...(overrides.local as Record<string, unknown> ?? {}),
  },
});

const RESULTS: Record<string, { status: number; body: unknown }> = {
  "t-git": {
    status: 200,
    body: preflight({ local: { sessions: 2, sessionFilesFound: 1, uploads: 3, git: "bundle", pendingMessages: 1 } }),
  },
  "t-plain": { status: 200, body: preflight() },
  "t-broken": { status: 409, body: { error: "目标项目已不可用，请重新选择" } },
};

const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const match = /\/api\/tasks\/([^/]+)\/handoff\/preflight/.exec(url);
  if (!match) return nativeFetch(input as RequestInfo, init);
  const hit = RESULTS[decodeURIComponent(match[1])] ?? { status: 500, body: { error: "unexpected task" } };
  return new Response(JSON.stringify(hit.body), {
    status: hit.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof window.fetch;

const task = (id: string, title: string, status: string): TaskListItem => ({
  id,
  title,
  projectId: "p1",
  parentId: null,
  archived: false,
  mode: "single",
  queueId: null,
  verifyRound: null,
  handoff: null,
  status,
  updatedAt: "2026-08-26T04:00:00.000Z",
} as unknown as TaskListItem);

const tasks: TaskListItem[] = [
  task("t-git", "把批量接力弹窗的信息层级重排", "running"),
  task("t-plain", "抓一遍 outbound-state 的超时分支", "queued"),
  task("t-broken", "预检会失败的那条", "running"),
  task("t-idle", "早就跑完的历史任务", "done"),
  task("t-idle2", "另一条收工的任务", "failed"),
  task("t-live-team", "在跑的团队任务", "running"),
];
(tasks[5] as { mode: string }).mode = "team";

// ?empty=1 造「项目里此刻没有在跑的任务」这一档空态。
const liveTasks = new URLSearchParams(window.location.search).has("empty")
  ? tasks.filter((item) => item.status !== "running" && item.status !== "queued")
  : tasks;

const project = { id: "p1", name: "knowledge-base", repoPath: "/Users/fjh/code/kb" } as unknown as ProjectView;
const target: HandoffTarget = {
  name: "mac-mini",
  url: "http://mac-mini:4317",
  peerFp: "d".repeat(64),
} as unknown as HandoffTarget;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BulkHandoffDialog
      project={project}
      target={target}
      tasks={liveTasks}
      notify={() => {}}
      onClose={() => {}}
      onFinished={() => {}}
    />
  </StrictMode>,
);
