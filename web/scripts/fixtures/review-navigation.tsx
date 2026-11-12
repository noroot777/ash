// 会话里那一句审查结论点过去，右侧审查格要展开**那一场的那一轮**（第 1、2 轮审查 F2）。
// 两场派审都有「第 1 轮」，旧那场还启动失败重跑过一次；审查记录要过一会儿才读到；就地验证走
// 另一个面板。派审那一侧的卡片是拿时间线经 conversationFeedRows 推出来的（跟会话流同一条路），
// 点不点得过去也走会话流同一个判据（laneRoundOpener）。
import { StrictMode, useCallback, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewRun, Task, TaskReviewInfo } from "@ash/shared";
import { FreeReviewPane } from "../../src/free-workflow/FreeReviewPane.tsx";
import { InspectorNavProvider, type InspectorNav, type InspectorRequest } from "../../src/inspector/nav.tsx";
import { api } from "../../src/lib/api.ts";
import { TaskReviewRounds } from "../../src/review/TaskReviewRounds.tsx";
import { reviewTargetRequest, type ReviewTarget } from "../../src/review/reviewTarget.ts";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import { conversationFeedRows, type ConversationReviewLane } from "../../src/task-detail/conversationReviewLanes.ts";
import { ReviewerLane, laneRoundOpener } from "../../src/task-detail/ReviewerLane.tsx";
import type { TaskReviewState } from "../../src/team/ReviewEvidence.tsx";
import "../../src/styles/global.css";

declare global {
  interface Window {
    __releaseReviews?: () => void;
    __releaseRounds?: () => void;
    __pendingRequest?: Record<string, () => string | null>;
    __lanes?: Record<string, { title: string; runId: string | null }[]>;
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

// 时间线上的审查段。旧那场是升级前落的（开始那一条不带 runId，只能按时间窗口配）：第一次启动
// 失败，重跑那次才出结论——两张卡都是旧那场的第 1 轮。新那场的开始那一条带着 runId。还有一张
// 配不上任何一场的老卡、一张就地验证卡（自由工作流的审查格不装它）：这两张点了都只在原处展开。
type Notice = Record<string, unknown>;
const start = (round: number | null, extra: Notice = {}): Notice => ({ kind: "review.start", source: "free", round, reviewer: "审查", ...extra });
const verdict = (round: number | null, value: string, extra: Notice = {}): Notice => ({ kind: "review.verdict", source: "free", round, verdict: value, reviewer: "审查", ...extra });
const session = { id: "s-main", taskId: "nav-task", agentType: "claude", role: "main", startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-13T00:00:00.000Z" };
const rowsOf = (timeline: [string, Notice][]) => conversationFeedRows(
  buildConversationItems([{
    session,
    output: timeline.map(([at, notice]) => `\x1e${JSON.stringify({ t: "system", text: "审查", notice, at })}`).join("\n"),
    trace: [],
  }] as never, [session] as never, []),
  { reviews: runs },
).filter((row): row is ConversationReviewLane => row.kind === "review-lane");
const freeLanes = rowsOf([
  ["2026-11-10T09:00:00.000Z", start(2)],
  ["2026-11-10T09:10:00.000Z", verdict(2, "passed")],
  ["2026-11-11T10:01:00.000Z", start(1)],
  ["2026-11-11T10:02:00.000Z", verdict(1, "aborted")],
  ["2026-11-11T10:05:00.000Z", start(1, { rerun: true })],
  ["2026-11-11T10:30:00.000Z", verdict(1, "passed")],
  ["2026-11-11T11:00:00.000Z", start(1, { source: "inline" })],
  ["2026-11-11T11:10:00.000Z", verdict(1, "passed", { source: "inline" })],
  ["2026-11-12T10:01:00.000Z", start(1, { runId: "new-run" })],
  ["2026-11-12T10:30:00.000Z", verdict(1, "passed")],
]);
const laneNames = ["legacy", "old-failed", "old", "inline-in-free", "new"];
// 同号不同场接连开始（中间没有收尾那一条）：是两场，不是同一轮重跑。
const supersededLanes = rowsOf([
  ["2026-11-11T10:01:00.000Z", start(1, { runId: "old-run" })],
  ["2026-11-12T10:01:00.000Z", start(1, { runId: "new-run" })],
  ["2026-11-12T10:30:00.000Z", verdict(1, "passed")],
]);
window.__lanes = Object.fromEntries([["free", freeLanes], ["superseded", supersededLanes]]
  .map(([name, lanes]) => [name, (lanes as ConversationReviewLane[]).map((item) => ({ title: item.title, runId: item.runId }))]));

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
function Host({ name, lanes, names, workflowMode, children }: {
  name: string;
  lanes: ConversationReviewLane[];
  names: string[];
  workflowMode: string;
  children: ReactNode;
}) {
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
        <div>{lanes.map((item, index) => (
          <div key={item.id} data-lane={names[index]}>
            <ReviewerLane taskId={task.id} lane={item} onOpenRound={laneRoundOpener(item, workflowMode, open)}><p>这一轮的经过</p></ReviewerLane>
          </div>
        ))}</div>
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
      <Host name="free" lanes={freeLanes} names={laneNames} workflowMode="free">
        <FreeReviewPane task={task} notify={() => {}} />
      </Host>
      <Host name="verify" lanes={[lane("verify", "inline", null, 1, "就地验证")]} names={["verify"]} workflowMode="preset">
        <TaskReviewRounds taskId={task.id} state={rounds} emptyMessage="没有记录" />
      </Host>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Shell /></StrictMode>);
