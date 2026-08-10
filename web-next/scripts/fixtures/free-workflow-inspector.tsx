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
  merge: { status: "idle", message: null, mergedAt: null, updatedAt: null },
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

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
  if (url.pathname === "/api/tasks/free-task/free-workflow") {
    return Promise.resolve(new Response(JSON.stringify(state), {
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ display: "flex", gap: 20 }}>
      <aside className="inspector-host workflow-inspector-fixture" style={{ width: 380, height: 640 }}>
        <FreeWorkflowInspector task={task} />
      </aside>
      <aside className="inspector-host review-only-fixture" style={{ width: 380, height: 640 }}>
        <FreeWorkflowInspector task={task} reviewOnly onOpenReview={() => undefined} notify={() => undefined} />
      </aside>
    </div>
  </StrictMode>,
);
