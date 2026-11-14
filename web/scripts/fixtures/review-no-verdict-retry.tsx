// 一轮审查中途断了（模型上游连不上）之后，「继续本轮审查」在审查格和会话尾注上的样子。
//
// 三种情形并排，每一份都照 TaskDetail 那条链路从审查状态推出动作（freeReviewRetryIdentity →
// turnRetryTarget → 审查档），不是手塞一个 prop；任务头照样摆出来，好看它头上没有回合级的那颗图标：
//   retry   这一轮能续（服务端给了 round.retry）：审查格主按钮、尾注都带「继续本轮审查」；
//   blocked 这一轮没结论但不能续（没有 round.retry）：两处都不带，主按钮照旧是「再审一轮」；
//   after   续过了（这一轮又审起来了，round.retry 没了）：两处都没了；
//   merge   合并结果审查中断、能续：同样按轮次身份给「继续本轮审查」，「再审一次」退到更多里。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewRound, FreeReviewRun, Session, Task } from "@ash/shared";
import { FreeReviewPane } from "../../src/free-workflow/FreeReviewPane.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { TaskHeader } from "../../src/task-detail/TaskHeader.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import { freeReviewRetryIdentity, turnRetryTarget, type ReviewRetryAction } from "../../src/task-detail/turnRetry.ts";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

const at = "2026-11-13T11:15:00.000Z";
const end = "2026-11-13T11:17:43.000Z";
const CAUSE = { kind: "interrupted", reason: "模型上游连不上（503）" } as const;

const round = (over: Partial<FreeReviewRound>): FreeReviewRound => ({
  round: 1, status: "error", conclusion: null, reviewedCommit: "c1", reportMarkdown: "", screenshots: [],
  dispute: null, startedAt: at, endedAt: end, noVerdict: CAUSE, ...over,
});
const MERGE_TARGET = { kind: "accepted_merge", branch: "feat/ui-revamp", baseCommit: "b0", mergeCommit: "m1abcdef9", repairTaskId: null } as const;
const run = (status: FreeReviewRun["status"], only: FreeReviewRound, target?: FreeReviewRun["target"]): FreeReviewRun => ({
  ...(target ? { target } : {}),
  id: "run-1", reviewerId: null, reviewerName: "codex 审查", agentType: "codex", executorId: null, executorLabel: null,
  model: null, reasoningEffort: null, checkMode: "logic", note: null, retryLimit: 1, currentRound: 1, status,
  rounds: [only], createdAt: at, updatedAt: end, finishedAt: status === "reviewing" ? null : end,
});
const state = (taskId: string, reviews: FreeReviewRun[]): FreeWorkflowApiState => ({
  taskId, stateVersion: 1, workspaceHead: "c1", workspaceDirty: false, reviewTurn: false, selectedReviewerId: null,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
  preview: { running: false, starting: false, hasLog: false, url: null, port: null, command: null, startedAt: null },
  executions: [], reviews,
} as unknown as FreeWorkflowApiState);

const STATES: Record<string, FreeWorkflowApiState> = {
  "t-retry": state("t-retry", [run("failed", round({ retry: { generation: "g1", sessionId: "rev" } }))]),
  "t-blocked": state("t-blocked", [run("failed", round({}))]),
  "t-after": state("t-after", [run("reviewing", round({ status: "reviewing", noVerdict: undefined, endedAt: null }))]),
  "t-merge": state("t-merge", [run("failed", round({ retry: { generation: "g1", sessionId: "rev" } }), MERGE_TARGET)]),
};

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url, window.location.origin);
  const hit = /\/tasks\/([^/]+)\/free-workflow$/.exec(url.pathname);
  if (hit && STATES[hit[1]!]) return Promise.resolve(new Response(JSON.stringify(STATES[hit[1]!]), { headers: { "content-type": "application/json" } }));
  return nativeFetch(input, init);
};

const log = window as unknown as { __retried: string[] };
log.__retried = [];

// 会话：审查者说了两句、跑了构建，然后 ash 落下没结论那句和原因那句（同 server 写的形状）。
const session = (taskId: string) => ({
  id: "rev", taskId, agentType: "codex", role: "main", executor: "codex", startedAt: at, endedAt: end, exitStatus: 1,
}) as unknown as Session;
const line = (text: string, notice: unknown) => `\x1e${JSON.stringify({ t: "system", text, at: end, aside: true, notice })}`;
const output = (source: "free" | "merge") => [
  "先读 diff，再跑一遍构建。",
  line("这一轮审查是中途断掉的：模型上游连不上（状态码 503），执行器以 exit 1 结束。这一轮的报告还没写。等上游恢复后点「继续本轮审查」，它会接着上一次的上下文从中断处往下审，不用从头重跑这一轮。",
    { kind: "review.no_verdict", source, runId: "run-1", round: 1, cause: CAUSE }),
].join("\n");

function Case({ id }: { id: keyof typeof STATES }) {
  const merged = id === "t-merge"
    ? { stage: "accepted", acceptedTargetBranch: MERGE_TARGET.branch, acceptedBaseCommit: MERGE_TARGET.baseCommit, acceptedMergeCommit: MERGE_TARGET.mergeCommit }
    : { stage: null };
  const task = {
    id, title: id, body: "", mode: "single", status: "done", agentType: "codex", workflowMode: "free", archived: false,
    parentId: null, queueId: null, handoff: null, question: null, resumePrompt: null, verifyRound: null, ...merged,
  } as unknown as Task;
  const sessions = [session(id)];
  const items = buildConversationItems([{ session: sessions[0]!, output: output(id === "t-merge" ? "merge" : "free"), trace: [] }], sessions, [] as never);
  // TaskDetail 同一条推法：审查格、尾注吃的都是这一份。
  const target = turnRetryTarget(task, items, { reviewRetry: freeReviewRetryIdentity(STATES[id]!.reviews), sessions });
  const reviewRetry: ReviewRetryAction | null = target?.kind === "review"
    ? { review: target.review, run: async () => { log.__retried.push(id); } }
    : null;
  const noop = () => {};
  return (
    <section className={`${id}-fixture`} style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16, marginBottom: 24 }}>
      <div style={{ gridColumn: "1 / -1" }}>
        <TaskHeader task={task} allTasks={[task]} conversationMarkdown="" busy={false} refreshing={false} reviewOpen={false}
          onTitle={async () => {}} onTogglePin={async () => {}} onPrimary={noop} onRequeue={noop} onArchive={noop} onRefresh={noop}
          onReview={noop} onOpenTask={noop} onDelete={noop} notify={noop} />
      </div>
      <div className="feed"><ConversationFeed task={task} items={items} sessions={sessions} questionHistory={[]} loading={false} error={null}
        reviews={STATES[id]!.reviews} reviewRetry={reviewRetry} /></div>
      <div className="pane"><FreeReviewPane task={task} notify={() => {}} onOpenReview={() => {}} reviewRetry={reviewRetry} /></div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ background: "var(--bg)", padding: 16 }}>
      <Case id="t-retry" />
      <Case id="t-blocked" />
      <Case id="t-after" />
      <Case id="t-merge" />
    </div>
  </StrictMode>,
);
