import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { FreeWorkflowInspector } from "../../src/free-workflow/FreeWorkflowInspector.tsx";
import { FreeWorkflowToolbar } from "../../src/free-workflow/FreeWorkflowToolbar.tsx";
import { FreeReviewDialog } from "../../src/free-workflow/FreeReviewDialog.tsx";
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

const postMergeState: FreeWorkflowApiState = {
  ...acceptanceState,
  taskId: "post-merge-ui",
  workspaceHead: null,
  workspaceDirty: null,
  reviews: [],
};

const postMergeRun = () => ({
  id: "post-merge-run",
  reviewerId: reviewer.id,
  reviewerName: reviewer.name,
  agentType: "codex" as const,
  executorId: reviewer.executorId,
  executorLabel: reviewer.executorLabel,
  model: reviewer.model,
  reasoningEffort: reviewer.reasoningEffort,
  checkMode: "logic" as const,
  note: null,
  target: {
    kind: "accepted_merge" as const,
    branch: "main",
    baseCommit: "11111111aaaaaaaa",
    mergeCommit: "22222222bbbbbbbb",
    repairTaskId: null,
  },
  retryLimit: 0,
  currentRound: 1,
  status: "reviewing" as const,
  rounds: [{
    round: 1,
    status: "reviewing" as const,
    conclusion: null,
    reviewedCommit: "22222222bbbbbbbb",
    reportMarkdown: "",
    screenshots: [],
    startedAt: "2026-08-09T02:00:00.000Z",
    endedAt: null,
  }],
  createdAt: "2026-08-09T02:00:00.000Z",
  updatedAt: "2026-08-09T02:00:00.000Z",
  finishedAt: null,
});

const repairState: FreeWorkflowApiState = {
  taskId: "free-repair-task",
  selectedReviewerId: null,
  stateVersion: 1,
  workspaceHead: "commit-current",
  workspaceDirty: false,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, runId: null },
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
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

// 接力刚落地的样子：任务在跑，身上挂着系统塞的「接力前言」(resumePrompt)。这时
// 「立即派审」后端会 409，但「预约」不会——reserveFreeReview 没有 waiting 门禁。
const waitingChatState: FreeWorkflowApiState = {
  ...repairState,
  taskId: "free-waiting-task",
  reviews: [],
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
  if (url.pathname === "/api/tasks/post-merge-ui/free-workflow/post-merge-review" && init?.method === "POST") {
    postMergeState.stateVersion += 1;
    postMergeState.reviews = [postMergeRun()];
    (window as Window & { __postMergeRequests?: number }).__postMergeRequests =
      ((window as Window & { __postMergeRequests?: number }).__postMergeRequests ?? 0) + 1;
    return Promise.resolve(new Response(JSON.stringify(postMergeState), {
      status: 201, headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/tasks/post-merge-ui/free-workflow") {
    return Promise.resolve(new Response(JSON.stringify(postMergeState), {
      status: 200, headers: { "content-type": "application/json" },
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
  if (url.pathname.startsWith("/api/tasks/free-waiting-task/free-workflow")) {
    return Promise.resolve(new Response(JSON.stringify(waitingChatState), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/tasks/free-accept-ui/commits" || url.pathname === "/api/tasks/free-reviewing-ui/commits" || url.pathname === "/api/tasks/post-merge-ui/commits") {
    return Promise.resolve(new Response(JSON.stringify({ branch: "ash/free-accept-ui", commits: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }
  if (url.pathname === "/api/tasks/free-accept-ui/diff" || url.pathname === "/api/tasks/free-reviewing-ui/diff" || url.pathname === "/api/tasks/post-merge-ui/diff") {
    return Promise.resolve(new Response(JSON.stringify({
      available: true,
      sourceBranch: url.pathname.includes("post-merge-ui") ? "main@11111111" : "ash/free-accept-ui",
      targetBranch: url.pathname.includes("post-merge-ui") ? "main@22222222" : "main",
      mergeBase: url.pathname.includes("post-merge-ui") ? "11111111aaaaaaaa" : "0123456789abcdef",
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

const postMergeTask = {
  ...acceptanceTask,
  id: "post-merge-ui",
  title: "已验收的自由任务",
  stage: "accepted",
  acceptedTargetBranch: "main",
  acceptedBaseCommit: "11111111aaaaaaaa",
  acceptedMergeCommit: "22222222bbbbbbbb",
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

function PostMergeFixture() {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [workflowState, setWorkflowState] = useState(postMergeState);
  const latest = workflowState.reviews.find((run) => run.target?.kind === "accepted_merge");
  const target = {
    branch: postMergeTask.acceptedTargetBranch!,
    baseCommit: postMergeTask.acceptedBaseCommit!,
    mergeCommit: postMergeTask.acceptedMergeCommit!,
  };
  return (
    <section className="post-merge-fixture">
      <TaskHeader
        task={postMergeTask}
        conversationMarkdown=""
        busy={false}
        refreshing={false}
        reviewOpen={reviewOpen}
        onTitle={async () => undefined}
        onTogglePin={async () => undefined}
        onPrimary={() => undefined}
        onRequeue={() => undefined}
        onArchive={() => undefined}
        onRefresh={() => undefined}
        onReview={() => setReviewOpen((open) => !open)}
        postMergeReviewLabel={latest?.status === "reviewing" ? "查看合并审查" : latest ? "再次审查合并结果" : "审查合并结果"}
        onPostMergeReview={() => setDialogOpen(true)}
        onDelete={() => undefined}
        indicatorForTask={() => null}
        notify={() => undefined}
      />
      {reviewOpen && <TaskReviewWorkspace task={postMergeTask} allTasks={[postMergeTask]} onTaskUpdated={() => undefined} notify={() => undefined} onPostMergeReview={() => setDialogOpen(true)} />}
      {dialogOpen && <FreeReviewDialog taskId={postMergeTask.id} state={workflowState} reservationMode={false} postMergeTarget={target} onChanged={setWorkflowState} onClose={() => setDialogOpen(false)} notify={() => undefined} />}
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

const waitingChatTask = {
  id: "free-waiting-task",
  title: "接力刚落地的任务",
  status: "running",
  mode: "single",
  parentId: null,
  reviewOf: null,
  workflowMode: "free",
  // 系统塞的接力前言。前端曾把它一律读成「用户在等续跑」，把整颗按钮灰掉。
  resumePrompt: "【任务接力】本任务从另一台机器接力到本机继续。",
} as Task;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div>
      <div style={{ display: "grid", gap: 6, width: 760, margin: "12px 0 12px auto", background: "white", padding: 8 }}>
        <div className="toolbar-repair-fixture"><FreeWorkflowToolbar task={repairTask} notify={() => undefined} /></div>
        <div className="toolbar-chat-rework-fixture"><FreeWorkflowToolbar task={manualChatTask} notify={() => undefined} /></div>
        <div className="toolbar-waiting-fixture"><FreeWorkflowToolbar task={waitingChatTask} notify={() => undefined} /></div>
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
      <PostMergeFixture />
      <aside className="inspector-host post-merge-inspector-fixture" style={{ width: 380, height: 420, marginTop: 20, marginLeft: "auto" }}>
        <FreeWorkflowInspector task={postMergeTask} reviewOnly onOpenReview={() => undefined} onOpenTask={() => undefined} notify={() => undefined} />
      </aside>
      <aside className="inspector-host repair-fixture" style={{ width: 380, height: 360, marginTop: 20, marginLeft: "auto" }}>
        <FreeWorkflowInspector task={repairTask} reviewOnly notify={() => undefined} />
      </aside>
    </div>
  </StrictMode>,
);
