// 尾注里此刻挂着动作的那几句不被挤掉（footnoteActions → composeFootnote 的 held）。
//
// 现场（2026-11-14，任务 R8M9Tsn2q0aj）：00:29:04.631 落下第 1 轮驳回，最后那一回合的尾注里是
// 「第 1 轮审查意见被驳回，等你裁定」；13 秒后同一回合落下结算说明「本回合没有交卷」，两句都是
// 「其余要你知道的」，驳回那一句被盖掉——可那条驳回明明还等着裁定。裁定后来挪到了回复框顶上那一行
// （用户 2026-11-15），这一句后面不再挂「去裁定」，但它说的仍是此刻的状态，要留到裁完为止。
// 夹具照那条任务的会话录（审查者会话收口后才落的驳回、执行者那一回合收尾的结算说明）。这份回归盯：
//   ① 驳回未裁：那一回合尾注里同时有驳回那一句（带颜色）和「本回合没有交卷」；
//   ② 驳回之后同一回合再落两三句别的：驳回那一句仍在，别的几句照旧每件事一句、最多三句；
//   ③ 三种裁定任一种、被新驳回取代：驳回那一句不再占位置，被后来的话盖过；
//   ④ 任务已验收 / 已合并 / 已归档 / 接力出去：不算「等你裁定」，不占位置；
//   ⑤ 拿不到审查状态的视图：按位置判，同样不被挤掉；
//   ⑥ 开着页面实时看到的，和刷新后从落盘重建的，尾注一样；
//   ⑦ 「继续本轮审查」两路（结论气泡下的原因句、退回的原因旁注）和「重试这一回合」两路（刷新后补的
//      那一句、直播的异常边界）都不被盖过或截掉——动作照 TaskDetail 那条链路推出来，认出来的那一句
//      落在哪一层（回合尾注、结论气泡下面、审查卡里重新并成的那一句）就在哪一层留着。
// 会话里渲染出来键挂在哪一句后面，见 test-footnote-actions-dom.mjs。
// 跑：npm -w web run test:footnote-actions
import assert from "node:assert/strict";
import type { FreeReviewDispute, FreeReviewRun, Session, TaskListItem } from "@navi/shared";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../src/task-detail/conversationModel.ts";
import { foldMonitorWakes } from "../src/task-detail/monitorWakeTurns.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";
import { conversationDebateRows } from "../src/task-detail/conversationDebateRows.ts";
import { conversationSystemRows, laneReceipts } from "../src/task-detail/conversationSystemRows.ts";
import { footnoteActionCases } from "./fixtures/footnote-actions-cases.ts";
import { laneNoVerdicts } from "../src/task-detail/reviewNoVerdictCause.ts";
import { crashedTurns } from "../src/task-detail/turnFailure.ts";
import { footnoteActions } from "../src/task-detail/footnoteActions.ts";
import { composeFootnote, type FootnotePart, type TurnFootnote } from "../src/task-detail/turnFootnote.ts";
import type { ReviewRetryAction, TurnRetryAction } from "../src/task-detail/turnRetry.ts";

type Task = Pick<TaskListItem, "stage" | "archived" | "handoff">;
const OPEN_TASK: Task = { stage: null, archived: false, handoff: null } as Task;

const line = (turn: Record<string, unknown>) => `\n\x1e${JSON.stringify(turn)}\n`;
const DISPUTE_AT = "2026-11-14T00:29:04.631Z";
const END_AT = "2026-11-14T00:29:17.502Z";
const WAKE_AT = "2026-11-14T00:28:44.978Z";
const DISPUTE = "执行者认可这一轮意见，但说该另开一个任务去改，不在这个任务里改（第 1 轮 · 顶级审查）。\n"
  + "它的说法：只剩一条要改 navi 服务端的调度，建议单开一个服务端任务。\n"
  + "现在由你裁定：让它接着改 / 这一轮不用改了 / 把那几条转成独立任务；拿不准就先让双方辩一轮。（自动复审已取消，等你拍板。）";
const UNSUBMITTED = "本回合没有交卷:agent 结束前没有调用 complete_task 确认目标已达成,按 navi 的完成协议记为未完成。"
  + "这不是崩溃 —— 进程正常退出(exit 0)只证明 CLI 没挂,报错后退出也是 exit 0,所以「干完了」只认 agent 亲口确认。";
const disputeAside = { t: "system", agent: "codex", text: DISPUTE, aside: true, notice: { kind: "review.dispute", round: 1 }, at: DISPUTE_AT };
const settlement = { t: "system", agent: "claude", text: UNSUBMITTED, level: "notice", at: END_AT };

const mainSession = (patch: Partial<Session> = {}) => ({
  id: "4J5iV78DfjKD", taskId: "R8M9Tsn2q0aj", agentType: "claude", executor: "claude@ccb", role: "single",
  startedAt: "2026-11-13T15:20:23.985Z", endedAt: END_AT, ...patch,
}) as unknown as Session;
const reviewerSession = {
  id: "n-Tyx3XwZWxE", taskId: "R8M9Tsn2q0aj", agentType: "codex", executor: "codex@cpa", role: "reviewer",
  startedAt: "2026-11-13T23:49:23.287Z", endedAt: "2026-11-14T00:07:01.640Z",
} as unknown as Session;

const MAIN_HEAD = [
  line({ t: "user", agent: "claude", text: "做 mac 版 Sparkle 自更新。", at: "2026-11-13T15:20:23.985Z" }),
  "Sparkle 接好了，发版脚本也写了。",
  line({ t: "agentEnd", at: "2026-11-13T23:48:00.000Z" }),
  line({ t: "user", agent: "claude", text: "继续：test-macos-update 绿了就调 dispute_review。", by: "system", at: WAKE_AT }),
  "审查报告里 mac app 这一侧的问题都改好了。只剩一项留给你定：我建议把它转成一个单独的服务端任务，已经用 `dispute_review` 提交。",
].join("");
const MAIN_TAIL = [line({ t: "agentEnd", at: END_AT }), line(settlement)].join("");
// 驳回由 appendTaskTimeline 记在最近起跑的那条会话上——这里是审查者那条。
const REVIEWER_OUTPUT = [
  line({ t: "system", agent: "codex", text: "〔系统〕继续（从中断处）", resume: { reason: "run", side: true }, at: "2026-11-13T23:49:23.287Z" }),
  "审查结论：**不能验收，已上报 `verify_failed`**，共 5 条必须修复。",
  line({ t: "system", agent: "codex", text: "自由工作流第 1 轮审查未通过，意见已放入待发送队列；修复正常结束后按最新预约复审。", aside: true,
    notice: { kind: "review.verdict", source: "free", round: 1, verdict: "failed", reviewer: "顶级审查", findings: 5 }, at: "2026-11-14T00:07:01.690Z" }),
  line({ t: "agentEnd", at: "2026-11-14T00:07:01.640Z" }),
  line(disputeAside),
].join("");

/** 刷新后从落盘重建；`extra` 是同一回合里驳回之后又落下的几句（落在执行者会话的收尾处）。 */
function persisted(extra: string[] = []): ConversationItem[] {
  const output = MAIN_HEAD + MAIN_TAIL + extra.join("");
  return buildConversationItems(
    [{ session: mainSession(), output, trace: [] }, { session: reviewerSession, output: REVIEWER_OUTPUT, trace: [] }],
    [mainSession(), reviewerSession], [],
  );
}

/** 开着页面看：执行者那一回合说完话时读过一次盘，驳回、回合结束、结算说明都是实时到的。 */
function live(): ConversationItem[] {
  const atRead = mainSession({ endedAt: null } as Partial<Session>);
  const reviewerAtRead = { ...reviewerSession };
  const server = (sessionId: string, role: string, agentType: string, event: Record<string, unknown>, turnStartedAt?: string) => ({
    kind: "server", id: "",
    event: { type: "agent.event", taskId: "R8M9Tsn2q0aj", sessionId, role, agentType, ...(turnStartedAt ? { turnStartedAt } : {}), event },
  });
  const timeline = [
    server(reviewerSession.id, "reviewer", "codex", { kind: "system", text: DISPUTE, at: DISPUTE_AT, aside: true, notice: { kind: "review.dispute", round: 1 } }),
    server(mainSession().id, "single", "claude", { kind: "done", exitStatus: 0 }, WAKE_AT),
    server(mainSession().id, "single", "claude", { kind: "system", text: UNSUBMITTED, at: END_AT, level: "notice" }, WAKE_AT),
  ].map((entry, index) => ({ ...entry, id: `live-${index}` })) as unknown as TimelineEntry[];
  return buildConversationItems(
    [{ session: atRead, output: MAIN_HEAD, trace: [] }, { session: reviewerAtRead, output: REVIEWER_OUTPUT.slice(0, REVIEWER_OUTPUT.lastIndexOf("\n\x1e")), trace: [] }],
    [mainSession(), reviewerSession], timeline,
  );
}

const dispute = (patch: Partial<FreeReviewDispute> = {}): FreeReviewDispute => ({
  summary: "只剩一条要改 navi 服务端的调度。", reason: "", deferReason: "F2 的服务端那一半。", at: "2026-11-14T00:29:04.628Z",
  resolution: null, resolvedAt: null, deferredTaskId: null, debates: [], ...patch,
}) as FreeReviewDispute;
const review = (value: FreeReviewDispute | null): FreeReviewRun[] => [{
  id: "QnWmBbcLNs-C", reviewerId: null, reviewerName: "顶级审查", agentType: "codex", executorId: null, executorLabel: null,
  model: null, reasoningEffort: null, checkMode: "logic", note: null, retryLimit: 1, currentRound: 1, status: "stopped",
  rounds: [{
    round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "c1", reportMarkdown: "# 报告", screenshots: [],
    dispute: value, startedAt: "2026-11-13T23:49:23.287Z", endedAt: "2026-11-14T00:07:01.640Z",
  }],
  createdAt: "2026-11-13T23:49:23.287Z", updatedAt: "2026-11-14T00:29:04.628Z", finishedAt: "2026-11-14T00:07:01.640Z",
}] as unknown as FreeReviewRun[];

/** 跟 ConversationFeed 同一条链路：foldMonitorWakes → 审查段 → 辩论 → 归属与尾注。 */
function display(raw: ConversationItem[], options: {
  reviews: FreeReviewRun[] | null; task?: Task;
  reviewRetry?: ReviewRetryAction | null; turnRetry?: TurnRetryAction | null;
}) {
  const items = foldMonitorWakes(raw);
  const crashed = crashedTurns(items, options.turnRetry?.sessionId);
  const feedRows = conversationFeedRows(items, { reviews: options.reviews });
  const causes = laneNoVerdicts(feedRows, options.reviews);
  const actions = footnoteActions({
    items, task: options.task ?? OPEN_TASK, reviews: options.reviews,
    causes, crashed, reviewRetry: options.reviewRetry, turnRetry: options.turnRetry,
  });
  const shown = conversationSystemRows(conversationDebateRows(feedRows, { reviews: options.reviews }), { failures: crashed, causes, held: actions.held });
  const lastAgent = items.findLast((item) => item.kind === "agent" && !item.reviewer);
  assert(lastAgent, "夹具里得有执行者那一回合");
  return { items, actions, shown, footnote: shown.footnotes.get(lastAgent.id) };
}
const texts = (footnote: TurnFootnote | undefined) => (footnote?.parts ?? []).map((part) => part.view.text);
const RULING = "第 1 轮审查意见被驳回，等你裁定";
const UNSUBMITTED_TEXT = "本回合没有交卷";
// 「等你裁定」那一句：带颜色、留到裁完为止。裁定本身在回复框顶上那一行，这一句后面不再挂「去裁定」。
const standingPart = (result: ReturnType<typeof display>) => result.footnote?.parts.find((part) => part.id === result.actions.standingDisputeId);

// ① 驳回未裁：两句都在，驳回那一句是「现在的事」。
{
  const result = display(persisted(), { reviews: review(dispute()) });
  assert.deepEqual(texts(result.footnote), [RULING, UNSUBMITTED_TEXT], "驳回那一句不被 13 秒后的结算说明盖掉");
  assert.equal(standingPart(result)?.view.text, RULING, "带颜色的就是驳回那一句");
  // 改之前的样子：同一份记录不给 held，驳回那一句被盖掉——夹具确实复现了现场。
  const before = conversationSystemRows(conversationDebateRows(conversationFeedRows(result.items, { reviews: review(dispute()) }), { reviews: review(dispute()) }));
  assert.deepEqual(texts(before.footnotes.get(result.footnote!.id.replace(/^footnote:/, ""))), [UNSUBMITTED_TEXT], "夹具复现现场：不留位置时驳回那一句被盖掉");
}

// ② 驳回之后又落了几句别的：驳回那一句仍在，别的几句照旧每件事一句、最多三句。
const LATER = [
  { t: "system", agent: "claude", text: "预约的审查先不开始：驳回还在等你裁定", aside: true, notice: { kind: "alert" }, at: "2026-11-14T00:30:00.000Z" },
  { t: "system", agent: "claude", text: "验收暂缓：工作区有未提交的改动", aside: true, notice: { kind: "alert" }, at: "2026-11-14T00:31:00.000Z" },
  { t: "system", agent: "claude", text: "自由工作流第 1 轮审查未通过（第 1 轮 · 顶级审查）", aside: true, notice: { kind: "review.verdict", source: "free", round: 1, verdict: "failed", findings: 5 }, at: "2026-11-14T00:32:00.000Z" },
].map(line);
{
  const result = display(persisted(LATER), { reviews: review(dispute()) });
  const shown = texts(result.footnote);
  assert(shown.includes(RULING), `驳回那一句仍在（实际：${JSON.stringify(shown)}）`);
  assert.equal(standingPart(result)?.view.text, RULING, "它仍是「现在的事」");
  assert(!shown.includes(UNSUBMITTED_TEXT) && shown.some((text) => text.startsWith("验收暂缓")), "别的「要你知道的」照旧只留最近一句");
  assert(shown.length - 1 <= 3, "驳回那一句不占三句的名额，其余照旧最多三句");
}

// ③ 裁定了（三种任一）或被新的驳回取代：回到普通规则。
for (const patch of [
  { resolution: "upheld", resolvedAt: "2026-11-14T01:00:00.000Z" },
  { resolution: "withdrawn", resolvedAt: "2026-11-14T01:00:00.000Z" },
  { resolution: "deferred", resolvedAt: "2026-11-14T01:00:00.000Z", deferredTaskId: "derived-1" },
  { supersededAt: "2026-11-14T01:00:00.000Z" },
] as Partial<FreeReviewDispute>[]) {
  const name = JSON.stringify(patch);
  const result = display(persisted(), { reviews: review(dispute(patch)) });
  assert.equal(result.actions.standingDisputeId, null, `${name}：那一句不再是现在的事（不带颜色）`);
  assert.deepEqual(texts(result.footnote), [UNSUBMITTED_TEXT], `${name}：可以被后来的话盖过，退回记录`);
}

// ④ 此刻裁不了：库里二十多条已验收任务带着从没裁过的驳回，不能全都重新亮起来。
for (const task of [
  { stage: "accepted", archived: false, handoff: null },
  { stage: "merged", archived: false, handoff: null },
  { stage: null, archived: true, handoff: null },
  { stage: null, archived: false, handoff: { direction: "out" } },
] as unknown as Task[]) {
  const name = JSON.stringify(task);
  const result = display(persisted(), { reviews: review(dispute()), task });
  assert.equal(result.actions.standingDisputeId, null, `${name}：那一句按过去的事显示`);
  assert.deepEqual(texts(result.footnote), [UNSUBMITTED_TEXT], `${name}：照普通规则可以被盖过`);
}

// ⑤ 拿不到审查状态：照位置判，同样不被挤掉。
{
  const blind = display(persisted(), { reviews: null });
  assert.deepEqual(texts(blind.footnote), [RULING, UNSUBMITTED_TEXT], "拿不到审查状态：按位置判，驳回那一句不被挤掉");
  assert.equal(display(persisted(), { reviews: null, task: { stage: "accepted", archived: false, handoff: null } as Task }).actions.standingDisputeId, null,
    "拿不到审查状态、但任务已验收：照样是过去的事");
}

// ⑥ 实时到达和刷新后重建，两路一样。
for (const reviews of [review(dispute()), review(dispute({ resolution: "upheld", resolvedAt: "2026-11-14T01:00:00.000Z" })), null]) {
  const reload = display(persisted(), { reviews });
  const watching = display(live(), { reviews });
  assert.deepEqual(texts(watching.footnote), texts(reload.footnote), "开着页面看到的尾注跟刷新后的一样");
  assert.equal(!!watching.actions.standingDisputeId, !!reload.actions.standingDisputeId, "两路的「等你裁定」一样");
  assert.equal(!!standingPart(watching), !!standingPart(reload), "两路的那一句都在尾注里");
}

// ⑦ 其余挂着动作的那几句。
const part = (id: string, topic: FootnotePart["view"]["topic"], text: string, kind: FootnotePart["kind"] = "event"): FootnotePart =>
  ({ kind, id, view: { tier: "alert", tone: "warn", topic, icon: "alert", text, detail: null, dispute: false } }) as FootnotePart;
{
  // 结论气泡下面的原因句（topic=review）排在最前：后面又来三件不同的事，不许被三句截掉，也不被
  // 后来的一句「review」盖过。
  const cause = part("no-verdict:run-1:1", "review", "第 1 轮审查中断：模型上游连不上（503）", "cause");
  const later = [part("a", "other", "验收暂缓"), part("b", "accept", "已验收"), part("c", "failure", "这一轮异常结束"), part("d", "review", "第 1 轮审查没能开始")];
  assert.deepEqual(composeFootnote([cause, ...later]).map((entry) => entry.id), ["b", "c", "d"], "改之前：原因句被挤掉，「继续本轮审查」没处挂");
  assert.deepEqual(composeFootnote([cause, ...later], new Set([cause.id])).map((entry) => entry.id), [cause.id, "b", "c", "d"], "原因句各占一个位置");

  // 退回的原因旁注（review.no_verdict，topic=other）：后来任何一句「其余要你知道的」都会盖掉它。
  const fallback = part("evt-no-verdict", "other", "第 1 轮审查中断：模型上游连不上（503）");
  assert.deepEqual(composeFootnote([fallback, part("x", "other", "验收暂缓")], new Set([fallback.id])).map((entry) => entry.id), [fallback.id, "x"],
    "退回的原因旁注不被后来的「其余」盖掉");

  // 「重试这一回合」：说它没办成的那一句排在最前，后面又来三件不同的事。
  const failure = part("failure:agent-1", "failure", "这一轮中断 · 模型上游连不上（503）", "failure");
  const after = [part("p", "other", "验收暂缓"), part("q", "accept", "已验收"), part("r", "review", "第 2 轮审查通过")];
  assert.deepEqual(composeFootnote([failure, ...after], new Set([failure.id])).map((entry) => entry.id), [failure.id, "q", "r"],
    "失败那一句各占一个位置；验收之前的「其余」照旧退回记录");
}

// ⑦ 续：这几个 id 是从会话里认出来的那一句，跟尾注里那一部分对得上。
{
  const at = (minute: number) => new Date(Date.parse("2026-11-14T02:00:00.000Z") + minute * 60_000).toISOString();
  const session = { id: "s-crash", taskId: "t", agentType: "claude", executor: "claude@ccb", role: "single", startedAt: at(0), endedAt: at(5) } as unknown as Session;
  const output = [
    line({ t: "user", agent: "claude", text: "跑一下", at: at(0) }),
    "跑到一半。",
    line({ t: "agentEnd", at: at(5), exitCode: 1 }),
    ...["验收暂缓：工作区有未提交的改动", "预约的审查先不开始：这一轮还在跑", "合并冲突"].map((text, index) =>
      line({ t: "system", agent: "claude", text, aside: true, notice: { kind: "alert" }, at: at(6 + index) })),
    line({ t: "system", agent: "claude", text: "已验收，合并到 main", aside: true, notice: { kind: "accept.done", target: "main" }, at: at(10) }),
    line({ t: "system", agent: "claude", text: "第 2 轮审查没能开始", aside: true, notice: { kind: "review.verdict", source: "free", round: 2, verdict: "aborted" }, at: at(11) }),
  ].join("");
  const items = buildConversationItems([{ session, output, trace: [] }], [session], []);
  const retry: TurnRetryAction = { sessionId: session.id, run: async () => undefined };
  const result = display(items, { reviews: null, turnRetry: retry });
  const agent = items.findLast((item) => item.kind === "agent")!;
  assert.equal(result.actions.retryTurnFootnoteId, `footnote:${agent.id}`);
  assert.equal(result.actions.retryFailureId, `failure:${agent.id}`, "刷新后补出来的那一句");
  const failure = result.footnote?.parts.find((entry) => entry.id === result.actions.retryFailureId);
  assert(failure, `失败那一句在尾注里（实际：${JSON.stringify(texts(result.footnote))}）`);
  assert.equal(failure.view.topic, "failure");
}

// ⑦ 续：四种真实形状（footnote-actions-cases），动作照 TaskDetail 那条链路推出来，认出来的那一句在它所在
// 那一层的尾注里留着；不给 held 时它确实会被后来的话挤掉（这几种夹具复现了要修的那件事）。
{
  const EXPECT: Record<string, keyof ReturnType<typeof footnoteActions>> = {
    "lane-event": "retryEventId", "lane-cause": "retryCauseId", "turn-live": "retryFailureId", "turn-reload": "retryFailureId",
  };
  for (const entry of footnoteActionCases([])) {
    const items = foldMonitorWakes(entry.items);
    const crashed = crashedTurns(items, entry.turnRetry?.sessionId);
    const feedRows = conversationFeedRows(items, { reviews: entry.reviews });
    const causes = laneNoVerdicts(feedRows, entry.reviews);
    const actions = footnoteActions({
      items, task: entry.task, reviews: entry.reviews, causes, crashed,
      reviewRetry: entry.reviewRetry, turnRetry: entry.turnRetry,
    });
    const id = actions[EXPECT[entry.id]!] as string | null;
    assert(id, `${entry.id}：认出了挂动作的那一句（${EXPECT[entry.id]}）`);
    assert(actions.held.has(id), `${entry.id}：那一句在 held 里`);
    // 跟 ConversationFeed 一样：外层归属 + 每张审查卡里重新并成的那几句。
    const shownParts = (held: ReadonlySet<string>) => {
      const shown = conversationSystemRows(conversationDebateRows(feedRows, { reviews: entry.reviews }), { failures: crashed, causes, held });
      const lanes = shown.rows.flatMap((row) => row.kind === "review-lane" ? [row] : row.kind === "verdict" ? [row.lane] : [])
        .map((lane) => laneReceipts(lane, held));
      return [
        ...[...shown.footnotes.values()],
        ...shown.rows.flatMap((row) => row.kind === "footnote" || row.kind === "verdict" ? [row.footnote] : []),
        ...lanes.flatMap((lane) => [...lane.footnotes.values(), ...lane.rows.flatMap((row) => row.kind === "footnote" ? [row.footnote] : [])]),
      ].flatMap((footnote) => footnote.parts);
    };
    const kept = shownParts(actions.held).find((candidate) => candidate.id === id);
    assert(kept, `${entry.id}：后面又落了几句别的话，挂动作的那一句还在`);
    assert.match(kept.view.text, entry.sentence, `${entry.id}：留下的就是说这件事的那一句`);
    assert(!shownParts(new Set()).some((candidate) => candidate.id === id), `${entry.id}：不留位置时它会被挤掉（夹具复现了要修的那件事）`);
  }
}

console.log("footnote actions tests passed");
