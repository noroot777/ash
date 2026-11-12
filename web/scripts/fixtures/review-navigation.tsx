// 会话里那一句审查结论点过去，右侧审查格要展开**那一场的那一轮**（第 1 轮审查 F2）。
// 两场派审都有「第 1 轮」；审查记录要过一会儿才读到；就地验证走另一个面板。
import { StrictMode, useCallback, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewRun, Task, TaskReviewInfo } from "@ash/shared";
import { FreeReviewPane } from "../../src/free-workflow/FreeReviewPane.tsx";
import { InspectorNavProvider, type InspectorNav, type InspectorRequest } from "../../src/inspector/nav.tsx";
import { api } from "../../src/lib/api.ts";
import { TaskReviewRounds } from "../../src/review/TaskReviewRounds.tsx";
import { reviewTargetRequest, type ReviewTarget } from "../../src/review/reviewTarget.ts";
import type { ConversationReviewLane } from "../../src/task-detail/conversationReviewLanes.ts";
import { ReviewerLane } from "../../src/task-detail/ReviewerLane.tsx";
import type { TaskReviewState } from "../../src/team/ReviewEvidence.tsx";
import "../../src/styles/global.css";

declare global {
  interface Window {
    __releaseReviews?: () => void;
    __releaseRounds?: () => void;
    __pendingRequest?: Record<string, () => string | null>;
  }
}

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  if (url.pathname.startsWith("/api/")) return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  return nativeFetch(input, init);
};

const run = (id: string, at: string, name: string): FreeReviewRun => ({
  id, reviewerName: name, reviewerId: null, agentType: "codex", executorId: null, model: null, reasoningEffort: null,
  checkMode: "logic", note: null, retryLimit: 0, currentRound: 1, status: "passed", createdAt: at, updatedAt: at, finishedAt: at,
  rounds: [{ round: 1, status: "passed", conclusion: "verified", reviewedCommit: "head", reportMarkdown: `# ${name}`, screenshots: [], startedAt: at, endedAt: at }],
} as unknown as FreeReviewRun);
const runs = [run("old-run", "2026-11-11T10:00:00.000Z", "旧一场"), run("new-run", "2026-11-12T10:00:00.000Z", "新一场")];

// 审查记录由测试放行：放行之前点过来的那一下必须等着，不能被当场收掉。
let releaseReviews: () => void = () => {};
const reviewsLoaded = new Promise<void>((resolve) => { releaseReviews = resolve; });
window.__releaseReviews = () => releaseReviews();
api.freeWorkflow = (async (taskId: string) => {
  await reviewsLoaded;
  return {
    taskId, stateVersion: 1, selectedReviewerId: null, workspaceHead: "head", workspaceDirty: false,
    reviewReservation: { armed: false }, preview: { running: false }, executions: [], reviews: runs,
  };
}) as unknown as typeof api.freeWorkflow;

const task = { id: "nav-task", title: "导航", projectId: "p", mode: "single", status: "done", stage: "implemented", workflowMode: "free", parentId: null, archived: false } as unknown as Task;

const lane = (id: string, source: ConversationReviewLane["source"], runId: string | null, round: number, label: string): ConversationReviewLane => ({
  kind: "review-lane", id, source, round, totalRounds: null, title: `第 ${round} 轮`, items: [], reviewerLabel: label,
  reviewerModel: null, reviewerEffort: null, note: null, startedAt: null, endedAt: null, conclusion: "verified",
  complete: true, reportAvailable: false, report: null, runId, defaultCollapsed: true, findings: null,
});

const verifyInfo: TaskReviewInfo = {
  reviewRequested: true,
  rounds: [1, 2].map((round) => ({ round, where: "inline", reviewTaskId: null, reviewTaskStatus: "done", conclusion: "verified", reportMarkdown: `# 验证 ${round}`, screenshots: [] })),
} as unknown as TaskReviewInfo;

// 宿主那一份的语义（InspectorHost）：一份请求，收下（seq 对得上）才清掉。真实页面上一个任务只
// 挂其中一种审查格，所以两种各给一个宿主。
function Host({ name, lanes, children }: { name: string; lanes: ConversationReviewLane[]; children: ReactNode }) {
  const [request, setRequest] = useState<InspectorNav["request"]>(null);
  const seq = useRef(0);
  const consume = useCallback((done: number) => setRequest((current) => (current?.seq === done ? null : current)), []);
  const open = (target: ReviewTarget | undefined) => {
    const params: InspectorRequest = target ? reviewTargetRequest(target) : {};
    seq.current += 1;
    setRequest({ id: "review", params, seq: seq.current });
  };
  (window.__pendingRequest ??= {})[name] = () => (request ? JSON.stringify(request.params) : null);
  return (
    <InspectorNavProvider value={{ request, consume, openTab: () => {} }}>
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div>{lanes.map((item) => <div key={item.id} data-lane={item.id}><ReviewerLane taskId={task.id} lane={item} onOpenRound={open}>{null}</ReviewerLane></div>)}</div>
        <div data-pane={name}>{children}</div>
      </section>
    </InspectorNavProvider>
  );
}

function Shell() {
  const [rounds, setRounds] = useState<TaskReviewState>({ info: null, loading: true, error: null, reload: async () => {} });
  window.__releaseRounds = () => setRounds((current) => ({ ...current, info: verifyInfo, loading: false }));
  return (
    <main style={{ display: "grid", gap: 24, padding: 24 }}>
      <Host name="free" lanes={[lane("old", "free", "old-run", 1, "旧一场"), lane("new", "free", "new-run", 1, "新一场")]}>
        <FreeReviewPane task={task} notify={() => {}} />
      </Host>
      <Host name="verify" lanes={[lane("verify", "inline", null, 1, "就地验证")]}>
        <TaskReviewRounds taskId={task.id} state={rounds} emptyMessage="没有记录" />
      </Host>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Shell /></StrictMode>);
