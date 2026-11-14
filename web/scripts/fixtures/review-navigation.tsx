// 会话里那一句审查结论点过去，右侧审查格要展开**那一场的那一轮**（第 1~3 轮审查 F2）。
// 两场派审都有「第 1 轮」，旧那场还启动失败重跑过一次；审查记录要过一会儿才读到，读到的也可能
// 是点之前的旧快照；重读了也没有就说出来、能重试；就地验证走另一个面板。派审那一侧的卡片是拿时间线经 conversationFeedRows 推出来的（跟会话流同一条路），
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
import { ReceiptReviewContext, TurnReceipts } from "../../src/task-detail/TurnReceipts.tsx";
import type { TaskReviewState } from "../../src/team/ReviewEvidence.tsx";
import "../../src/styles/global.css";

declare global {
  interface Window {
    __reviews?: {
      hold: (taskId: string) => void;
      release: (taskId: string) => void;
      set: (taskId: string, ids: string[]) => void;
      fail: (taskId: string, message: string | null) => void;
    };
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
const ghost = run("ghost-run", "2026-11-12T12:00:00.000Z", "后来补上的一场");
const later = run("later-run", "2026-11-12T13:00:00.000Z", "再后来的一场");

// 时间线上的审查段。旧那场是升级前落的（开始那一条不带 runId，只能按时间窗口配）：第一次启动
// 失败，重跑那次才出结论——两张卡都是旧那场的第 1 轮。新那场的开始那一条带着 runId。还有一张
// 配不上任何一场的老卡、一张就地验证卡（自由工作流的审查格不装它）：这两张点了都只在原处展开。
type Notice = Record<string, unknown>;
const start = (round: number | null, extra: Notice = {}): Notice => ({ kind: "review.start", source: "free", round, reviewer: "审查", ...extra });
const verdict = (round: number | null, value: string, extra: Notice = {}): Notice => ({ kind: "review.verdict", source: "free", round, verdict: value, reviewer: "审查", ...extra });
const session = { id: "s-main", taskId: "nav-task", agentType: "claude", role: "main", startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-13T00:00:00.000Z" };
// 第二项是原文：只有原文的老旁注（带类型那一版之前落的）不给 notice。
const rowsOf = (timeline: [string, Notice | string][], reviews: FreeReviewRun[] = runs) => conversationFeedRows(
  buildConversationItems([{
    session,
    output: timeline.map(([at, notice]) => `\x1e${JSON.stringify(typeof notice === "string"
      ? { t: "system", text: notice, at }
      : { t: "system", text: "审查", notice, at })}`).join("\n"),
    trace: [],
  }] as never, [session] as never, []),
  { reviews },
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
// 升级前那场的开始没说是哪一场、收尾那一条也没写进来，升级后新一场又从第 1 轮开始：带类型的
// 开始没标 rerun 就是新开的一场，后面那句结论归新一场（第 3 轮审查）。
const mixedLanes = rowsOf([
  ["2026-11-11T10:01:00.000Z", start(1)],
  ["2026-11-12T10:01:00.000Z", start(1, { runId: "new-run" })],
  ["2026-11-12T10:30:00.000Z", verdict(1, "passed")],
]);
// 开轮那一条没说是哪一场、重跑那一条说了：同一张卡，认重跑说的那一场（不靠时间窗口，没给审查记录）。
const adoptedLanes = rowsOf([
  ["2026-11-11T10:01:00.000Z", start(1)],
  ["2026-11-11T10:05:00.000Z", start(1, { rerun: true, runId: "old-run" })],
  ["2026-11-11T10:30:00.000Z", verdict(1, "passed")],
], []);
// 只有原文的老旁注没有别的线索：同来源同轮号照旧算重跑。
const textLanes = rowsOf([
  ["2026-11-11T10:01:00.000Z", "自由工作流第 1 轮审查开始：审查 · 逻辑检查。"],
  ["2026-11-11T10:05:00.000Z", "自由工作流第 1 轮审查从中断处继续。"],
  ["2026-11-11T10:30:00.000Z", "自由工作流第 1 轮审查通过。"],
], []);
window.__lanes = Object.fromEntries([["free", freeLanes], ["superseded", supersededLanes], ["mixed", mixedLanes], ["adopted", adoptedLanes], ["text", textLanes]]
  .map(([name, lanes]) => [name, (lanes as ConversationReviewLane[]).map((item) => ({ title: item.title, runId: item.runId }))]));

// 每个任务的审查记录由测试放行：放行之前发出的 GET 都挂着；放行时按当时设下的那一份回。
type Served = { runs: FreeReviewRun[]; version: number; gate: Promise<void>; open: () => void; error: string | null };
const served = new Map<string, Served>();
const serve = (taskId: string, list: FreeReviewRun[], held: boolean) => {
  const entry: Served = { runs: list, version: 1, gate: Promise.resolve(), open: () => {}, error: null };
  if (held) entry.gate = new Promise((resolve) => { entry.open = resolve; });
  served.set(taskId, entry);
};
const byId = new Map([...runs, ghost, later].map((item) => [item.id, item]));
window.__reviews = {
  hold: (taskId) => { const entry = served.get(taskId)!; entry.gate = new Promise((resolve) => { entry.open = resolve; }); },
  release: (taskId) => served.get(taskId)!.open(),
  set: (taskId, ids) => { const entry = served.get(taskId)!; entry.runs = ids.map((id) => byId.get(id)!); entry.version += 1; },
  fail: (taskId, message) => { served.get(taskId)!.error = message; },
};
api.freeWorkflow = (async (taskId: string) => {
  const entry = served.get(taskId)!;
  await entry.gate;
  if (entry.error) throw new Error(entry.error);
  return {
    taskId, stateVersion: entry.version, selectedReviewerId: null, workspaceHead: "head", workspaceDirty: false,
    reviewReservation: { armed: false }, preview: { running: false }, executions: [], reviews: entry.runs,
  };
}) as unknown as typeof api.freeWorkflow;

const taskOf = (id: string) => ({ id, title: "导航", projectId: "p", mode: "single", status: "done", stage: "implemented", workflowMode: "free", parentId: null, archived: false } as unknown as Task);
const task = taskOf("nav-task");
serve(task.id, runs, true);
// 已经读到过一份（只有旧那场）：新一场刚结束就点它，手里那份是旧快照。
const staleTask = taskOf("nav-stale");
serve(staleTask.id, runs.slice(0, 1), false);
// 审查格里只有报告没有经过：去得了审查格、又说过话的那一轮另给一颗经过键，就地摊开。
const traceTask = taskOf("nav-trace");
serve(traceTask.id, runs, false);
// 第一次读就失败：数据一直是空的，这份请求不能一声不响地挂着。
const coldTask = taskOf("nav-cold");
serve(coldTask.id, runs.slice(0, 1), true);

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
function Host({ name, lanes, names, workflowMode, receipts = [], children }: {
  name: string;
  lanes: ConversationReviewLane[];
  names: string[];
  workflowMode: string;
  /** 被后一轮盖过的那几轮：会话里只剩「N 条记录」里的一条。 */
  receipts?: ConversationReviewLane[];
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
  // 「重试」走的就是这一条：原样再发一份请求。
  const openTab = (id: string, params?: InspectorRequest) => {
    seq.current += 1;
    setRequest({ id, params: params ?? {}, seq: seq.current });
  };
  return (
    <InspectorNavProvider value={{ request, consume, openTab }}>
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div>{lanes.map((item, index) => (
          <div key={item.id} data-lane={names[index]}>
            <ReviewerLane taskId={task.id} lane={item} onOpenRound={laneRoundOpener(item, workflowMode, open)}><p>这一轮的经过</p></ReviewerLane>
          </div>
        ))}
        {receipts.length > 0 && (
          <div data-receipts={name}>
            <ReceiptReviewContext.Provider value={{
              taskId: task.id,
              reviewOpener: (item) => laneRoundOpener(item, workflowMode, open),
              renderLane: () => <p>这一轮的经过</p>,
            }}>
              <TurnReceipts standalone receipts={receipts.map((item) => ({
                id: item.id,
                view: { tier: "receipt", tone: "plain", topic: "review", text: `${item.title}（${item.reviewerLabel}）`, icon: "review", detail: null, dispute: false },
                lane: item,
              } as never))} />
            </ReceiptReviewContext.Provider>
          </div>
        )}
        </div>
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
      <Host
        name="stale"
        lanes={[
          mixedLanes[1]!,
          lane("ghost", "free", "ghost-run", 1, "后来补上的一场"),
          lane("future", "free", "future-run", 2, "一直没有的一场"),
          lane("later", "free", "later-run", 1, "再后来的一场"),
        ]}
        names={["stale-new", "ghost", "future", "later"]}
        workflowMode="free"
      >
        <FreeReviewPane task={staleTask} notify={() => {}} />
      </Host>
      <Host
        name="trace"
        lanes={[{ ...lane("traced", "free", "old-run", 1, "说过话"), items: [{} as never] }, lane("silent", "free", "old-run", 1, "没开口")]}
        names={["traced", "silent"]}
        receipts={[{ ...lane("receipt-traced", "free", "old-run", 1, "被盖过"), items: [{} as never] }]}
        workflowMode="free"
      >
        <FreeReviewPane task={traceTask} notify={() => {}} />
      </Host>
      <Host name="cold" lanes={[lane("cold", "free", "old-run", 1, "冷启动")]} names={["cold"]} workflowMode="free">
        <FreeReviewPane task={coldTask} notify={() => {}} />
      </Host>
      <Host
        name="verify"
        lanes={[lane("verify", "inline", null, 1, "就地验证"), lane("verify-3", "inline", null, 3, "没有这一轮")]}
        names={["verify", "verify-3"]}
        workflowMode="preset"
      >
        <TaskReviewRounds taskId={task.id} state={rounds} emptyMessage="没有记录" />
      </Host>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Shell /></StrictMode>);
