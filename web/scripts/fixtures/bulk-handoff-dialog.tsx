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
  // 能力握手:这个夹具验的是信息层级,让它落在「对得上」那一档,别把握手的红块
  // 混进排版断言里(握手自己的用例在 server 的 test-handoff-capability*)。
  capability: { status: "ok", unknownReason: null, gaps: [], blocking: false },
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
  // 真实里逐任务预检失败最常见的一档：对端半路连不上。
  "t-broken": { status: 502, body: { error: "连不上对端 mac-mini（fetch failed）" } },
};

// ?runkey=1 造第 2 轮审查报告里的那一档:预检全过、**打包阶段**才撞上「对端不认识你」。
// 补 key 的入口必须长在结果页上,而且补完只重试卡住的那条 —— 已经推过去的不能再推一次。
const runKeyMode = new URLSearchParams(window.location.search).has("runkey");
const handoffCalls: string[] = [];
(window as unknown as { __handoffCalls: string[] }).__handoffCalls = handoffCalls;
let peerKeySaved = false;

const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  if (url.includes("/api/handoff/targets/key")) {
    peerKeySaved = true;
    return json(200, { targets: [{ name: "mac-mini", url: "http://mac-mini:4317", peerFp: "d".repeat(64), hasKey: true }] });
  }
  const exporting = /\/api\/tasks\/([^/]+)\/handoff$/.exec(url);
  if (exporting) {
    const taskId = decodeURIComponent(exporting[1]);
    handoffCalls.push(taskId);
    // t-git 一次就过;t-plain 在补上 key 之前一直被对端挡回来。
    if (taskId === "t-plain" && !peerKeySaved) {
      return json(401, { error: "对端是多人实例，但它不认识你", ash: true, code: "peer-key-required" });
    }
    return json(200, { taskId, remoteTaskId: `r-${taskId}`, remoteUrl: "http://mac-mini:4317", host: "mac-mini" });
  }
  const match = /\/api\/tasks\/([^/]+)\/handoff\/preflight/.exec(url);
  if (!match) return nativeFetch(input as RequestInfo, init);
  const hit = RESULTS[decodeURIComponent(match[1])] ?? { status: 500, body: { error: "unexpected task" } };
  return json(hit.status, hit.body);
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
  task("t-broken", "补 handoff-return 的重试用例", "running"),
  task("t-idle", "早就跑完的历史任务", "done"),
  task("t-idle2", "另一条收工的任务", "failed"),
  task("t-live-team", "在跑的团队任务", "running"),
];
(tasks[5] as { mode: string }).mode = "team";

// ?empty=1 造「一个都搬不了」这一档空态：只剩收工的任务，外加一个在跑但不支持的团队任务
// —— 这时必须解释清楚，否则「明明有任务在跑」和「没有可接力的」看起来自相矛盾。
const liveTasks = new URLSearchParams(window.location.search).has("empty")
  ? tasks.filter((item) => item.mode === "team" || (item.status !== "running" && item.status !== "queued"))
  : runKeyMode
    ? tasks.filter((item) => item.id === "t-git" || item.id === "t-plain")
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
