// 预览按钮的在途动作**不能跟着人漂到另一个任务上**（断言在 test-preview-task-switch.mjs）。
//
// 复现的是真实结构：切换任务时这个工具栏**不重新挂载**（工作区渲染 TaskDetail 时没有按
// 任务 id 给 key），所以组件里那点本地状态会原样留着。A 的「打开预览」还挂着（它能挂满
// 八分钟），用户切到 B —— 老实现里 B 的按钮就成了 A 遗留的「启动中·点此取消」，而按下去
// 的闭包读的是当前任务，发出去的是 `DELETE B`：把 B 自己的预览停了，A 那趟照旧在跑。
//
// 这里把这条时序整个摆出来：两个任务、两个挂着不回的请求，外加一颗「让 A 的请求返回」
// —— 晚到的旧回调同样不许清掉 B 的动作、不许在 B 的页面上说话或开窗。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import "../../src/styles/global.css";
import { FreeWorkflowToolbar } from "../../src/free-workflow/FreeWorkflowToolbar.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 谁被请求了几次 —— 断言直接读这份账（window.__calls）。 */
const calls = { postsA: 0, postsB: 0, deletesA: 0, deletesB: 0, opens: [] as string[] };
(window as unknown as { __calls: typeof calls }).__calls = calls;
// 开窗也记账不真开：headless 里弹标签页既没意义，也会让「A 的回调在 B 页面开了窗」
// 这件事没法断言。
window.open = ((url?: string | URL) => { calls.opens.push(String(url ?? "")); return null; }) as typeof window.open;

let startedA = false;
let canceledA = false;
let resolveA: ((response: Response) => void) | null = null;

const previewOf = (id: string) => id === "T-A"
  ? { running: startedA && !canceledA, starting: startedA && !canceledA }
  : { running: false, starting: false };

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const method = init?.method ?? "GET";
  const preview = /^\/api\/tasks\/([^/]+)\/free-workflow\/preview$/.exec(pathname);
  const state = /^\/api\/tasks\/([^/]+)\/free-workflow$/.exec(pathname);
  if (state) {
    const { running, starting } = previewOf(state[1]);
    return reply({
      taskId: state[1],
      selectedReviewerId: null,
      stateVersion: Date.now(), // 每次都更新，否则重拉的结果会按「不比现值新」被丢掉
      workspaceHead: "abc1234",
      workspaceDirty: false,
      reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
      preview: { running, starting, hasLog: false, url: null, port: null, command: null, startedAt: null },
      executions: [],
      reviews: [],
    });
  }
  if (preview && method === "POST") {
    if (preview[1] === "T-A") {
      calls.postsA += 1;
      startedA = true;
      // A 的启动请求挂着 —— 现场里它可以挂八分钟（装依赖 + 等就绪）。
      return await new Promise<Response>((resolve) => { resolveA = resolve; });
    }
    calls.postsB += 1;
    return await new Promise<Response>(() => {}); // B 的也挂着，好观察它的动作会不会被顶掉
  }
  if (preview && method === "DELETE") {
    if (preview[1] === "T-A") { calls.deletesA += 1; canceledA = true; } else calls.deletesB += 1;
    return reply({ stopped: true });
  }
  if (pathname === "/api/events") return new Response("", { status: 204 });
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

const taskOf = (id: string) => ({
  id,
  projectId: "P1",
  title: id,
  body: "",
  status: "done",
  stage: "implemented",
  mode: "single",
  workflowMode: "free",
  parentId: null,
  reviewOf: null,
  archived: false,
  labels: [],
  agentType: "claude",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
} as unknown as Task);

function Fixture() {
  const [taskId, setTaskId] = useState("T-A");
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return (
    <main style={{ width: 900, margin: "24px auto" }}>
      <p data-testid="current-task">当前任务：{taskId}</p>
      <button type="button" data-testid="to-b" onClick={() => setTaskId("T-B")}>切到任务 B</button>
      <button type="button" data-testid="finish-a" onClick={() => resolveA?.(reply({
        running: true, url: "http://localhost:45841/", port: 45841, command: "npm run dev",
        startedAt: "2026-09-07T00:00:00.000Z",
      }))}>让 A 的启动请求返回</button>
      {/* 关键：**同一个组件实例**换 task —— 跟工作区里切任务时发生的事一模一样。 */}
      <FreeWorkflowToolbar task={taskOf(taskId)} notify={notify} />
      <pre data-testid="notices">{JSON.stringify(notices)}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
