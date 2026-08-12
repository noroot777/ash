import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@harness/shared";
import { FreeWorkflowInspector } from "../../src/free-workflow/FreeWorkflowInspector.tsx";
import { FreeWorkflowToolbar } from "../../src/free-workflow/FreeWorkflowToolbar.tsx";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import { TaskReviewWorkspace } from "../../src/review/TaskReviewWorkspace.tsx";
import { TaskHeader } from "../../src/task-detail/TaskHeader.tsx";
import "../../src/styles/global.css";

const state = {
  taskId: "free-task",
  selectedReviewerId: null,
  stateVersion: 1,
  workspaceHead: "commit-current",
  workspaceDirty: false,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, runId: null },
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
  previewEvents: [],
  executions: [
    { id: "execution-1", status: "completed", startedAt: "2026-08-09T00:00:00.000Z", endedAt: "2026-08-09T00:09:00.000Z" },
    { id: "execution-2", status: "completed", startedAt: "2026-08-09T00:20:00.000Z", endedAt: "2026-08-09T00:29:00.000Z" },
  ],
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
    note: null,
    retryLimit: 1,
    currentRound: 1,
    status: "reviewing",
    rounds: [{
      round: 1,
      status: "reviewing",
      conclusion: null,
      reviewedCommit: "commit-current",
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
    note: null,
    retryLimit: 1,
    currentRound: 1,
    status: "passed",
    rounds: [{
      round: 1,
      status: "passed",
      conclusion: "verified",
      reviewedCommit: "commit-current",
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

const acceptanceState = {
  taskId: "free-accept-ui",
  selectedReviewerId: null,
  stateVersion: 1,
  workspaceHead: "commit-current",
  workspaceDirty: false,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, runId: null },
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
  previewEvents: [],
  executions: [{
    id: "execution-accept",
    status: "completed",
    startedAt: "2026-08-09T01:00:00.000Z",
    endedAt: "2026-08-09T01:09:00.000Z",
  }],
  reviews: [],
};

const reviewingAcceptanceState = {
  ...acceptanceState,
  taskId: "free-reviewing-ui",
  reviews: [{
    id: "acceptance-review",
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
    rounds: [],
    createdAt: "2026-08-09T01:10:00.000Z",
    updatedAt: "2026-08-09T01:10:00.000Z",
    finishedAt: null,
  }],
};

const repairState: FreeWorkflowApiState = {
  taskId: "free-repair-task",
  selectedReviewerId: null,
  stateVersion: 1,
  workspaceHead: "commit-current",
  workspaceDirty: false,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, runId: null },
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
  previewEvents: [],
  executions: [{
    id: "repair-execution", status: "completed",
    startedAt: "2026-08-09T01:00:00.000Z", endedAt: "2026-08-09T01:09:00.000Z",
  }],
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
    note: null,
    retryLimit: 1,
    currentRound: 2,
    status: "stopped",
    rounds: [{
      round: 2,
      status: "failed",
      conclusion: "verify_failed",
      reviewedCommit: "commit-current",
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

const manualChatState: FreeWorkflowApiState = {
  ...repairState,
  taskId: "free-chat-rework-task",
  reviews: repairState.reviews.map((run) => ({
    ...run,
    id: "run-chat-rework",
    status: "stopped",
  })),
};

const reviewer = {
  id: "reviewer-one", name: "Codex 审查", agentType: "codex", executorId: "reviewer-executor",
  executorLabel: "codex@test", model: "gpt-test", reasoningEffort: "high",
  createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
};

const agentProfile = {
  id: "reviewer-executor", name: "codex@test", type: "codex", target: { kind: "local" },
  model: "gpt-test", reasoningEffort: "high", isDefault: true,
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
  if (url.pathname === "/api/tasks/free-accept-ui/free-workflow") {
    return Promise.resolve(new Response(JSON.stringify(acceptanceState), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname.startsWith("/api/tasks/free-repair-task/free-workflow")) {
    if (init?.method === "POST" && url.pathname.endsWith("/review/repair")) {
      (window as Window & { __repairRequests?: number }).__repairRequests =
        ((window as Window & { __repairRequests?: number }).__repairRequests ?? 0) + 1;
    }
    return Promise.resolve(new Response(JSON.stringify(repairState), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/tasks/free-reviewing-ui/free-workflow") {
    return Promise.resolve(new Response(JSON.stringify(reviewingAcceptanceState), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname.startsWith("/api/tasks/free-chat-rework-task/free-workflow")) {
    if (init?.method === "PUT" && url.pathname.endsWith("/review-reservation")) {
      const body = JSON.parse(String(init.body ?? "{}")) as { note?: string | null };
      // 真实服务端每次变更都 bump stateVersion；前端拒收「不比现值新」的快照，mock 必须同语义。
      manualChatState.stateVersion += 1;
      manualChatState.selectedReviewerId = reviewer.id;
      manualChatState.reviewReservation = {
        armed: true, reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1, note: body.note ?? null, runId: null,
      };
      (window as Window & { __reservationNote?: string | null }).__reservationNote = body.note ?? null;
      (window as Window & { __reservationRequests?: number }).__reservationRequests =
        ((window as Window & { __reservationRequests?: number }).__reservationRequests ?? 0) + 1;
    }
    return Promise.resolve(new Response(JSON.stringify(manualChatState), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/tasks/free-accept-ui/commits" || url.pathname === "/api/tasks/free-reviewing-ui/commits") {
    return Promise.resolve(new Response(JSON.stringify({ branch: "harness/free-accept-ui", commits: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/tasks/free-accept-ui/diff" || url.pathname === "/api/tasks/free-reviewing-ui/diff") {
    return Promise.resolve(new Response(JSON.stringify({
      available: true,
      sourceBranch: "harness/free-accept-ui",
      targetBranch: "main",
      mergeBase: "0123456789abcdef",
      diff: "",
      files: [],
      truncated: false,
      limitBytes: 1024,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/reviewer-profiles") {
    return Promise.resolve(new Response(JSON.stringify([reviewer]), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/agents") {
    return Promise.resolve(new Response(JSON.stringify([agentProfile]), {
      status: 200, headers: { "content-type": "application/json" },
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

const acceptanceTask = {
  id: "free-accept-ui",
  projectId: "project-ui",
  parentId: null,
  title: "自由任务统一验收",
  body: "完成后进入统一验收页",
  mode: "single",
  status: "done",
  stage: null,
  labels: [],
  dependsOn: [],
  resumeDependsOn: [],
  agentType: "codex",
  createdAt: "2026-08-09T01:00:00.000Z",
  updatedAt: "2026-08-09T01:09:00.000Z",
  endedAt: "2026-08-09T01:09:00.000Z",
  workflowMode: "free",
  workflow: null,
  useWorktree: true,
  worktreeBase: "main",
  archived: false,
} as Task;

const reviewingAcceptanceTask = {
  ...acceptanceTask,
  id: "free-reviewing-ui",
  title: "自由任务审查中",
} as Task;

function AcceptanceFixture({ task, className }: { task: Task; className: string }) {
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <section className={className}>
      <TaskHeader
        task={task}
        conversationMarkdown=""
        busy={false}
        refreshing={false}
        onTitle={async () => undefined}
        onTogglePin={async () => undefined}
        onPrimary={(action) => { if (action === "accept") setReviewOpen(true); }}
        onRequeue={() => undefined}
        onArchive={() => undefined}
        onRefresh={() => undefined}
        onReview={() => setReviewOpen((open) => !open)}
        onDelete={() => undefined}
        indicatorForTask={() => null}
        notify={() => undefined}
      />
      {reviewOpen
        ? <TaskReviewWorkspace task={task} allTasks={[task]} onClose={() => setReviewOpen(false)} onTaskUpdated={() => undefined} notify={() => undefined} />
        : <FreeWorkflowToolbar task={task} notify={() => undefined} />}
    </section>
  );
}

const repairTask = {
  id: "free-repair-task",
  title: "自由工作流手动修复",
  status: "done",
  mode: "single",
  parentId: null,
  reviewOf: null,
  workflowMode: "free",
} as Task;

const manualChatTask = {
  id: "free-chat-rework-task",
  title: "自由工作流普通修改",
  status: "running",
  mode: "single",
  parentId: null,
  reviewOf: null,
  workflowMode: "free",
} as Task;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div>
      <div style={{ display: "grid", gap: 6, width: 760, margin: "12px 0 12px auto", background: "white", padding: 8 }}>
        <div className="toolbar-repair-fixture"><FreeWorkflowToolbar task={repairTask} notify={() => undefined} /></div>
        <div className="toolbar-chat-rework-fixture"><FreeWorkflowToolbar task={manualChatTask} notify={() => undefined} /></div>
      </div>
      <div style={{ display: "flex", gap: 20, height: 640 }}>
        <div style={{ flex: 1 }} />
        <aside className="inspector-host workflow-inspector-fixture" style={{ width: 380, height: 640 }}>
          <FreeWorkflowInspector task={task} />
        </aside>
        <aside className="inspector-host review-only-fixture" style={{ width: 380, height: 640 }}>
          <FreeWorkflowInspector task={task} reviewOnly onOpenReview={() => undefined} notify={() => undefined} />
        </aside>
      </div>
      <AcceptanceFixture task={acceptanceTask} className="acceptance-fixture" />
      <AcceptanceFixture task={reviewingAcceptanceTask} className="acceptance-blocked-fixture" />
      <aside className="inspector-host repair-fixture" style={{ width: 380, height: 360, marginTop: 20, marginLeft: "auto" }}>
        <FreeWorkflowInspector task={repairTask} reviewOnly notify={() => undefined} />
      </aside>
    </div>
  </StrictMode>,
);
