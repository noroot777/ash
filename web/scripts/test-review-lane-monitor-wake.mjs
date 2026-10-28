// 哨兵自动输入跟审查卡的关系:它是**一次新输入**,不是旁注,所以不能无条件折进审查卡 ——
// 卡默认收起,折进去就等于藏掉,而紧随的执行者回合落在主流上还标着「回复这次自动输入」,
// 用户读到的是「回合说在回复一条看不见的输入」(现场实测:整合任务 W54czudPJ9Q9 06:52:37
// 那条投喂就藏在「第 1 轮审查」卡的展开区里)。
//
// 判据按**喂进了哪条会话**:自由派审另开一条 reviewer 会话,不是那条就是别人的输入;就地
// 验证跟执行者共用会话、分不开,退到「这一轮已经出结论了」。审查者自己挂哨兵 + pause_task
// 是常规做法,那一段必须留在卡里 —— 收错卡的代价是审查者后续发言整段掉出卡外。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";
import { monitorWakeReplyIds } from "../src/task-detail/monitorWakeModel.ts";

const base = {
  taskId: "t1", agentType: "codex", executor: "codex@cpa", role: "single",
  model: "gpt-5.6-sol", reasoningEffort: "xhigh", endedAt: null,
};
const main = { ...base, id: "s1", startedAt: "2026-08-11T01:50:00.000Z" };
const reviewer = { ...base, id: "s3", role: "reviewer", startedAt: "2026-08-11T02:10:00.000Z" };
const turn = (kind, text, at, extra = {}) => `\x1e${JSON.stringify({ t: kind, text, at, ...extra })}`;
const wakeData = (monitorId) => ({
  version: 1, omittedEvents: 0,
  events: [{ kind: "ended", monitorId, source: "回归", body: "rc=0" }],
});
const wakeTurn = (at, monitorId) => turn(
  "user", `【哨兵结束】回归（monitorId=${monitorId}）\nrc=0`, at,
  { by: "system", monitorWake: wakeData(monitorId) },
);
const FREE_START = "自由工作流第 1 轮审查开始：5.5审查 · 逻辑检查。";
const rowsOf = (persisted, sessions) => conversationFeedRows(
  buildConversationItems(persisted, sessions, []), { reviews: [] },
);
const laneOf = (rows) => rows.find((row) => row.kind === "review-lane");
const mainStream = (rows) => rows.filter((row) => row.kind === "item").map((row) => row.item);

// ① 现场那条:审查已交卷、收尾旁注却没写出来(D6 的后果),哨兵结果把**执行者**叫醒。
//    那条自动输入喂的是执行者会话,必须落主流自成一条,不许进审查卡。
const stalled = rowsOf(
  [
    { session: main, output: [
      turn("system", FREE_START, "2026-08-11T02:00:00.000Z"),
      wakeTurn("2026-08-11T02:50:00.000Z", "m-exec"),
      "执行者收到哨兵结果后说的话。",
    ].join("\n"), trace: [] },
    { session: reviewer, output: "审查意见正文。", trace: [] },
  ],
  [main, reviewer],
);
const stalledLane = laneOf(stalled);
assert.ok(stalledLane, "审查开始旁注照旧折成卡");
assert.deepEqual(stalledLane.items.map((item) => item.kind), ["agent"],
  "卡里只该有本轮审查者的发言,执行者的自动输入不属于这一轮");
assert.deepEqual(
  mainStream(stalled).map((item) => item.kind),
  ["user", "agent"],
  "自动输入要跟它唤醒的那个回合一起落在主流上",
);
// 回合折叠条上的「回复这次自动输入」扫的是聚合前的条目:输入看得见,这条标注才说得通。
const replies = monitorWakeReplyIds(
  buildConversationItems(
    [
      { session: main, output: [
        turn("system", FREE_START, "2026-08-11T02:00:00.000Z"),
        wakeTurn("2026-08-11T02:50:00.000Z", "m-exec"),
        "执行者收到哨兵结果后说的话。",
      ].join("\n"), trace: [] },
      { session: reviewer, output: "审查意见正文。", trace: [] },
    ],
    [main, reviewer],
    [],
  ),
);
const wokenTurn = mainStream(stalled).find((item) => item.kind === "agent");
assert.equal(replies.has(wokenTurn.id), true, "被叫醒的那个回合仍标成「回复这次自动输入」");

// ② 反面:审查者**自己**挂的哨兵(审查里跑回归的常规做法)。输入喂的是 reviewer 会话,
//    留在卡里 —— 收卡的话它续跑后的发言会整段掉出卡外,比晚收一拍难看懂得多。
const reviewerWake = rowsOf(
  [
    { session: main, output: turn("system", FREE_START, "2026-08-11T02:00:00.000Z"), trace: [] },
    { session: reviewer, output: [
      "先把回归挂上,等结果。",
      wakeTurn("2026-08-11T02:50:00.000Z", "m-review"),
      "回归绿了,结论照原样交。",
    ].join("\n"), trace: [] },
  ],
  [main, reviewer],
);
const reviewerLane = laneOf(reviewerWake);
assert.ok(reviewerLane);
assert.deepEqual(reviewerLane.items.map((item) => item.kind), ["agent", "user", "agent"],
  "审查者自己那条哨兵输入和它续跑后的发言都属于这一轮");
assert.deepEqual(mainStream(reviewerWake), [], "不该有任何东西被挤出卡外");

// ③ 就地验证跟执行者共用一条会话,按会话分不开 —— 没出结论前一律留在卡里,不许把一张
//    验证卡劈成两半(劈开后下半截没有开始旁注,再也折不回去)。
const inlineSession = { ...main, id: "s9" };
const inline = rowsOf(
  [
    { session: inlineSession, output: [
      turn("system", "第 2 轮验证开始：就在这个任务的工作目录里跑。", "2026-08-11T03:00:00.000Z"),
      "验证回合说的话。",
      wakeTurn("2026-08-11T03:20:00.000Z", "m-inline"),
      "验证回合收到结果后接着说。",
    ].join("\n"), trace: [
      { at: "2026-08-11T03:00:00.000Z", turnStartedAt: "2026-08-11T03:00:00.000Z",
        event: { kind: "run", model: "gpt-5.6-sol", reasoningEffort: "xhigh", verifyRound: 2 } },
      { at: "2026-08-11T03:20:00.000Z", turnStartedAt: "2026-08-11T03:20:00.000Z",
        event: { kind: "run", model: "gpt-5.6-sol", reasoningEffort: "xhigh", verifyRound: 2 } },
    ] },
  ],
  [inlineSession],
);
const inlineLane = laneOf(inline);
assert.ok(inlineLane, "就地验证照旧折成卡");
assert.equal(inlineLane.items.some((item) => item.kind === "user"), true,
  "同会话时分不出收件人,没出结论就留在卡里");
assert.deepEqual(mainStream(inline), [], "不许把验证卡劈成两半");

console.log("✓ 哨兵自动输入:喂给执行者的落主流自成一条,喂给审查者自己的留在卡里,就地验证同会话不劈卡");
