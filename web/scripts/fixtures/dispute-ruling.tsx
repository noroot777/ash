// 回复框顶上那一行（DisputeRulingDock）：有一条驳回等你裁定时，几种下一步排成一行纯文字的切换键，
// 点一颗回复框就成了那一步。每一份是各自的任务（要点草稿按任务存），审查状态在 Stage 里，接口回来的
// 状态照样落回去——跟 TaskDetail 里 `free.setState` 一个路数。
//
// 右边那一条是审查格那一轮下面的驳回 / 辩论 / 裁定（FreeReviewDisputeRecord），用来钉「这里没有裁定的
// 按钮」和驳回那一段的读法。在问你的那一份跟任务页一样接着答题卡（给了 `onAnswer`）。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewDebate, FreeReviewDispute, FreeReviewRun, Task } from "@ash/shared";
import { useDisputeRulingDock } from "../../src/free-workflow/DisputeRulingDock.tsx";
import { FreeReviewRoundBody } from "../../src/free-workflow/FreeReviewRoundBody.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import type { FreeWorkflowApiState } from "../../src/lib/api.ts";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import "../../src/styles/global.css";

const baseTask = {
  id: "t", projectId: "p1", groupId: null, parentId: null, title: "裁定", body: "", mode: "single",
  status: "paused", stage: null, archived: false, handoff: null, question: null, workflowMode: "free",
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude",
  createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
} as unknown as Task;

const DISPUTE: FreeReviewDispute = {
  summary: "第 1 条读错了代码，另外两条我认、但该另开任务做。",
  reason: "第 1 条：那段代码只在单线程里跑，**不存在**并发写。",
  deferReason: "第 2、3 条成立，但都在与本任务无关的调度模块里。",
  at: "2026-11-15T01:00:00.000Z", resolution: null, resolvedAt: null, resolutionNote: null,
  deferredTaskId: null, supersededAt: null, debates: [],
} as unknown as FreeReviewDispute;

function round(number: number, dispute: FreeReviewDispute | null) {
  return {
    round: number, status: "failed", conclusion: "verify_failed", reviewedCommit: `c${number}`,
    reportMarkdown: `# 第 ${number} 轮报告\n\n三条意见。`, screenshots: [], dispute,
    startedAt: "2026-11-15T00:30:00.000Z", endedAt: "2026-11-15T00:50:00.000Z",
  };
}

function runOf(dispute: Partial<FreeReviewDispute> | null, patch: Partial<FreeReviewRun> = {}, rounds?: ReturnType<typeof round>[]): FreeReviewRun {
  return {
    id: "run-1", reviewerId: null, reviewerName: "顶级审查", agentType: "codex", executorId: null, executorLabel: null,
    model: null, reasoningEffort: null, checkMode: "logic", note: null, retryLimit: 3, currentRound: 1, status: "stopped",
    rounds: rounds ?? [round(1, dispute ? { ...DISPUTE, ...dispute } as FreeReviewDispute : null)],
    createdAt: "2026-11-15T00:30:00.000Z", updatedAt: "2026-11-15T01:00:00.000Z", finishedAt: "2026-11-15T00:50:00.000Z",
    ...patch,
  } as unknown as FreeReviewRun;
}

const finishedDebate = {
  id: "debate-1", status: "finished", exchanges: 1, currentSide: null, verdict: "partial",
  startedAt: "2026-11-15T01:10:00.000Z", finishedAt: "2026-11-15T01:20:00.000Z",
  turns: [1, 2, 3].map((seq) => ({
    seq, side: seq % 2 ? "reviewer" : "executor", summary: `第 ${seq} 段的一句话。`, status: "done",
    statement: `第 ${seq} 段的完整发言。`, startedAt: "2026-11-15T01:10:00.000Z", endedAt: "2026-11-15T01:12:00.000Z",
  })),
} as unknown as FreeReviewDebate;
const runningDebate = { ...finishedDebate, id: "debate-2", status: "running", currentSide: "executor", verdict: null, finishedAt: null,
  turns: finishedDebate.turns.slice(0, 1) } as unknown as FreeReviewDebate;
const reviewingRun = { ...runOf(null), id: "run-2", status: "reviewing", rounds: [] } as unknown as FreeReviewRun;

const store = window as unknown as Record<string, unknown[]>;
const log = (name: string, value: unknown) => { (store[name] ??= []).push(value); };

function Stage({ name, task: patch = {}, reviews: initial, inspector = false }: {
  name: string;
  task?: Partial<Task>;
  reviews: FreeReviewRun[];
  inspector?: boolean;
}) {
  const task = { ...baseTask, ...patch, id: `t-${name}` } as Task;
  const [reviews, setReviews] = useState(initial);
  const override = useDisputeRulingDock({
    task, reviews, known: true,
    onChanged: (state: FreeWorkflowApiState) => setReviews(state.reviews),
    notify: (message) => log(`__notices_${name}`, message),
  });
  // 夹具上的一颗「换一条驳回」：轮询带来新状态的那一下。
  (window as unknown as Record<string, unknown>)[`__swap_${name}`] = (next: FreeReviewRun[]) => setReviews(next);
  return (
    <section className={`${name}-fixture`} style={{ display: "flex", gap: 16, margin: "0 0 28px", alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ReplyBox task={task} hasConversation override={override}
          onSend={async (text) => { log(`__sent_${name}`, text); return { started: true } as never; }}
          onAnswer={task.question ? async (answer) => { log(`__answered_${name}`, answer); } : undefined} />
      </div>
      {inspector && reviews[0]?.rounds[0] && (
        <aside className="fixture-inspector" style={{ width: 320, flex: "none" }}>
          <FreeReviewRoundBody taskId={task.id} run={reviews[0]} round={reviews[0].rounds[0]} dispute={{ task, reviews }} />
        </aside>
      )}
    </section>
  );
}

// 拿来换掉的那一份：第 1 轮那条被新一轮审查取代，第 2 轮又驳回了一次。
(window as unknown as Record<string, unknown>).__replaced = [runOf(null, { currentRound: 2 }, [
  round(1, { ...DISPUTE, supersededAt: "2026-11-15T02:00:00.000Z" } as FreeReviewDispute),
  round(2, { ...DISPUTE, at: "2026-11-15T02:30:00.000Z" } as FreeReviewDispute),
])];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      <main style={{ width: "min(980px, 100%)", margin: "24px auto", background: "var(--bg)" }}>
        <Stage name="open" reviews={[runOf({})]} inspector />
        <Stage name="resolve" reviews={[runOf({})]} />
        <Stage name="fail" reviews={[runOf({})]} />
        <Stage name="replace" reviews={[runOf({})]} />
        {/* 老驳回：没有那一句、也没提转出。 */}
        <Stage name="old" reviews={[runOf({ summary: null, deferReason: "" })]} inspector />
        <Stage name="debated" reviews={[runOf({ debates: [finishedDebate] })]} />
        <Stage name="running" task={{ status: "running" }} reviews={[runOf({})]} />
        <Stage name="reviewing" reviews={[reviewingRun, runOf({})]} />
        <Stage name="debating" reviews={[runOf({ debates: [runningDebate] })]} />
        <Stage name="question" task={{ question: "要不要先停一下？" } as Partial<Task>} reviews={[runOf({})]} />
        <Stage name="locked" task={{ stage: "accepted" } as Partial<Task>} reviews={[runOf({})]} />
        <Stage name="ruled" reviews={[runOf({ resolution: "upheld", resolvedAt: "2026-11-15T02:00:00.000Z" })]} inspector />
      </main>
    </DraftProvider>
  </StrictMode>,
);
