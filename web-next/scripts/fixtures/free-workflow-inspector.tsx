import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@harness/shared";
import { FreeWorkflowInspector } from "../../src/free-workflow/FreeWorkflowInspector.tsx";
import "../../src/styles/global.css";

const state = {
  taskId: "free-task",
  selectedReviewerId: null,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null },
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
  previewEvents: [],
  executions: [
    { id: "execution-1", status: "completed", startedAt: "2026-08-09T00:00:00.000Z", endedAt: "2026-08-09T00:09:00.000Z" },
    { id: "execution-2", status: "completed", startedAt: "2026-08-09T00:20:00.000Z", endedAt: "2026-08-09T00:29:00.000Z" },
  ],
  merge: { status: "merging", message: "正在合并", mergedAt: null, updatedAt: "2026-08-09T00:40:00.000Z" },
  reviews: [{
    id: "run-def",
    reviewerId: null,
    reviewerName: "Codex 审查",
    agentType: "codex",
    executorId: null,
    executorLabel: null,
    model: null,
    reasoningEffort: null,
    checkMode: "logic",
    retryLimit: 1,
    currentRound: 1,
    status: "reviewing",
    rounds: [{
      round: 1,
      status: "reviewing",
      conclusion: null,
      reportMarkdown: "",
      screenshots: [],
      startedAt: "2026-08-09T00:30:00.000Z",
      endedAt: null,
    }],
    createdAt: "2026-08-09T00:30:00.000Z",
    updatedAt: "2026-08-09T00:30:00.000Z",
    finishedAt: null,
  }, {
    id: "run-abc",
    reviewerId: null,
    reviewerName: "Codex 审查",
    agentType: "codex",
    executorId: null,
    executorLabel: null,
    model: null,
    reasoningEffort: null,
    checkMode: "logic",
    retryLimit: 1,
    currentRound: 1,
    status: "passed",
    rounds: [{
      round: 1,
      status: "passed",
      conclusion: "verified",
      reportMarkdown: "# 审查结论\n\n**统一预览已验证。**",
      screenshots: ["shot-one.png", "shot-two.png", "shot-three.png", "shot-four.png", "shot-five.png", "shot-six.png"],
      startedAt: "2026-08-09T00:10:00.000Z",
      endedAt: "2026-08-09T00:11:00.000Z",
    }],
    createdAt: "2026-08-09T00:10:00.000Z",
    updatedAt: "2026-08-09T00:11:00.000Z",
    finishedAt: "2026-08-09T00:11:00.000Z",
  }],
};

const repairState = {
  taskId: "free-repair-task",
  selectedReviewerId: null,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null },
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
  previewEvents: [],
  executions: [{
    id: "repair-execution", status: "completed",
    startedAt: "2026-08-09T01:00:00.000Z", endedAt: "2026-08-09T01:09:00.000Z",
  }],
  merge: { status: "idle", message: null, mergedAt: null, updatedAt: null },
  reviews: [{
    id: "run-repair",
    reviewerId: null,
    reviewerName: "Codex 审查",
    agentType: "codex",
    executorId: null,
    executorLabel: null,
    model: null,
    reasoningEffort: null,
    checkMode: "logic",
    retryLimit: 1,
    currentRound: 2,
    status: "exhausted",
    rounds: [{
      round: 2,
      status: "failed",
      conclusion: "verify_failed",
      reportMarkdown: "# 仍需修复\n\n按钮状态不对。",
      screenshots: [],
      startedAt: "2026-08-09T01:10:00.000Z",
      endedAt: "2026-08-09T01:11:00.000Z",
    }],
    createdAt: "2026-08-09T01:10:00.000Z",
    updatedAt: "2026-08-09T01:11:00.000Z",
    finishedAt: "2026-08-09T01:11:00.000Z",
  }],
};

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
  if (url.pathname === "/api/tasks/free-task/free-workflow") {
    return Promise.resolve(new Response(JSON.stringify(state), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname.startsWith("/api/tasks/free-repair-task/free-workflow")) {
    if (init?.method === "POST" && url.pathname.endsWith("/review/repair")) {
      repairState.reviews[0].status = "manual_repairing";
      (window as Window & { __repairRequests?: number }).__repairRequests =
        ((window as Window & { __repairRequests?: number }).__repairRequests ?? 0) + 1;
    }
    return Promise.resolve(new Response(JSON.stringify(repairState), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  return nativeFetch(input, init);
};

const task = {
  id: "free-task",
  title: "自由工作流附件预览",
  status: "done",
  workflowMode: "free",
} as Task;

const repairTask = {
  id: "free-repair-task",
  title: "自由工作流手动修复",
  status: "done",
  workflowMode: "free",
} as Task;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ display: "flex", gap: 20, height: 640 }}>
      <div style={{ flex: 1 }} />
      <aside className="inspector-host workflow-inspector-fixture" style={{ width: 380, height: 640 }}>
        <FreeWorkflowInspector task={task} />
      </aside>
      <aside className="inspector-host review-only-fixture" style={{ width: 380, height: 640 }}>
        <FreeWorkflowInspector task={task} reviewOnly onOpenReview={() => undefined} notify={() => undefined} />
      </aside>
    </div>
    <aside className="inspector-host repair-fixture" style={{ width: 380, height: 360, marginTop: 20, marginLeft: "auto" }}>
      <FreeWorkflowInspector task={repairTask} reviewOnly notify={() => undefined} />
    </aside>
  </StrictMode>,
);
