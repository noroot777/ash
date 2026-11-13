// 一轮审查没给出结论之后，会话里「第 1 轮审查没有给出结论」那颗气泡下面紧贴的那一句（原因 +
// 「继续本轮审查」），以及审查格里同一轮的原因和原话。
//
// 会话照 EhQtqns9fnG2 落盘的样子搭：实现会话里一条带 runId 的「开始」，审查者会话里审查者说过话、
// 一条**不带 runId** 的「没有给出结论」，之后是那一轮的原因记录，再往后一条别的提醒（被挡回的
// 「重跑上一回合」）。每一份都照 TaskDetail 那条链路从审查状态推出动作（freeReviewRetryIdentity →
// turnRetryTarget → 审查档）：
//   legacy   老记录：原因记录是老服务端那句「报告可能写完了…report_stage…」，服务端现算出了原因；
//   typed    新记录：原因记录是带类型的 review.no_verdict；
//   vague    类型不明（只说得出退出码）：原话直接摆出来；
//   blocked  这一轮不能续：没有按钮，原因照说；
//   newchain 另开了一条链（能续的是新那一场）：老那一轮没有按钮，原因照说。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewRound, FreeReviewRun, Session, Task } from "@ash/shared";
import type { ReviewNoVerdict } from "@ash/shared/timeline-notice";
import { FreeReviewPane } from "../../src/free-workflow/FreeReviewPane.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import { freeReviewRetryIdentity, turnRetryTarget, type ReviewRetryAction } from "../../src/task-detail/turnRetry.ts";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import "../../src/styles/global.css";

const T0 = "2026-11-13T10:51:51.318Z";
const START = "2026-11-13T11:14:58.892Z";
const REV = "2026-11-13T11:15:00.155Z";
const END = "2026-11-13T11:17:45.348Z";
const SAID = "unexpected status 503 Service Unavailable: auth_unavailable: no auth available";
const TYPED: ReviewNoVerdict = { kind: "interrupted", reason: "模型上游连不上（503）", said: SAID };
const VAGUE: ReviewNoVerdict = { kind: "interrupted", reason: "执行器异常退出（exit 1）", said: SAID, vague: true };
const LEGACY_GUESS = "这一轮的审查报告可能已经写完了，只是结论没能上报到 ash。这一轮没查到直接证据；最可能的原因是审查者手上根本没有 report_stage 这个工具（自查：codex mcp list --json（看 ash 在不在、enabled 是不是 true））：报告照样写得完整，只有最后一步上报做不到。修好之后点「继续本轮审查」，它会接着上一次的上下文只补上报，不用重跑这一轮。";

const round = (runId: string, cause: ReviewNoVerdict | undefined, retry: boolean, at = START): FreeReviewRound => ({
  round: 1, status: "error", conclusion: null, reviewedCommit: "c1", reportMarkdown: "", screenshots: [],
  dispute: null, startedAt: at, endedAt: END, ...(cause ? { noVerdict: cause } : {}),
  ...(retry ? { retry: { generation: "g1", sessionId: "rev" } } : {}),
});
const run = (id: string, only: FreeReviewRound, createdAt = START): FreeReviewRun => ({
  id, reviewerId: null, reviewerName: "顶级审查", agentType: "codex", executorId: null, executorLabel: null,
  model: null, reasoningEffort: null, checkMode: "logic", note: null, retryLimit: 1, currentRound: 1, status: "failed",
  rounds: [only], createdAt, updatedAt: END, finishedAt: END,
});
const state = (taskId: string, reviews: FreeReviewRun[]): FreeWorkflowApiState => ({
  taskId, stateVersion: 1, workspaceHead: "c1", workspaceDirty: false, reviewTurn: false, selectedReviewerId: null,
  reviewReservation: { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
  preview: { running: false, starting: false, hasLog: false, url: null, port: null, command: null, startedAt: null },
  executions: [], reviews,
} as unknown as FreeWorkflowApiState);

const LATER = "2026-11-13T12:00:00.000Z";
const STATES: Record<string, FreeWorkflowApiState> = {
  "t-legacy": state("t-legacy", [run("run-1", round("run-1", TYPED, true))]),
  "t-typed": state("t-typed", [run("run-1", round("run-1", TYPED, true))]),
  "t-vague": state("t-vague", [run("run-1", round("run-1", VAGUE, true))]),
  "t-blocked": state("t-blocked", [run("run-1", round("run-1", TYPED, false))]),
  // 新那一场排在前面（服务端按创建时间倒序给）。
  "t-newchain": state("t-newchain", [run("run-2", round("run-2", TYPED, true, LATER), LATER), run("run-1", round("run-1", TYPED, false))]),
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

const line = (text: string, notice: unknown, at: string) => `\x1e${JSON.stringify({ t: "system", text, at, aside: true, notice })}`;
const session = (id: string, taskId: string, role: string, startedAt: string, exitStatus: number) => ({
  id, taskId, agentType: "codex", role, executor: "codex", startedAt, endedAt: END, exitStatus,
}) as unknown as Session;

function Case({ id }: { id: keyof typeof STATES }) {
  const task = { id, title: id, body: "", mode: "single", status: "done", agentType: "codex", workflowMode: "free", archived: false, stage: null } as unknown as Task;
  const sessions = [session("impl", id, "single", T0, 0), session("rev", id, "reviewer", REV, 1)];
  const impl = ["改好了，构建通过。", line("自由工作流第 1 轮审查开始", { kind: "review.start", source: "free", round: 1, reviewer: "顶级审查", runId: "run-1" }, START)].join("\n");
  const why = id === "t-legacy"
    ? line(LEGACY_GUESS, { kind: "alert" }, "2026-11-13T11:17:45.358Z")
    : line("这一轮审查是中途断掉的：模型上游连不上（状态码 503），执行器以 exit 1 结束。这一轮的报告还没写。等上游恢复后点「继续本轮审查」。",
      { kind: "review.no_verdict", source: "free", runId: "run-1", round: 1, cause: id === "t-vague" ? VAGUE : TYPED }, "2026-11-13T11:17:45.358Z");
  const rev = [
    "先读 diff，再跑一遍构建。",
    line("自由工作流第 1 轮审查未能正常给出结论，已停止自动链。", { kind: "review.verdict", source: "free", round: 1, verdict: "inconclusive", reviewer: "顶级审查" }, END),
    why,
    line("「重跑上一回合」没有执行：队列前面还有未完成的任务，等它们跑完再来。", { kind: "alert" }, "2026-11-13T11:20:00.000Z"),
  ].join("\n");
  const items = buildConversationItems([
    { session: sessions[0]!, output: impl, trace: [] },
    { session: sessions[1]!, output: rev, trace: [] },
  ], sessions, [] as never);
  const target = turnRetryTarget(task, items, { reviewRetry: freeReviewRetryIdentity(STATES[id]!.reviews), sessions });
  const reviewRetry: ReviewRetryAction | null = target?.kind === "review"
    ? { review: target.review, run: async () => { log.__retried.push(id); } }
    : null;
  return (
    <section className={`${id}-fixture`} style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16, marginBottom: 24 }}>
      <div className="feed"><ConversationFeed task={task} items={items} sessions={sessions} questionHistory={[]} loading={false} error={null}
        reviews={STATES[id]!.reviews} reviewRetry={reviewRetry} /></div>
      <div className="pane"><FreeReviewPane task={task} notify={() => {}} onOpenReview={() => {}} reviewRetry={reviewRetry} /></div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ background: "var(--bg)", padding: 16 }}>
      <Case id="t-legacy" />
      <Case id="t-typed" />
      <Case id="t-vague" />
      <Case id="t-blocked" />
      <Case id="t-newchain" />
    </div>
  </StrictMode>,
);
