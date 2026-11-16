import type { Task } from "@ash/shared";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import { TaskReviewWorkspace } from "../../src/review/TaskReviewWorkspace.tsx";

// 已验收之后验收台第一行那颗「审查这次合并」的另外两种说法，从 free-workflow-inspector.tsx
// 拆出来（那份已经贴着 700 行）。「审查这次合并 → 合并审查中」那一程由主台子的 post-merge-ui 演；
// 这里补两张静态的：
//   · post-merge-again-ui：上一次合并审查已经出了结论 → 第一行写「再审这次合并」；
//   · post-merge-pending-ui：「合并后不提交」那一档还欠一步提交（no_commit 且没有合并提交）→
//     第一行不给这颗键（审的是还不存在的那个提交），前提列里是「待提交」那一行。
//
// 本模块在主台子之前求值：这里先包一层 fetch，主台子接着把它当 nativeFetch 再包一层，
// 它不认识的路径落到这里，这里也不认识的再落到真正的 fetch。

const json = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));

const base = {
  projectId: "project-ui", parentId: null, body: "", mode: "single", status: "done", stage: "accepted",
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "codex",
  createdAt: "2026-08-09T01:00:00.000Z", updatedAt: "2026-08-09T03:00:00.000Z", endedAt: "2026-08-09T01:09:00.000Z",
  workflowMode: "free", workflow: null, useWorktree: true, worktreeBase: "main", archived: false,
  acceptedTargetBranch: "main", acceptedBaseCommit: "11111111aaaaaaaa",
};

export const reviewedAgainTask = {
  ...base, id: "post-merge-again-ui", title: "合并审查已出结论", acceptedMergeCommit: "33333333cccccccc",
} as unknown as Task;

export const pendingCommitTask = {
  ...base, id: "post-merge-pending-ui", title: "合并后还欠一步提交",
  acceptedMergeMethod: "no_commit", acceptedMergeCommit: null,
} as unknown as Task;

const freeState = (taskId: string, reviews: FreeWorkflowApiState["reviews"]): FreeWorkflowApiState => ({
  taskId, selectedReviewerId: null, stateVersion: 1, workspaceHead: null, workspaceDirty: null,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, runId: null },
  preview: { running: false, url: null, port: null, command: null, startedAt: null },
  executions: [{ id: `${taskId}-exec`, status: "completed", startedAt: "2026-08-09T01:00:00.000Z", endedAt: "2026-08-09T01:09:00.000Z" }],
  reviews,
} as FreeWorkflowApiState);

const finishedMergeReview = {
  id: "post-merge-again-run", reviewerId: "reviewer-one", reviewerName: "Codex 审查", agentType: "codex",
  executorId: null, executorLabel: null, model: null, reasoningEffort: null, checkMode: "logic", note: null,
  target: { kind: "accepted_merge", branch: "main", baseCommit: "11111111aaaaaaaa", mergeCommit: "33333333cccccccc", repairTaskId: null },
  retryLimit: 0, currentRound: 1, status: "passed",
  rounds: [{
    round: 1, status: "passed", conclusion: "verified", reviewedCommit: "33333333cccccccc", reportMarkdown: "# 通过",
    screenshots: [], startedAt: "2026-08-09T02:00:00.000Z", endedAt: "2026-08-09T02:10:00.000Z",
  }],
  createdAt: "2026-08-09T02:00:00.000Z", updatedAt: "2026-08-09T02:10:00.000Z", finishedAt: "2026-08-09T02:10:00.000Z",
} as unknown as FreeWorkflowApiState["reviews"][number];

const states: Record<string, FreeWorkflowApiState> = {
  [reviewedAgainTask.id]: freeState(reviewedAgainTask.id, [finishedMergeReview]),
  [pendingCommitTask.id]: freeState(pendingCommitTask.id, []),
};

const innerFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  const hit = /^\/api\/tasks\/(post-merge-again-ui|post-merge-pending-ui)\/(free-workflow|commits|diff|accept-gate|pending-merge)$/.exec(url.pathname);
  if (!hit || (init?.method ?? "GET") !== "GET") return innerFetch(input, init);
  const [, taskId, what] = hit;
  if (what === "free-workflow") return json(states[taskId]);
  if (what === "commits") return json({ branch: `ash/${taskId}`, commits: [] });
  if (what === "diff") {
    return json({ available: true, sourceBranch: "main@11111111", targetBranch: "main@33333333", mergeBase: "11111111aaaaaaaa",
      diff: "", files: [], truncated: false, limitBytes: 1024 });
  }
  if (what === "accept-gate") return json({ command: null, running: null, latest: null, basis: null });
  return json({ state: {
    taskId, kind: "staged", message: "改动还暂存在 main 的索引里，没有落成提交。", repoPath: "/repo",
    targetBranch: "main", sourceBranch: `ash/${taskId}`, sourceBranchExists: true,
    stagedFiles: ["src/a.ts"], dirtyFiles: [], canCommit: true, canRemerge: false,
  } });
};

/** 两张已验收的验收台并排；「审查这次合并」那颗键只有在第一行有地方去时才出。 */
export function PostMergeVariants({ onPostMergeReview }: { onPostMergeReview: () => void }) {
  return <>
    {[reviewedAgainTask, pendingCommitTask].map((task) => (
      <section key={task.id} className={`${task.id}-fixture`}>
        <TaskReviewWorkspace task={task} allTasks={[task]} onTaskUpdated={() => undefined} notify={() => undefined}
          onPostMergeReview={onPostMergeReview} />
      </section>
    ))}
  </>;
}
