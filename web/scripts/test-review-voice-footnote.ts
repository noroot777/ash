// 审查自己的话只贴在审查气泡下面，不落进执行者那一回合的尾注。
//
// 现场（2026-11-19，任务 y8S-yZjD0eaK，用户截图）：执行者那一回合正文下面挂着「中断 · 模型上游连不上（503）
// · 续聊回合异常结束(退出码 1),任务状态保持「已完成」不变」，点开是「执行器的原话：…503…」，看着就是执行者
// 那一回合出了事。其实是审查者断了：第 4 轮两次撞上 503，新派的第 1 轮第一次也撞上，随后重跑、正在审。
// 根因在归属（conversationSystemRows 的 attach）：同一回合上又出一轮结论时，被盖过的那一行撤掉、贴在它
// 下面的那几句**整组**回到执行者回合的尾注，里面恰好有审查自己的话——为什么没结论（那一句原因、服务端说同
// 一件事的旁注）和审查者会话给它自己那一回合写的结算说明。夹具照那条任务的会话录压缩。这份回归盯：
//   ① 刷新后从落盘重建：执行者回合的尾注里没有审查的话，它们都还在那一回合的「N 条记录」里；
//   ② 重跑还没开始时（最后那一轮的结论气泡还在）：气泡下面只有原因那一句，审查者的结算说明并进原因，
//      被盖过的第 4 轮那几句不回执行者回合；
//   ③ 被盖过的那一轮此刻还挂着动作（「继续本轮审查」）：那一句跟到这一回合的下一行结论下面，不落执行者回合；
//   ④ 开着页面看：审查者会话的结算说明是直播到的，同样认得出是审查者的话（条目带着会话角色）；
//   ⑤ 任务的事（验收暂缓之类）照旧：被盖过的那一行下面的它们回到执行者回合的尾注；
//   ⑥ 认不出审查段的老记录：原因旁注照旧落在执行者回合上（「继续本轮审查」退回挂在它上面），结算说明只进记录。
// 跑：npm -w web run test:review-voice-footnote
import assert from "node:assert/strict";
import type { FreeReviewRun, Session } from "@ash/shared";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../src/task-detail/conversationModel.ts";
import { foldMonitorWakes } from "../src/task-detail/monitorWakeTurns.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";
import { conversationDebateRows } from "../src/task-detail/conversationDebateRows.ts";
import { conversationSystemRows } from "../src/task-detail/conversationSystemRows.ts";
import { laneNoVerdicts, noVerdictPartId } from "../src/task-detail/reviewNoVerdictCause.ts";
import { crashedTurns } from "../src/task-detail/turnFailure.ts";

const line = (turn: Record<string, unknown>) => `\n\x1e${JSON.stringify(turn)}\n`;
const SAID = "unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex, model=gpt-6.1-sol)";
const CRASH = "续聊回合异常结束(退出码 1),任务状态保持「已完成」不变。";

/**
 * 一条会话的会话录，照服务端的落法带记录号和回合起点（conversationAssembler 按它们归位）。结算说明的号
 * 排在收口那一行**之前**、落盘却在它之后——那一刻的真实样子：号在写结论旁注时就领了。
 */
function transcript() {
  let seq = 0;
  let turn: string | null = null;
  const out: string[] = [];
  const put = (record: Record<string, unknown>, at: string, own = ++seq) => out.push(line({ ...record, at, seq: own, turnStartedAt: turn }));
  const self = {
    resume(at: string) { turn = at; put({ t: "system", agent: "codex", text: "〔系统〕继续（从中断处）", resume: { reason: "run", side: true } }, at); return self; },
    start(round: number, runId: string, at: string, rerun?: string) {
      turn = null;
      put({
        t: "system", agent: "codex", aside: true, text: `自由工作流第 ${round} 轮审查${rerun ?? "开始：顶级审查 · 逻辑检查"}。`,
        notice: { kind: "review.start", source: "free", round, reviewer: "顶级审查", runId, ...(rerun ? { rerun: true } : {}) },
      }, at);
      return self;
    },
    aside(text: string, notice: Record<string, unknown>, at: string) { put({ t: "system", agent: "codex", aside: true, text, notice }, at); return self; },
    noVerdict(round: number, at: string) {
      return self.aside(`自由工作流第 ${round} 轮审查未能正常给出结论，已停止自动链。`,
        { kind: "review.verdict", source: "free", round, verdict: "inconclusive", reviewer: "顶级审查" }, at);
    },
    crashed(at: string) {
      const note = ++seq;
      put({ t: "agentEnd" }, at);
      put({ t: "system", agent: "codex", text: CRASH, level: "notice" }, at, note);
      return self;
    },
    text(body: string, at: string) { put({ t: "agent" }, at); out.push(`${body}\n`); return self; },
    toString: () => out.join(""),
  };
  return self;
}

const exec = {
  id: "ydH-BCNJWHh-", taskId: "y8S-yZjD0eaK", agentType: "claude", executor: "claude@ccb", role: "single",
  startedAt: "2026-11-19T01:19:23.365Z", endedAt: "2026-11-19T01:23:13.189Z",
} as unknown as Session;
const reviewerA = {
  id: "TN--xQPkBTym", taskId: "y8S-yZjD0eaK", agentType: "codex", executor: "codex@nodemach", role: "reviewer",
  startedAt: "2026-11-19T01:23:13.700Z", endedAt: "2026-11-19T01:26:41.160Z", exitStatus: 1,
} as unknown as Session;
const reviewerB = (patch: Partial<Session> = {}) => ({
  id: "OeHoXtF1IzUZ", taskId: "y8S-yZjD0eaK", agentType: "codex", executor: "codex@nodemach", role: "reviewer",
  startedAt: "2026-11-19T01:27:19.114Z", endedAt: null, ...patch,
}) as unknown as Session;

const EXEC_OUTPUT = [
  line({ t: "user", agent: "claude", text: "把剩下的地方也改成新名字。", at: "2026-11-19T01:19:23.365Z", seq: 1, turnStartedAt: "2026-11-19T01:19:23.365Z" }),
  line({ t: "agent", at: "2026-11-19T01:22:50.000Z", seq: 2, turnStartedAt: "2026-11-19T01:19:23.365Z" }),
  "I didn't rerun the full test suite or `npm run build`, since product code didn't change. I didn't restart :4317.\n",
  line({ t: "agentEnd", at: "2026-11-19T01:23:13.189Z", seq: 3, turnStartedAt: "2026-11-19T01:19:23.365Z" }),
].join("");
const HOLD = "验收暂缓：工作区有未提交的改动。";
// 第 4 轮（第一场）：断两次。服务端第一次断时还写了一条带类型的原因旁注。新的一场的「开始」记在这条会话上。
// `hold`：两次之间落一句任务的事（⑤）。
const reviewerAOutput = (hold = false) => {
  const t = transcript()
    .start(4, "RUN1", "2026-11-19T01:23:13.722Z")
    .resume("2026-11-19T01:23:14.176Z")
    .noVerdict(4, "2026-11-19T01:24:51.409Z")
    .aside(`这一轮审查是中途断掉的：模型上游连不上（状态码 503），执行器以 exit 1 结束，执行器的原话：「${SAID}」`,
      { kind: "review.no_verdict", source: "free", runId: "RUN1", round: 4, cause: { kind: "interrupted", reason: "模型上游连不上（503）", said: SAID } },
      "2026-11-19T01:24:51.420Z")
    .crashed("2026-11-19T01:24:51.377Z");
  if (hold) t.aside(HOLD, { kind: "alert" }, "2026-11-19T01:25:00.000Z");
  return t.start(4, "RUN1", "2026-11-19T01:25:32.225Z", "从中断处继续：顶级审查")
    .resume("2026-11-19T01:25:32.815Z")
    .noVerdict(4, "2026-11-19T01:26:41.190Z")
    .crashed("2026-11-19T01:26:41.160Z")
    .start(1, "RUN2", "2026-11-19T01:27:18.561Z")
    .toString();
};
// 第 1 轮（新的一场）：第一次也断了，随后重跑、正在审。
const reviewerBOutput = (rerun: boolean) => {
  const t = transcript().resume("2026-11-19T01:27:19.114Z").noVerdict(1, "2026-11-19T01:28:02.965Z").crashed("2026-11-19T01:28:02.937Z");
  if (rerun) {
    t.start(1, "RUN2", "2026-11-19T01:28:20.271Z", "重跑上一回合：顶级审查")
      .resume("2026-11-19T01:28:20.760Z")
      .text("构建已通过。发现一处旧环境变量隔离风险，接下来做最小冒烟并核对同类位置。", "2026-11-19T01:28:38.064Z");
  }
  return t.toString();
};

const cause = { kind: "interrupted", reason: "模型上游连不上（503）", said: SAID };
const run = (id: string, round: number, status: string, startedAt: string, extra: Record<string, unknown>) => ({
  id, reviewerId: null, reviewerName: "顶级审查", agentType: "codex", executorId: null, executorLabel: null,
  model: "gpt-6.1-sol", reasoningEffort: "medium", checkMode: "logic", note: null, target: { kind: "workspace" },
  retryLimit: 5, currentRound: round, status, createdAt: startedAt, updatedAt: startedAt, finishedAt: null,
  rounds: [{ round, status: "error", conclusion: null, reviewedCommit: "c1", reportMarkdown: "", screenshots: [], dispute: null, startedAt, endedAt: null, ...extra }],
});
const reviews = (second: Record<string, unknown>): FreeReviewRun[] => [
  run("RUN1", 4, "failed", "2026-11-19T01:23:13.264Z", { noVerdict: cause }),
  run("RUN2", 1, "reviewing", "2026-11-19T01:27:18.145Z", second),
] as unknown as FreeReviewRun[];

/** 跟 ConversationFeed 同一条链路：foldMonitorWakes → 审查段 → 辩论 → 归属与尾注。 */
function display(raw: ConversationItem[], runs: FreeReviewRun[], held?: ReadonlySet<string>) {
  const items = foldMonitorWakes(raw);
  const feedRows = conversationFeedRows(items, { reviews: runs });
  const causes = laneNoVerdicts(feedRows, runs);
  const shown = conversationSystemRows(conversationDebateRows(feedRows, { reviews: runs }), { failures: crashedTurns(items, null), causes, held });
  const turn = items.find((item) => item.kind === "agent" && item.sessionRole === "single");
  assert(turn, "夹具里得有执行者那一回合");
  return { shown, turnId: turn.id, footnote: (shown.footnotes.get(turn.id)?.parts ?? []).map((part) => part.view.text) };
}
const ENDED_B = { endedAt: "2026-11-19T01:28:02.937Z", exitStatus: 1 } as Partial<Session>;
const persisted = (bOutput: string, bSession: Session, hold = false) => buildConversationItems(
  [{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: reviewerA, output: reviewerAOutput(hold), trace: [] }, { session: bSession, output: bOutput, trace: [] }],
  [exec, reviewerA, bSession], [],
);
const reviewish = (text: string) => /中断|模型上游|续聊回合|没有给出结论/.test(text);

// ① 截图那一刻：重跑正在审。
{
  const { shown, turnId, footnote } = display(persisted(reviewerBOutput(true), reviewerB()), reviews({ status: "reviewing" }));
  assert.deepEqual(footnote.filter(reviewish), [], `执行者回合的尾注里出现了审查的话：${JSON.stringify(footnote)}`);
  const last = shown.rows.at(-1)!;
  assert.equal(last.kind, "review-lane", "会话最后是正在审的那一轮（右边那颗进行中的气泡）");
  const receipts = (shown.receipts.get(turnId) ?? []).map((receipt) => receipt.view.text);
  assert.ok(receipts.some((text) => text.startsWith("续聊回合异常结束")), "审查者的结算说明还在那一回合的记录里");
  assert.ok(receipts.some((text) => /第 4 轮审查中断/.test(text)), "第 4 轮的原因旁注还在那一回合的记录里");
  assert.equal(shown.rows.filter((row) => row.kind === "verdict").length, 0, "被重跑盖过的结论都撤了");
}

// ② 重跑还没开始：新一场第 1 轮的结论气泡在，原因只说一句，审查者那句结算说明并进原因。
{
  const runs = reviews({ noVerdict: cause, endedAt: "2026-11-19T01:28:02.937Z" });
  const { shown, footnote } = display(persisted(reviewerBOutput(false), reviewerB(ENDED_B)), runs);
  assert.deepEqual(footnote.filter(reviewish), [], `执行者回合的尾注里出现了被盖过的第 4 轮：${JSON.stringify(footnote)}`);
  const verdicts = shown.rows.filter((row) => row.kind === "verdict");
  assert.equal(verdicts.length, 1, "只留最近那一行结论");
  const trailing = verdicts[0]!.footnote.parts.map((part) => part.view.text);
  assert.deepEqual(trailing, ["中断 · 模型上游连不上（503）"], `结论气泡下面：${JSON.stringify(trailing)}`);
}

// ③ 被盖过的第 4 轮此刻还能续（挂着「继续本轮审查」）：那一句跟到下一行结论下面。
{
  const held = new Set([noVerdictPartId("RUN1", 4)]);
  const runs = reviews({ noVerdict: cause, endedAt: "2026-11-19T01:28:02.937Z" });
  const { shown, footnote } = display(persisted(reviewerBOutput(false), reviewerB(ENDED_B)), runs, held);
  assert.deepEqual(footnote.filter(reviewish), [], "挂着动作的那一句也不落执行者回合");
  const verdict = shown.rows.find((row) => row.kind === "verdict");
  assert(verdict && verdict.kind === "verdict");
  assert.ok(verdict.footnote.parts.some((part) => part.id === noVerdictPartId("RUN1", 4)), "挂着动作的那一句跟到了下一行结论下面");
}

// ④ 开着页面看：新一场第 1 轮那次断掉的结算说明是直播到的。
{
  const server = (event: Record<string, unknown>, id: string) => ({
    kind: "server", id,
    event: { type: "agent.event", taskId: "y8S-yZjD0eaK", sessionId: reviewerB().id, role: "reviewer", agentType: "codex", turnStartedAt: "2026-11-19T01:27:19.114Z", event },
  });
  const timeline = [
    server({ kind: "system", text: "自由工作流第 1 轮审查未能正常给出结论，已停止自动链。", aside: true, at: "2026-11-19T01:28:02.965Z",
      notice: { kind: "review.verdict", source: "free", round: 1, verdict: "inconclusive", reviewer: "顶级审查" } }, "live-0"),
    server({ kind: "done", exitStatus: 1 }, "live-1"),
    server({ kind: "system", text: CRASH, at: "2026-11-19T01:28:02.937Z", level: "notice" }, "live-2"),
    server({ kind: "system", text: "自由工作流第 1 轮审查重跑上一回合：顶级审查。", aside: true, at: "2026-11-19T01:28:20.271Z",
      notice: { kind: "review.start", source: "free", round: 1, reviewer: "顶级审查", runId: "RUN2", rerun: true } }, "live-3"),
  ] as unknown as TimelineEntry[];
  const items = buildConversationItems(
    [{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: reviewerA, output: reviewerAOutput(), trace: [] }, { session: reviewerB(), output: transcript().resume("2026-11-19T01:27:19.114Z").toString(), trace: [] }],
    [exec, reviewerA, reviewerB()], timeline,
  );
  const note = items.find((item) => item.kind === "event" && item.text === CRASH && item.sessionId === reviewerB().id);
  assert.equal(note?.kind === "event" ? note.sessionRole : undefined, "reviewer", "直播到的结算说明带着会话角色");
  const { footnote } = display(items, reviews({ status: "reviewing" }));
  assert.deepEqual(footnote.filter(reviewish), [], `开着页面看，执行者回合的尾注里出现了审查的话：${JSON.stringify(footnote)}`);
}

// ⑤ 任务的事照旧：被盖过的那一行下面的「验收暂缓」回到执行者回合的尾注。
{
  const items = persisted(reviewerBOutput(true), reviewerB(), true);
  const { footnote } = display(items, reviews({ status: "reviewing" }));
  assert.ok(footnote.some((text) => text.startsWith(HOLD.slice(0, 4))), `任务的事该回到执行者回合的尾注：${JSON.stringify(footnote)}`);
  assert.deepEqual(footnote.filter(reviewish), []);
}

// ⑥ 认不出审查段的老记录（没有「开始」那一条）：没有气泡可贴，结论那一句和原因旁注照旧落在执行者回合上，
//    「继续本轮审查」退回挂在原因旁注上（footnoteActions 的 retryEventId），这一句不许被拿掉；
//    审查者会话那句结算说明照样只进记录。
{
  const legacy = transcript()
    .resume("2026-11-19T01:23:14.176Z")
    .noVerdict(4, "2026-11-19T01:24:51.409Z")
    .aside("第 4 轮审查中断：模型上游连不上（503）。", { kind: "review.no_verdict", source: "free", runId: "RUN1", round: 4, cause }, "2026-11-19T01:24:51.420Z")
    .crashed("2026-11-19T01:24:51.377Z")
    .toString();
  const items = buildConversationItems(
    [{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: reviewerA, output: legacy, trace: [] }], [exec, reviewerA], [],
  );
  const why = items.find((item) => item.kind === "event" && item.notice?.kind === "review.no_verdict");
  assert(why);
  const { footnote } = display(items, [], new Set([why.id]));
  assert.ok(footnote.some((text) => /第 4 轮审查中断/.test(text)), `挂着「继续本轮审查」的那一句不许被拿掉：${JSON.stringify(footnote)}`);
  assert.ok(!footnote.some((text) => text.startsWith("续聊回合")), "审查者那句结算说明不进执行者回合的尾注");
}

console.log("✓ review voice stays off the executor's footnote");
