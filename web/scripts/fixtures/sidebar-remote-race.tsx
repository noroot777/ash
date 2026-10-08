import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_APP_SETTINGS, type HandoffTarget, type ProjectView, type Task } from "@ash/shared";
import "@fontsource-variable/inter";
import "../../src/styles/global.css";
import { api } from "../../src/lib/api.ts";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { ExecutorGateProvider } from "../../src/task-detail/ExecutorGate.tsx";
import { WorkspaceShell } from "../../src/workspace/WorkspaceShell.tsx";

// 真 WorkspaceShell + 可以**按住**的「问一次持有机」。
//
// 打开接力出去的那种行要先问一次持有机（openOutboundTask → refreshTargets），这中间有一个
// 真实的异步窗口。审查第 1 轮抓到的是：那份应答回来时无条件写选中，于是「按 K 去看另一台
// 机器上那条、还没打开就点回本机任务」之后，主区过一会儿自己又跳成远端那条。
// 这个 fixture 把那个窗口交到用例手里（window.__holdTargets / __releaseTargets），
// 所以竞态是真的跑出来的，不是模拟出来的。

const project: ProjectView = {
  id: "p1",
  name: "接力竞态",
  repoPath: "/tmp/race",
  workflowId: null,
  useWorktreeDefault: false,
  previewCommand: null,
  acceptCommit: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  health: { exists: true, isRepo: true, branch: "main", dirty: false },
  myRole: "admin",
};

const far: HandoffTarget = { name: "mac-mini", url: "http://mac-mini:4317", peerFp: "a".repeat(64) };

function task(id: string, title: string, updatedAt: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    projectId: project.id,
    groupId: null,
    parentId: null,
    title,
    body: "",
    mode: "single",
    status: "running",
    stage: null,
    labels: [],
    dependsOn: [],
    resumeDependsOn: [],
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

// 接力出去之后本机那一行停在哪个状态，真实里多半是 canceled（导出前会先把任务停掉）。
// 这里用 failed 只为了让它在**任务模式**下也露面（canceled 不进任务模式，见 inTaskMode）——
// 任务模式下主列表里直接摆着 out 行，是「连点两条远端任务」唯一真实可达的入口。
const outbound = (id: string, title: string, updatedAt: string): Task => task(id, title, updatedAt, {
  status: "failed",
  handoff: {
    direction: "out",
    peerUrl: far.url,
    peerName: far.name,
    peerFp: far.peerFp,
    originFp: "b".repeat(64),
    peerTaskId: id,
    at: updatedAt,
    sessions: 1,
    git: "bundle",
  },
});

const tasks: Task[] = [
  task("local", "本机那条", "2026-10-08T03:00:00.000Z"),
  outbound("far-1", "mac-mini 上那条", "2026-10-08T02:00:00.000Z"),
  outbound("far-2", "mac-mini 上另一条", "2026-10-08T01:00:00.000Z"),
];

// 「问一次持有机」的闸门：用例按住它，就能在应答回来之前再做别的动作。
let holding = false;
let pending: (() => void)[] = [];
const report = () => {
  const node = document.getElementById("pending");
  if (node) node.textContent = String(pending.length);
};
const hold = () => { holding = true; };
const release = (order: "fifo" | "lifo" = "fifo") => {
  holding = false;
  const waiting = pending.splice(0);
  if (order === "lifo") waiting.reverse();
  report();
  for (const resolve of waiting) resolve();
};
Object.assign(window as unknown as Record<string, unknown>, {
  __holdTargets: hold,
  __releaseTargets: release,
  __pendingTargets: () => pending.length,
});

api.projects = async () => [project];
api.tasks = async () => tasks;
api.groups = async () => [];
api.projectHealth = async () => project.health!;
api.handoffTargets = async () => {
  if (holding) {
    await new Promise<void>((resolve) => { pending.push(resolve); report(); });
  }
  return [far];
};
api.handoffPeers = async () => [];
api.settings = async () => ({ ...DEFAULT_APP_SETTINGS });
api.agents = async () => [];
api.workflows = async () => [];
api.teamPresets = async () => [];
api.task = async (id) => tasks.find((item) => item.id === id) ?? tasks[0]!;
api.projectBranches = async () => ({ branches: ["main"], current: "main" });

// 远端详情要连另一台机器，fixture 里没有那台机器 —— 一律挡掉，只影响详情读取，
// 不影响这条用例关心的「选中落在谁身上」。
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/\/api\/tasks\/[^/]+\/remote/.test(href)) {
    return new Response(JSON.stringify({ error: "fixture 不连真机器" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof window.fetch;

class QuietEvents extends EventTarget {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 1;
  constructor() {
    super();
    queueMicrotask(() => this.onopen?.());
  }
  close() { this.readyState = 2; }
}
window.EventSource = QuietEvents as unknown as typeof EventSource;

window.localStorage.clear();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      <ExecutorGateProvider>
        <WorkspaceShell />
      </ExecutorGateProvider>
    </DraftProvider>
  </StrictMode>,
);
