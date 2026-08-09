import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@harness/shared";
import { FreeWorkflowInspector } from "../../src/free-workflow/FreeWorkflowInspector.tsx";
import "../../src/styles/global.css";

const state = {
  taskId: "free-task",
  selectedReviewerId: null,
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
  previewEvents: [],
  merge: { status: "idle", message: null, mergedAt: null, updatedAt: null },
  reviews: [{
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
      screenshots: ["shot-one.png", "shot-two.png"],
      startedAt: "2026-08-09T00:00:00.000Z",
      endedAt: "2026-08-09T00:01:00.000Z",
    }],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
    finishedAt: "2026-08-09T00:01:00.000Z",
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
    <aside className="inspector-host" style={{ width: 380, height: 640 }}>
      <FreeWorkflowInspector task={task} reviewOnly />
    </aside>
  </StrictMode>,
);
