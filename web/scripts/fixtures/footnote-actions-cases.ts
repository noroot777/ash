// 尾注上挂着动作的那几句（footnoteActions），四种真实形状的会话。DOM 夹具（footnote-actions.tsx）照它们
// 渲染 ConversationFeed；动作照 TaskDetail 那条链路接（服务端下发的 retryTurn → retryTurnActions），
// 不是手塞一个 prop。每一种都在挂动作的那一句后面又落了几句别的话：
//   lane-event   审查卡还没收口（结论那一条没到）：这一轮为什么断了的那条旁注 + 「继续本轮审查」，
//                后面来一句「本回合没有交卷」——卡里的尾注同样不许挤掉它（第 1 轮审查第 1 条）；
//   lane-cause   这一轮收了口、没出结论：结论气泡下面的原因句 + 「继续本轮审查」，后面又来三件不同的事；
//   turn-live    开着页面看到的崩溃：直播的异常边界 + 「重试这一回合」，后面又来三件不同的事；
//   turn-reload  刷新以后从会话行补出来的那一句 + 「重试这一回合」，后面同样三件事。
import type { FreeReviewRound, FreeReviewRun, RetryTurnAction, Session, TaskListItem } from "@ash/shared";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../../src/task-detail/conversationModel.ts";
import { retryTurnActions, type ReviewRetryAction, type TurnRetryAction } from "../../src/task-detail/turnRetry.ts";

export type FootnoteActionCase = {
  id: string;
  task: TaskListItem;
  items: ConversationItem[];
  sessions: Session[];
  reviews: FreeReviewRun[];
  reviewRetry: ReviewRetryAction | null;
  turnRetry: TurnRetryAction | null;
  /** 挂着动作的那一句，和那个动作的字。 */
  sentence: RegExp;
  action: "继续本轮审查" | "重试这一回合";
};

const T0 = Date.parse("2026-11-14T03:00:00.000Z");
const at = (second: number) => new Date(T0 + second * 1000).toISOString();
const line = (turn: Record<string, unknown>) => `\x1e${JSON.stringify(turn)}`;
const aside = (second: number, text: string, notice: unknown) => line({ t: "system", text, aside: true, notice, at: at(second) });
const CAUSE = { kind: "interrupted", reason: "模型上游连不上（503）" } as const;
const NO_VERDICT = "这一轮审查是中途断掉的：模型上游连不上（状态码 503），执行器以 exit 1 结束。等上游恢复后点「继续本轮审查」。";
const UNSUBMITTED = "本回合没有交卷:agent 结束前没有调用 complete_task 确认目标已达成,按 ash 的完成协议记为未完成。";
/** 挂动作的那一句之后又落的三件不同的事（其余要你知道的、验收、一轮审查没能开始）。 */
const LATER = (from: number) => [
  aside(from, "验收暂缓：工作区有未提交的改动", { kind: "alert" }),
  aside(from + 1, "已验收，合并到 feat/ui-revamp", { kind: "accept.done", target: "feat/ui-revamp" }),
  aside(from + 2, UNSUBMITTED, { kind: "alert" }),
  aside(from + 3, "自由工作流第 2 轮审查启动失败", { kind: "review.verdict", source: "free", round: 2, verdict: "aborted" }),
];

const task = (id: string) => ({
  id, title: id, body: "", mode: "single", status: "failed", agentType: "claude", workflowMode: "free", archived: false,
  stage: null, parentId: null, queueId: null, handoff: null, question: null, resumePrompt: null, verifyRound: null,
}) as unknown as TaskListItem;
const session = (id: string, patch: Partial<Session> = {}) => ({
  id, taskId: "t", agentType: "claude", role: "single", executor: "claude@ccb", startedAt: at(0), endedAt: at(60), ...patch,
}) as unknown as Session;
const round = (patch: Partial<FreeReviewRound> = {}): FreeReviewRound => ({
  round: 1, status: "error", conclusion: null, reviewedCommit: "c1", reportMarkdown: "", screenshots: [], dispute: null,
  startedAt: at(10), endedAt: at(20), noVerdict: CAUSE, retry: { generation: "g1", sessionId: "rev" }, ...patch,
} as FreeReviewRound);
const run = (only: FreeReviewRound): FreeReviewRun => ({
  id: "run-1", reviewerId: null, reviewerName: "codex 审查", agentType: "codex", executorId: null, executorLabel: null,
  model: null, reasoningEffort: null, checkMode: "logic", note: null, retryLimit: 1, currentRound: 1, status: "failed",
  rounds: [only], createdAt: at(10), updatedAt: at(20), finishedAt: at(20),
} as FreeReviewRun);

function reviewCase(id: string, output: string, reviews: FreeReviewRun[], log: string[], sentence: RegExp): FootnoteActionCase {
  const sessions = [session("rev", { agentType: "codex", role: "main" } as Partial<Session>)];
  const items = buildConversationItems([{ session: sessions[0]!, output, trace: [] }], sessions, []);
  // 服务端判的「这一轮能续」（task-retry-turn.ts），跟审查状态里那一轮的 retry 是同一份身份。
  const retry: RetryTurnAction = { ok: true, kind: "review", review: { runId: "run-1", round: 1, generation: "g1", sessionId: "rev" } };
  return {
    id, task: task(id), items, sessions, reviews,
    reviewRetry: retryTurnActions(retry, async () => { log.push(id); }).review,
    turnRetry: null, sentence, action: "继续本轮审查",
  };
}

export function footnoteActionCases(log: string[]): FootnoteActionCase[] {
  const start = aside(10, "自由工作流第 1 轮审查开始", { kind: "review.start", source: "free", round: 1, runId: "run-1" });
  const noVerdict = aside(20, NO_VERDICT, { kind: "review.no_verdict", source: "free", runId: "run-1", round: 1, cause: CAUSE });
  const verdict = aside(20, "自由工作流第 1 轮审查未能正常给出结论", { kind: "review.verdict", source: "free", round: 1, verdict: "inconclusive" });
  const laneEvent = reviewCase("lane-event", [
    start, noVerdict, aside(34, UNSUBMITTED, { kind: "alert" }),
  ].join("\n"), [run(round())], log, /^第 1 轮审查中断：模型上游连不上（503）$/);
  const laneCause = reviewCase("lane-cause", [
    start, noVerdict, verdict, ...LATER(30),
  ].join("\n"), [run(round())], log, /^中断 · 模型上游连不上（503）$/);

  // 普通回合崩了：落盘那一路是会话行报的异常收口，直播那一路是回合边界。
  const head = [line({ t: "user", agent: "claude", text: "跑一下", at: at(0) }), "跑到一半。"].join("\n");
  const crashed = session("s-crash", { exitStatus: 1, turnOutcome: "failed" } as Partial<Session>);
  const reload: FootnoteActionCase = {
    id: "turn-reload", task: task("turn-reload"), sessions: [crashed], reviews: [], reviewRetry: null,
    items: buildConversationItems([{ session: crashed, output: [head, line({ t: "agentEnd", at: at(5) }), ...LATER(6)].join("\n"), trace: [] }], [crashed], []),
    turnRetry: retryTurnActions({ ok: true, kind: "turn", sessionId: crashed.id }, async () => { log.push("turn-reload"); }).turn,
    sentence: /^这一轮异常结束$/, action: "重试这一回合",
  };
  const running = session("s-live", { endedAt: null } as Partial<Session>);
  const server = (event: Record<string, unknown>, turnStartedAt?: string) => ({
    kind: "server", id: "",
    event: { type: "agent.event", taskId: "t", sessionId: running.id, role: "single", agentType: "claude", ...(turnStartedAt ? { turnStartedAt } : {}), event },
  });
  const timeline = [
    server({ kind: "done", exitStatus: 1 }, at(0)),
    server({ kind: "system", text: "验收暂缓：工作区有未提交的改动", at: at(6), aside: true, notice: { kind: "alert" } }),
    server({ kind: "system", text: "已验收，合并到 feat/ui-revamp", at: at(7), aside: true, notice: { kind: "accept.done", target: "feat/ui-revamp" } }),
    server({ kind: "system", text: UNSUBMITTED, at: at(8), aside: true, notice: { kind: "alert" } }),
    server({ kind: "system", text: "自由工作流第 2 轮审查启动失败", at: at(9), aside: true, notice: { kind: "review.verdict", source: "free", round: 2, verdict: "aborted" } }),
  ].map((entry, index) => ({ ...entry, id: `live-${index}` })) as unknown as TimelineEntry[];
  const live: FootnoteActionCase = {
    id: "turn-live", task: task("turn-live"), sessions: [running], reviews: [], reviewRetry: null,
    items: buildConversationItems([{ session: running, output: head, trace: [] }], [running], timeline),
    turnRetry: retryTurnActions({ ok: true, kind: "turn", sessionId: running.id }, async () => { log.push("turn-live"); }).turn,
    sentence: /^这一轮异常结束$/, action: "重试这一回合",
  };
  return [laneEvent, laneCause, live, reload];
}
