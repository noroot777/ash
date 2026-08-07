import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@harness/shared";
import { TeamReviewInspector } from "../../src/team/TeamReviewInspector.tsx";
import "../../src/styles/global.css";

// 每次证据请求都记在这里，测试脚本据此断言「点审查执行者读的是被审任务的记录」。
const asked: string[] = [];
(window as unknown as { __reviewFetches: string[] }).__reviewFetches = asked;

const originalFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const review = /\/api\/tasks\/([^/]+)\/review$/.exec(url);
  if (review) {
    asked.push(review[1]);
    return new Response(
      JSON.stringify({
        reviewRequested: false,
        rounds: [{
          round: 1,
          where: "task",
          reviewTaskId: `rev-${review[1]}`,
          reviewTaskStatus: "done",
          conclusion: "verified",
          reportMarkdown: `${review[1]} 的验证报告`,
          screenshots: ["shot.png"],
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input as RequestInfo, init);
}) as typeof window.fetch;

function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    projectId: "prj",
    groupId: null,
    parentId: "lead",
    title,
    body: "",
    mode: "single",
    status: "done",
    priority: "none",
    labels: [],
    dependsOn: [],
    resumeDependsOn: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

// 调度台与 w3 都是被团队整体验收连带标上 accepted 的:验收痕迹不是验证痕迹,列表里不该出现。
const lead = task("lead", "团队：随手记全屏", { parentId: null, mode: "team", status: "idle", stage: "accepted" });
const workers: Task[] = [
  task("w1", "做搜索", { stage: "verified" }),
  task("w2", "做弹窗", { stage: "verify_failed" }),
  task("w3", "改图标", { stage: "accepted" }),
  // 就地验证的执行者:没有审查任务代表它,自己带着验证 stage 进列表。
  task("w4", "写文案", { stage: "verified" }),
  task("r1", "审查:做搜索", { reviewOf: "w1", stage: "accepted" }),
  task("r2", "审查:做弹窗", { reviewOf: "w2" }),
  // 同一个执行者被审第二轮：列表里该收敛成一条，留后派的这个。
  task("r3", "审查:做搜索(复审)", { reviewOf: "w1", stage: "accepted" }),
];

// 侧边栏在页面右侧，左边是主工作区——抽屉贴着侧边栏左边缘展开，所以位置断言要有这块留白。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ display: "flex", height: 640 }}>
      <div style={{ flex: 1 }} />
      <aside className="inspector-host" style={{ width: 360, minWidth: 360 }}>
        <TeamReviewInspector lead={lead} workers={workers} onOpenReview={() => undefined} onOpenTask={() => undefined} />
      </aside>
    </div>
  </StrictMode>,
);
