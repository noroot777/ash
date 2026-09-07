// 预览**正在启动**那一段，日志得看得见、而且会自己续（断言在 test-preview-log-live.mjs）。
//
// 复现的是真实时序：`POST …/preview` 会同步等到服务就绪，最长两分钟 —— Maven 在下依赖、
// 前端在冷编译。这一整段里日志一直在长，可它当时对界面是不存在的：
//   · 「预览日志」按钮按 `hasLog` 给，而那份快照要等 POST 回来才重拉；
//   · 弹窗按 `running` 决定要不要每 2 秒续读，而 `running` 当时来自 preview.json ——
//     那个文件要等就绪才写。
// 于是最该看日志的两分钟里，用户只能守着一颗「处理中」。
//
// 这个 fixture 把那两分钟定格：POST 挂着不回，日志接口按次数吐出越来越长的正文，
// 并如实报 `starting: true`。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import "../../src/styles/global.css";
import { FreeWorkflowToolbar } from "../../src/free-workflow/FreeWorkflowToolbar.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TASK_ID = "T-preview-live";
let logReads = 0;
/** 启动期的日志：每读一次多一段，模拟 dev server 边跑边吐字。 */
const phases = [
  "$ PORT=45841 npm run dev\n",
  "$ PORT=45841 npm run dev\n[INFO] Downloading spring-boot-starter-web…\n",
  "$ PORT=45841 npm run dev\n[INFO] Downloading spring-boot-starter-web…\n[INFO] Compiling 42 source files\n",
];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  if (pathname === `/api/tasks/${TASK_ID}/free-workflow`) {
    return reply({
      taskId: TASK_ID,
      selectedReviewerId: null,
      stateVersion: 1,
      workspaceHead: "abc1234",
      workspaceDirty: false,
      reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
      // 关键前提：这个任务**还没有**日志文件，所以按老口径「预览日志」那颗按钮不该出现。
      preview: { running: false, hasLog: false, url: null, port: null, command: null, startedAt: null },
      executions: [],
      reviews: [],
    });
  }
  if (pathname === `/api/tasks/${TASK_ID}/free-workflow/preview` && (init?.method ?? "GET") !== "GET") {
    // 启动请求就这么挂着 —— 现场里它可以挂两分钟。
    return await new Promise<Response>(() => {});
  }
  if (pathname === `/api/tasks/${TASK_ID}/free-workflow/preview/log`) {
    const text = phases[Math.min(logReads, phases.length - 1)];
    logReads += 1;
    return reply({
      text,
      truncated: false,
      updatedAt: "2026-09-07T00:00:00.000Z",
      exists: true,
      // 服务端口径：正在启动也算「还会长」，否则弹窗不会开轮询。
      running: true,
      starting: true,
      command: "npm run dev",
      url: null,
    });
  }
  if (pathname === "/api/events") return new Response("", { status: 204 });
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

const task = {
  id: TASK_ID,
  projectId: "P1",
  title: "预览日志",
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
} as unknown as Task;

function Fixture() {
  const [notices, setNotices] = useState<string[]>([]);
  const notify = useCallback((message: string) => setNotices((all) => [...all, message]), []);
  return (
    <main style={{ width: 900, margin: "24px auto" }}>
      <FreeWorkflowToolbar task={task} notify={notify} />
      <pre data-testid="notices">{JSON.stringify(notices)}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
