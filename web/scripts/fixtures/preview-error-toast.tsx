// 预览起不来那一句**不能自己消失**（断言在 test-preview-error-toast.mjs）。
//
// 现场：用户点「打开预览」，仓库里没配预览命令且认出了不止一个能起服务的东西，后端 409
// 回来的是一整份说明 —— 认出了哪几个、各自怎么起、前后端一起起该写成什么样。老实现把它
// 塞进两秒多就自走的 toast 里：用户只看见红了一下，得再点一次才读得到（还是两秒多）。
//
// 这里把真组件（FreeWorkflowToolbar）和真提示（useToast + WorkspaceToast）挂在一起，
// 中间只换掉 fetch —— 断言的就是「这一句还在不在」。
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import { FreeWorkflowToolbar } from "../../src/free-workflow/FreeWorkflowToolbar.tsx";
import { useToast, WorkspaceToast } from "../../src/workspace/WorkspaceToast.tsx";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 后端认出多个候选时说的那段话（server/src/preview-command.ts 的 ambiguousMessage 形状）。 */
export const AMBIGUOUS = "这个工作区里认出了 2 个能起服务的东西，ash 不替你挑"
  + "（挑错的话你会对着另一个服务验收自己的改动）：\n"
  + "  · a4sms-back/a4sms-imds（Maven 模块 · Spring Boot）\n"
  + "    cd a4sms-back && mvn -pl a4sms-imds spring-boot:run\n"
  + "  · a4sms-front（Node · pnpm dev）\n"
  + "    cd a4sms-front && pnpm run dev --port $PORT\n"
  + "把要看的那一条填进「设置 → 项目设置 → 预览命令」，之后这个项目就一直用它。";
(window as unknown as { __ambiguous: string }).__ambiguous = AMBIGUOUS;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(href, location.origin);
  const method = init?.method ?? "GET";
  if (/^\/api\/tasks\/[^/]+\/free-workflow\/preview$/.test(pathname) && method === "POST") {
    return reply({ error: AMBIGUOUS }, 409);
  }
  if (/^\/api\/tasks\/[^/]+\/free-workflow$/.test(pathname)) {
    return reply({
      taskId: "T-1",
      selectedReviewerId: null,
      stateVersion: Date.now(),
      workspaceHead: "abc1234",
      workspaceDirty: false,
      reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
      preview: { running: false, starting: false, hasLog: false, url: null, port: null, command: null, startedAt: null },
      executions: [],
      reviews: [],
    });
  }
  if (pathname === "/api/events") return new Response("", { status: 204 });
  if (pathname.startsWith("/api/")) return reply({});
  return realFetch(input as never, init);
};

const task = {
  id: "T-1",
  projectId: "P1",
  title: "T-1",
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
  const { toast, notify, dismiss } = useToast();
  return (
    <main style={{ width: 900, margin: "24px auto" }}>
      <FreeWorkflowToolbar task={task} notify={notify} />
      {/* 对照组：常规提示照旧两秒多自己走，别把所有提示都改成常驻。 */}
      <button type="button" data-testid="plain-notice" onClick={() => notify("已复制")}>发一句常规提示</button>
      <WorkspaceToast toast={toast} onDismiss={dismiss} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
