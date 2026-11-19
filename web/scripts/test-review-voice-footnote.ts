// 审查自己的话只贴在审查气泡下面，不落进执行者那一回合的尾注。
//
// 现场（2026-11-19，任务 y8S-yZjD0eaK，用户截图）：执行者那一回合正文下面挂着「中断 · 模型上游连不上（503）
// · 续聊回合异常结束(退出码 1),任务状态保持「已完成」不变」，点开是「执行器的原话：…503…」，看着就是执行者
// 那一回合出了事。其实是审查者断了：第 4 轮两次撞上 503，新派的第 1 轮第一次也撞上，随后重跑、正在审。
// 根因在归属（conversationSystemRows 的 attach）：同一回合上又出一轮结论时，被盖过的那一行撤掉、贴在它
// 下面的那几句**整组**回到执行者回合的尾注，里面恰好有审查自己的话——为什么没结论（那一句原因、服务端说同
// 一件事的旁注）和审查者会话给它自己那一回合写的结算说明。夹具照那条任务的会话录压缩。这份回归盯：
//   ① 刷新后从落盘重建：执行者回合的尾注和「N 条记录」里都没有审查的话，记录里只剩每一轮的结论那一条
//      （点它去那一轮）；审查者会话那句「任务状态保持不变」哪儿都不画；
//   ② 重跑还没开始时（最后那一轮的结论气泡还在）：气泡下面只有原因那一句，被盖过的第 4 轮那几句不回执行者回合；
//   ③ 被盖过的那一轮此刻还挂着动作（「继续本轮审查」）：那一句跟到这一回合的下一行结论下面，不落执行者回合；
//   ④ 开着页面看：审查者会话的结算说明是直播到的，同样认得出是审查者的话（条目带着会话角色）；
//   ⑤ 任务的事（验收暂缓之类）照旧：被盖过的那一行下面的它们回到执行者回合的尾注；
//   ⑥ 认不出审查段的老记录：原因旁注照旧落在执行者回合上（「继续本轮审查」退回挂在它上面），结算说明不进尾注；
//   ⑦ 审查者那一回合收口后说的别的事（改落检查点暂停）：不被「没结论」的原因吞掉，记进这一轮的经过
//      （审查者那一回合的记录上），不进执行者回合的尾注和记录；这一轮被重跑盖过后，经过里照样在；
//   ⑧ 另一条审查者会话说的事（归档没成）：那条会话没在哪一轮里出现过，紧跟在收口后面就算这一轮的，不吞、不丢；
//   ⑨ 审查者一句没说就断了（会话身份只能从开轮/结论那几条认）：后到的检查点那一句照样是那一轮的；
//   ⑩ 晚到、中间隔着执行者的新一回合：按会话认回那一轮，不记给执行者的新回合；
//   ⑪ 会话里根本没有审查段（老记录）：审查者会话那一回合的话认不出是哪一轮，在原处单独记一笔，不记给执行者；
//   ⑫ 会话说明（换人接手另开会话，生产者不写 level）：认它靠记录格式不靠语气——收口后到的记进那一轮，没有
//      审查段的在原处单独记一笔；改写法之前的老任务时间线（同样不带标）照旧是任务的事。
// 跑：npm -w web run test:review-voice-footnote
import assert from "node:assert/strict";
import type { FreeReviewRun, Session } from "@navi/shared";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../src/task-detail/conversationModel.ts";
import { foldMonitorWakes } from "../src/task-detail/monitorWakeTurns.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";
import { conversationDebateRows } from "../src/task-detail/conversationDebateRows.ts";
import { conversationSystemRows, laneReceipts } from "../src/task-detail/conversationSystemRows.ts";
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
    /** 会话自己的系统行（会话说明那一类：不带 level、不带 aside）。 */
    note(text: string, at: string) { put({ t: "system", agent: "codex", text }, at); return self; },
    aside(text: string, notice: Record<string, unknown>, at: string) { put({ t: "system", agent: "codex", aside: true, text, notice }, at); return self; },
    noVerdict(round: number, at: string) {
      return self.aside(`自由工作流第 ${round} 轮审查未能正常给出结论，已停止自动链。`,
        { kind: "review.verdict", source: "free", round, verdict: "inconclusive", reviewer: "顶级审查" }, at);
    },
    crashed(at: string, text = CRASH) {
      const note = ++seq;
      put({ t: "agentEnd" }, at);
      put({ t: "system", agent: "codex", text, level: "notice" }, at, note);
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
  const receipts = shown.receipts.get(turnId) ?? [];
  const loose = receipts.filter((receipt) => !receipt.lane).map((receipt) => receipt.view.text);
  assert.deepEqual(loose.filter(reviewish), [], `执行者回合的记录里出现了审查的话：${JSON.stringify(loose)}`);
  assert.equal(receipts.filter((receipt) => receipt.lane).length, 3, "被盖过的三行结论都还在那一回合的记录里（点它去那一轮）");
  assert.equal(shown.rows.filter((row) => row.kind === "verdict").length, 0, "被重跑盖过的结论都撤了");
  const everywhere = JSON.stringify(shown.rows);
  assert.ok(!everywhere.includes("任务状态保持"), "审查者会话那句「任务状态保持不变」哪儿都不画（审查段的经过里也没有）");
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
  const { shown, turnId } = display(items, [], new Set([why.id]));
  const records = (shown.receipts.get(turnId) ?? []).map((receipt) => receipt.view.text);
  assert.ok(records.some((text) => /第 4 轮审查中断/.test(text)), "没有结论那一行可代表这一轮：原因旁注照旧记在这一回合上，删除在这里");
}

/** 这一句在页面上落在哪儿：执行者回合的尾注/记录、哪一轮审查的经过、原处单独那一笔。 */
function placesOf(view: ReturnType<typeof display>, test: (text: string) => boolean) {
  const found = new Set<string>();
  const has = (item: ConversationItem | undefined) => item?.kind === "event" && test(item.text);
  if ((view.shown.footnotes.get(view.turnId)?.parts ?? []).some((part) => part.kind === "event" && has(part.item))) found.add("executor-footnote");
  for (const [id, list] of view.shown.receipts) {
    for (const receipt of list) {
      if (receipt.lane?.items.some(has)) found.add("lane");
      if (!receipt.lane && has(receipt.item)) found.add(id === view.turnId ? "executor-records" : `records:${id}`);
    }
  }
  for (const row of view.shown.rows) {
    if (row.kind === "verdict" && row.lane.items.some(has)) found.add("lane");
    if (row.kind === "review-lane" && row.items.some(has)) found.add("lane");
    if (row.kind === "footnote" && (row.receipts.some((receipt) => has(receipt.item)) || row.footnote.parts.some((part) => part.kind === "event" && has(part.item)))) found.add("standalone");
  }
  return found;
}

// ⑦ + ⑧：审查者开过口的一轮，中断收口后审查者会话又说了别的事。
{
  const CHECKPOINT = "本回合要落的终态被拦下，改为检查点暂停：名下还有没了结的哨兵（回归测试）。";
  const ARCHIVE = "Codex 会话自动归档未完成，桌面端可能仍显示此会话；执行结果与续跑记录保留。permission denied";
  const reviewer = { ...reviewerA, id: "R-spoke", startedAt: "2026-11-19T01:23:13.700Z" } as unknown as Session;
  const other = { ...reviewerA, id: "R-other", startedAt: "2026-11-19T01:00:00.000Z" } as unknown as Session;
  const build = (rerun: boolean) => {
    const t = transcript()
      .start(1, "RUN3", "2026-11-19T01:23:13.722Z")
      .resume("2026-11-19T01:23:14.176Z")
      .text("先看改动范围，再跑一遍构建。", "2026-11-19T01:23:30.000Z")
      .noVerdict(1, "2026-11-19T01:24:51.409Z")
      .crashed("2026-11-19T01:24:51.377Z", CHECKPOINT);
    if (rerun) t.start(1, "RUN3", "2026-11-19T01:25:30.000Z", "重跑上一回合：顶级审查");
    const otherOutput = transcript().crashed("2026-11-19T01:24:52.000Z", ARCHIVE).toString();
    return buildConversationItems(
      [{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: other, output: otherOutput, trace: [] }, { session: reviewer, output: t.toString(), trace: [] }],
      [exec, other, reviewer], [],
    );
  };
  const runs = [run("RUN3", 1, "failed", "2026-11-19T01:23:13.264Z", { noVerdict: cause })] as unknown as FreeReviewRun[];
  const kept = (text: string) => text.includes("检查点暂停");

  const settled = display(build(false), runs);
  assert.deepEqual(settled.footnote.filter((text) => kept(text) || reviewish(text)), [], `执行者回合的尾注里出现了审查的话：${JSON.stringify(settled.footnote)}`);
  const loose = (settled.shown.receipts.get(settled.turnId) ?? []).filter((receipt) => !receipt.lane).map((receipt) => receipt.view.text);
  assert.ok(!loose.some(kept), `检查点那一句不该记进执行者回合的记录：${JSON.stringify(loose)}`);
  const verdict = settled.shown.rows.find((row) => row.kind === "verdict");
  assert(verdict && verdict.kind === "verdict", "这一轮收了口，是一行结论");
  const under = verdict.footnote.parts.map((part) => part.view.text);
  assert.deepEqual(under, ["中断 · 模型上游连不上（503）"], `结论下面只有原因那一句：${JSON.stringify(under)}`);
  const round = laneReceipts(verdict.lane);
  const said = [...round.receipts.values()].flat().map((receipt) => receipt.item?.text ?? "");
  assert.ok(said.some(kept), `检查点那一句没被原因吞掉，记在这一轮审查者那一回合上：${JSON.stringify(said)}`);
  const archived = (text: string) => text.includes("归档");
  assert.deepEqual([...placesOf(settled, archived)], ["lane"], "另一条会话说的事紧跟在收口后面：记进这一轮，不记给执行者");

  const superseded = display(build(true), runs);
  assert.deepEqual(superseded.footnote.filter((text) => kept(text) || reviewish(text)), [], `被盖过以后执行者回合的尾注里出现了审查的话：${JSON.stringify(superseded.footnote)}`);
  const lanes = (superseded.shown.receipts.get(superseded.turnId) ?? []).flatMap((receipt) => receipt.lane ? [receipt.lane] : []);
  assert.ok(lanes.some((lane) => [...laneReceipts(lane).receipts.values()].flat().some((receipt) => kept(receipt.item?.text ?? ""))),
    "被盖过的那一轮，经过里照样有检查点那一句");
  assert.deepEqual([...placesOf(superseded, archived)], ["lane"], "被盖过以后，另一条会话说的事还在那一轮里");
}

// ⑨ + ⑩ + ⑪：审查者一句没说就断了、晚到隔着执行者的新回合、会话里根本没有审查段。
{
  const PAUSED = "本回合要落的终态被拦下，改为检查点暂停：后台工作还没跑完。";
  const LATER = "Codex 会话自动归档未完成，桌面端可能仍显示此会话；执行结果与续跑记录保留。late";
  const silent = { ...reviewerA, id: "R-silent", startedAt: "2026-11-19T01:23:13.700Z" } as unknown as Session;
  const runs = [run("RUN4", 1, "failed", "2026-11-19T01:23:13.264Z", { noVerdict: cause })] as unknown as FreeReviewRun[];
  const reviewerOutput = transcript()
    .start(1, "RUN4", "2026-11-19T01:23:13.722Z")
    .resume("2026-11-19T01:23:14.176Z")
    .noVerdict(1, "2026-11-19T01:23:20.000Z")
    .crashed("2026-11-19T01:23:19.900Z", PAUSED);
  const moreExec = [
    line({ t: "user", agent: "claude", text: "先接着改别的。", at: "2026-11-19T01:30:00.000Z", seq: 4, turnStartedAt: "2026-11-19T01:30:00.000Z" }),
    line({ t: "agent", at: "2026-11-19T01:31:00.000Z", seq: 5, turnStartedAt: "2026-11-19T01:30:00.000Z" }),
    "好，另外两处也改了。\n",
    line({ t: "agentEnd", at: "2026-11-19T01:31:30.000Z", seq: 6, turnStartedAt: "2026-11-19T01:30:00.000Z" }),
  ].join("");
  // 那条审查者会话后来又落了一句（归档没成），这时执行者已经跑完了新的一回合。
  reviewerOutput.crashed("2026-11-19T01:32:00.000Z", LATER);
  const items = buildConversationItems(
    [{ session: exec, output: EXEC_OUTPUT + moreExec, trace: [] }, { session: silent, output: reviewerOutput.toString(), trace: [] }], [exec, silent], [],
  );
  const view = display(items, runs);
  const executorTurns = items.filter((item) => item.kind === "agent" && item.sessionRole === "single").map((item) => item.id);
  assert.equal(executorTurns.length, 2);
  const onExecutor = (test: (text: string) => boolean) => executorTurns.some((id) =>
    (view.shown.receipts.get(id) ?? []).some((receipt) => !receipt.lane && receipt.item?.kind === "event" && test(receipt.item.text))
    || (view.shown.footnotes.get(id)?.parts ?? []).some((part) => part.kind === "event" && part.item?.kind === "event" && test(part.item.text)));
  assert.ok(!onExecutor((text) => text.includes("后台工作还没跑完")), "⑨ 审查者没开过口，那一轮的检查点那一句也不记给执行者");
  assert.ok(placesOf(view, (text) => text.includes("后台工作还没跑完")).has("lane"), "⑨ 检查点那一句在那一轮的经过里");
  assert.ok(!onExecutor((text) => text.endsWith("late")), "⑩ 晚到、隔着执行者新回合的那一句不记给执行者");
  const lanes = view.shown.rows.flatMap((row) => row.kind === "verdict" ? [row.lane] : [])
    .concat([...view.shown.receipts.values()].flat().flatMap((receipt) => receipt.lane ? [receipt.lane] : []));
  assert.ok(lanes.some((lane) => lane.items.some((item) => item.kind === "event" && item.text.endsWith("late"))), "⑩ 按会话认回了那一轮");

  // ⑪ 会话里没有审查段：同一条审查者会话，只有它自己那一回合的话。
  const bare = transcript().crashed("2026-11-19T01:24:00.000Z", PAUSED).toString();
  const legacy = display(buildConversationItems(
    [{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: silent, output: bare, trace: [] }], [exec, silent], [],
  ), []);
  const where = placesOf(legacy, (text) => text.includes("后台工作还没跑完"));
  assert.deepEqual([...where], ["standalone"], `⑪ 认不出是哪一轮的，在原处单独记一笔：${JSON.stringify([...where])}`);
}

// ⑫ 会话说明不带 level：落盘、直播两路。
{
  const HANDOVER = "〔换人接手〕这一轮由另一位用户发起。CLI 的会话记录存在发起人自己的配置目录里（多人模式下一人一份），这条会话不在那儿，续用它只会当场扑空，所以本轮另开了一条新会话。这条会话原样保留，原来那位再回来时仍从这里接着跑。";
  const handover = (text: string) => text.startsWith("〔换人接手〕");
  const R = { ...reviewerA, id: "R-hand", startedAt: "2026-11-19T01:23:13.700Z" } as unknown as Session;
  const runs = [run("RUN5", 1, "failed", "2026-11-19T01:23:13.264Z", { noVerdict: cause })] as unknown as FreeReviewRun[];
  const onExecutor = (view: ReturnType<typeof display>, test: (text: string) => boolean) => {
    const where = placesOf(view, test);
    return where.has("executor-records") || where.has("executor-footnote");
  };
  // 收口之后到的。
  const after = transcript().start(1, "RUN5", "2026-11-19T01:23:13.722Z").resume("2026-11-19T01:23:14.176Z")
    .noVerdict(1, "2026-11-19T01:23:20.000Z").note(HANDOVER, "2026-11-19T01:23:21.000Z").toString();
  const closed = display(buildConversationItems([{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: R, output: after, trace: [] }], [exec, R], []), runs);
  assert.ok(!onExecutor(closed, handover), `收口后到的会话说明不记给执行者：${JSON.stringify([...placesOf(closed, handover)])}`);
  assert.ok(placesOf(closed, handover).has("lane"), "收口后到的会话说明记进那一轮");
  // 没有审查段，落盘那一路。
  const bare = transcript().note(HANDOVER, "2026-11-19T01:24:00.000Z").toString();
  const persistedBare = display(buildConversationItems([{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: R, output: bare, trace: [] }], [exec, R], []), []);
  assert.deepEqual([...placesOf(persistedBare, handover)], ["standalone"], "没有审查段：会话说明在原处单独记一笔");
  // 没有审查段，直播那一路（announceSessionNote 广播的就是一条不带 level 的 system）。
  const timeline = [{ kind: "server", id: "live-hand", event: {
    type: "agent.event", taskId: "y8S-yZjD0eaK", sessionId: R.id, role: "reviewer", agentType: "codex",
    event: { kind: "system", text: HANDOVER, at: "2026-11-19T01:24:00.000Z" },
  } }] as unknown as TimelineEntry[];
  const live = display(buildConversationItems([{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: R, output: "", trace: [] }], [exec, R], timeline), []);
  assert.ok(!onExecutor(live, handover), `直播到的会话说明不记给执行者：${JSON.stringify([...placesOf(live, handover)])}`);
  // 改写法之前，任务时间线也不带标、写在审查者会话里：那是任务的事，照旧记给执行者那一回合。
  const OLD = "验收完成：目标分支 main；任务 status 保持 done。";
  const old = (text: string) => text.startsWith("验收完成");
  const oldTimeline = transcript().note(OLD, "2026-08-20T01:24:00.000Z").toString();
  const oldExec = { ...exec, startedAt: "2026-08-20T01:19:23.365Z" } as unknown as Session;
  const oldOutput = EXEC_OUTPUT.replaceAll("2026-11-19", "2026-08-20");
  const legacy = display(buildConversationItems([{ session: oldExec, output: oldOutput, trace: [] }, { session: R, output: oldTimeline, trace: [] }], [oldExec, R], []), []);
  assert.ok(onExecutor(legacy, old), `改写法之前的任务时间线照旧是任务的事：${JSON.stringify([...placesOf(legacy, old)])}`);
}

console.log("✓ review voice stays off the executor's footnote");
