// 预设工作流「打开预览」那一站的常驻地址（断言在 test-preview-preset-links.mjs）。
//
// 起来了不再往会话里写「预览已起：地址」，这一站就得自己现读当前预览、刷新后照样给出入口。
// 真组件（PreviewRestartButton），中间只换掉 fetch 和事件通道：`?running=1` 表示盘上已经有一份起来了的预览。
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import type { WorkflowStep } from "@ash/shared/workflow";
import "../../src/styles/global.css";
import "../../src/styles/task-reply.css";
import "../../src/styles/free-workflow.css";
import "../../src/styles/workflow.css";
import { PreviewRestartButton } from "../../src/workflow/PreviewRestartButton.tsx";

export const URL_READY = "http://localhost:51048/";
let running = new URLSearchParams(location.search).get("running") === "1";
let failReads = false;
// 读当前预览要多久才回（毫秒）；hangNext = 下一发一直不回，直到被调用方放弃。
let readDelay = 0;
let hangNext = false;
let reads = 0;

// 事件通道换成能手动开、断、推的替身：断线重连那一下要不要重读，靠它来演。
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  constructor() { FakeEventSource.last = this; }
  close() {}
}
(window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
Object.assign(window, {
  __stage: {
    open: () => FakeEventSource.last?.onopen?.(),
    drop: () => FakeEventSource.last?.onerror?.(),
    review: () => FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ type: "task.review", taskId: "T-1" }) }),
    // 只改服务端那一份、不发事件：演「这期间的事件丢了」。
    setRunning: (next: boolean) => { running = next; },
    failReads: (next: boolean) => { failReads = next; },
    slowReads: (ms: number) => { readDelay = ms; },
    hangNextRead: () => { hangNext = true; },
    reads: () => reads,
  },
});

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const state = () => ({
  gen: running ? "g1" : null, running, starting: false, hasLog: running, url: running ? URL_READY : null,
  port: running ? 51048 : null, command: "npm run dev", startedAt: running ? "2026-11-13T00:00:00.000Z" : null,
  services: [], proxied: false,
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const method = init?.method ?? "GET";
  if (pathname === "/api/tasks/T-1/preview/restart" && method === "POST") {
    running = true;
    return reply({ ok: true, url: URL_READY, port: 51048 });
  }
  if (pathname === "/api/tasks/T-1/preview" && method === "GET") {
    reads += 1;
    const hang = hangNext;
    hangNext = false;
    // 结果按请求**发出那一刻**的样子定，回得慢不改变它说的是哪一刻。
    const answer = failReads ? reply({ error: "ash 不在线" }, 502) : reply(state());
    if (hang || readDelay) {
      await new Promise<void>((resolve, reject) => {
        const timer = hang ? undefined : window.setTimeout(resolve, readDelay);
        init?.signal?.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
      });
    }
    return answer;
  }
  if (pathname === "/api/events") return new Response("", { status: 204 });
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

const task = {
  id: "T-1", projectId: "P1", title: "T-1", body: "", status: "done", stage: "implemented",
  mode: "single", workflowMode: "preset", parentId: null, reviewOf: null, archived: false, labels: [],
  agentType: "claude", verifyRound: null, handoff: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
} as unknown as Task;
const step = { id: "preview", kind: "preview", fail: null, p: { cmd: "npm run dev", mode: "frontend", ready: "port", life: "task" } } as Extract<WorkflowStep, { kind: "preview" }>;

createRoot(document.getElementById("root")!).render(
  <main style={{ width: 360, margin: "24px auto" }}>
    <PreviewRestartButton task={task} step={step} notify={() => {}} />
  </main>,
);
