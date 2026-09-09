// 预览**正在启动**那一段，日志得看得见、而且会自己续（断言在 test-preview-log-live.mjs）。
//
// 复现的是真实时序：`POST …/preview` 会同步等到服务就绪，最长两分钟 —— Maven 在下依赖、
// 前端在冷编译。这一整段里日志一直在长，可它当时对界面是不存在的：
//   · 「预览日志」按钮按 `hasLog` 给，而那份快照要等 POST 回来才重拉；
//   · 弹窗按 `running` 决定要不要每 2 秒续读，而 `running` 当时来自 preview.json ——
//     那个文件要等就绪才写。
// 于是最该看日志的两分钟里，用户只能守着一颗「处理中」。
//
// 这个 fixture 把那两分钟定格，并且**第一次日志 GET 故意报「没在跑」**：后端的 starting
// 是 startPreview 真开跑之后才有的，而按钮在 POST 发出那一刻就亮了，手快的用户第一次
// GET 就落在这个窗口里。轮询只认第一次响应的话，弹窗就永远停在「还没有预览日志」上。
//
// `?mode=pre-spawn` 换另一条路：POST 在 spawn 之前就 409（多候选时
// resolvePreviewCommand 直接抛），根本没有日志文件 —— 那一档乐观按钮必须收回去。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import type { PreviewServiceState } from "@ash/shared/preview";
import "../../src/styles/global.css";
import { FreeWorkflowToolbar } from "../../src/free-workflow/FreeWorkflowToolbar.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TASK_ID = "T-preview-live";
const mode = new URLSearchParams(location.search).get("mode");
const preSpawn = mode === "pre-spawn";
const removalError = mode === "services-removed-error";
const removedService = mode === "services-removed" || removalError;
const lateShort = mode === "services-late-short";
const lateServices = mode === "services-late" || lateShort;
const singleShort = mode === "single-short";
const longNames = mode === "services-long" || mode === "services-many" || removedService || lateServices;
const serviceSwitch = mode === "service-switch" || longNames;
/**
 * `?mode=ready-close`：预览**已经起来了**，用户点「关闭预览」，DELETE 挂着不回。
 * 这一档要钉的是措辞和可点性：关一个已就绪的预览，按钮不能翻成「启动中·点此取消」
 * （更不能还能再点一次去发第二个 DELETE），它该说「关闭中」并且是灰的。
 */
const readyClose = mode === "ready-close" || singleShort;
/**
 * `?mode=cancel-late-success`：**取消赢了，可那趟 POST 随后还是 200 回来了。**
 *
 * 这不是编出来的时序：`startPreview` 判定就绪之后，POST 路由还要 `await appendTaskTimeline`
 * 才回 200，而 DELETE 是故意不抢那把锁的（server/src/free-workflow-preview.ts）——用户就在
 * 这条缝里点了取消，记录和进程都收掉了，晚一步到达的那个 200 手上却还攥着刚才那份 record。
 * 它绝不能再宣告「预览已打开」，更不能弹开一个已经被停掉的地址。
 */
const cancelLate = mode === "cancel-late-success";
let logReads = 0;
let selectedServiceReads = 0;
let serviceRemoved = false;
let removalFailures = 0;
/** 启动期的日志：每读一次多一段，模拟 dev server 边跑边吐字。 */
const phases = [
  "$ PORT=45841 npm run dev\n",
  "$ PORT=45841 npm run dev\n[INFO] Downloading spring-boot-starter-web…\n",
  "$ PORT=45841 npm run dev\n[INFO] Downloading spring-boot-starter-web…\n[INFO] Compiling 42 source files\n",
];
const serviceStates: PreviewServiceState[] = longNames ? [
  { id: "imds", name: "a4sms-back/a4sms-imds（Maven 模块 · Spring Boot）", command: "cd a4sms-back && mvn -pl a4sms-imds spring-boot:run", status: "ready", url: "/api/tasks/T-preview-live/preview/open/imds", port: 45841 },
  { id: "api", name: "a4sms-back/a4sms-icis（Maven 模块 · Spring Boot）", command: "cd a4sms-back && mvn -pl a4sms-icis spring-boot:run", status: "ready", url: "/api/tasks/T-preview-live/preview/open/api", port: 45842 },
  { id: "web", name: "a4sms-front（Node · pnpm dev）", command: "cd a4sms-front && pnpm run dev --port $PORT", status: "ready", url: "/api/tasks/T-preview-live/preview/open/web", port: 45843 },
  ...(mode === "services-many" ? Array.from({ length: 5 }, (_, index): PreviewServiceState => ({
    id: `worker-${index}`, name: `a4sms-back/后台同步服务-${index + 1}（Maven 模块 · Spring Boot）`, command: "npm run worker",
    status: (["starting", "failed", "stopped", "ready", "ready"] as const)[index], url: null, port: 45844 + index,
  })) : []),
] : [
  { id: "web", name: "网页前端", command: "npm run web", status: "ready" as const, url: "http://localhost:45841/", port: 45841 },
  { id: "api", name: "接口服务", command: "npm run api", status: "ready" as const, url: null, port: 45842 },
];
const longServiceLog = Array.from({ length: 220 }, (_, index) => `all service line ${index + 1}`).join("\n");

// 启动那一段是可以被**取消**的：DELETE 不跟 POST 抢锁（服务端 free-workflow-preview.ts），
// 在跑的那趟随后自己发现代号没了、以失败返回。这里把这条时序也复现出来 —— 否则「界面上
// 有没有一颗点得到的取消」这件事根本测不到。
let startPosted = false;
let canceled = false;
let failStart: ((reason: unknown) => void) | null = null;
/** cancel-late-success 那一路：让挂着的 POST **成功**返回（由页面上那颗控制按钮触发）。 */
let succeedStart: ((response: Response) => void) | null = null;
/** 开窗只记账不真开：headless 里弹标签页没意义，而「有没有开窗」正是要断言的东西。 */
const opens: string[] = [];
(window as unknown as { __opens: string[] }).__opens = opens;
window.open = ((url?: string | URL) => { opens.push(String(url ?? "")); return null; }) as typeof window.open;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  if (pathname === `/api/tasks/${TASK_ID}/free-workflow`) {
    return reply({
      taskId: TASK_ID,
      selectedReviewerId: null,
      // 每次都发新版本号，否则 useFreeWorkflowState 会按「不比现值新」丢掉重拉的结果。
      stateVersion: Date.now(),
      workspaceHead: "abc1234",
      workspaceDirty: false,
      reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
      // 关键前提：这个任务**始终没有**日志文件（pre-spawn 那条路根本没起过命令），
      // 所以按老口径「预览日志」那颗按钮不该出现、也不该留下。
      // POST 一发出，服务端就落下一条「正在启动」的记录并发事件，所以快照里它是
      // running + starting（别的页面、以及刷新之后，靠的就是这个看见「可以取消」）。
      preview: serviceSwitch
        ? {
          running: true, starting: lateShort, hasLog: true,
          url: "http://localhost:45841/", port: 45841, command: "multi-service",
          startedAt: "2026-09-07T00:00:00.000Z", services: lateShort ? [] : serviceStates,
        }
        : readyClose
        ? {
          running: true, starting: false, hasLog: true,
          url: "http://localhost:45841/", port: 45841, command: "npm run dev",
          startedAt: "2026-09-07T00:00:00.000Z",
        }
        : {
          running: startPosted && !canceled, starting: startPosted && !canceled,
          hasLog: false, url: null, port: null, command: null, startedAt: null,
        },
      executions: [],
      reviews: [],
    });
  }
  if (pathname === `/api/tasks/${TASK_ID}/free-workflow/preview` && (init?.method ?? "GET") === "DELETE") {
    // 关一个已就绪的预览：真实现场里这一下要杀进程、撤软链，不是瞬间返回的。
    if (readyClose) return await new Promise<Response>(() => {});
    // 关闭：服务端删掉那条 starting 记录、杀掉已经起的进程和正在装依赖的进程，
    // 在跑的那趟 POST 随后以「启动被取消」失败返回。
    canceled = true;
    // cancel-late-success 例外：这一路要复现「DELETE 先赢、POST 还是 200」，所以**不**把
    // 那趟 POST 打成失败，留给页面上那颗控制按钮决定它什么时候成功返回。
    if (!cancelLate) failStart?.(new Error("预览启动被取消（关闭预览 / 任务重新开跑 / ash 重启）"));
    return reply({ stopped: true });
  }
  if (pathname === `/api/tasks/${TASK_ID}/free-workflow/preview` && (init?.method ?? "GET") !== "GET") {
    // 多候选：命令都没解析出来就 409 了，spawn 之前，盘上没有任何日志。
    if (preSpawn) return reply({ error: "认出了 3 个能起服务的东西，请在项目设置 → 预览命令里指一个" }, 409);
    // 正常路径：启动请求就这么挂着 —— 现场里它可以挂两分钟（除非被取消）。
    startPosted = true;
    return await new Promise<Response>((resolve, reject) => { failStart = reject; succeedStart = resolve; });
  }
  if (pathname === `/api/tasks/${TASK_ID}/free-workflow/preview/log`) {
    if (singleShort) return reply({
      services: serviceStates.slice(0, 1), text: "single-service banner", exists: true,
      running: false, starting: false, truncated: false, updatedAt: null,
      command: "npm run web", url: "http://localhost:45841/",
    });
    if (serviceSwitch) {
      const selectedService = new URL(href, location.origin).searchParams.get("service");
      if (removedService && selectedService === "api" && ++selectedServiceReads > 1) serviceRemoved = true;
      if (removalError && serviceRemoved && !selectedService && ++removalFailures <= 3) {
        return reply({ error: `temporary log error #${removalFailures}` }, 500);
      }
      const currentServices = serviceRemoved ? serviceStates.filter((service) => service.id !== "api")
        : lateServices && logReads++ < 5 ? (lateShort ? [] : serviceStates.slice(0, 1)) : serviceStates;
      if (selectedService === "web") {
        return await new Promise<Response>((resolve) => setTimeout(() => resolve(reply({
          services: currentServices,
          text: "stale web log",
          truncated: false,
          updatedAt: "2026-09-07T00:00:00.000Z",
          exists: true,
          running: true,
          starting: false,
          command: "npm run web",
          url: "http://localhost:45841/",
        })), 400));
      }
      const selected = currentServices.find((service) => service.id === selectedService);
      return reply({
        services: currentServices,
        text: selectedService === "api" ? (serviceRemoved ? "removed api log" : "fresh api log")
          : serviceRemoved ? "remaining services log" : lateShort ? "startup banner" : longServiceLog,
        truncated: false,
        updatedAt: "2026-09-07T00:00:00.000Z",
        exists: true,
        running: true,
        starting: lateShort && !currentServices.length,
        command: selected?.command ?? "all services",
        url: selected?.url ?? null,
      });
    }
    const nth = logReads;
    logReads += 1;
    // **第一次故意报空闲**：那是 POST 已发出、后端还没走到 startPreview 的那个窗口。
    if (nth === 0) {
      return reply({
        text: "", truncated: false, updatedAt: null, exists: false,
        running: false, starting: false, command: null, url: null,
      });
    }
    return reply({
      text: phases[Math.min(nth - 1, phases.length - 1)],
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
    <main style={{ width: "calc(100% - 32px)", maxWidth: 900, margin: "24px auto" }}>
      {cancelLate && (
        <button type="button" data-testid="finish-start" onClick={() => succeedStart?.(reply({
          running: true, url: "http://localhost:45841/", port: 45841, command: "npm run dev",
          startedAt: "2026-09-07T00:00:00.000Z",
        }))}>让那趟启动请求成功返回</button>
      )}
      <FreeWorkflowToolbar task={task} notify={notify} />
      <pre data-testid="notices">{JSON.stringify(notices)}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
