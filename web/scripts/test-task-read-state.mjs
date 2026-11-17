import assert from "node:assert/strict";
import { deriveTaskStatusIndicator, readEventForTask, reconcileReadState } from "../src/lib/useTaskReadState.ts";
import { dispatchedRollUp, dispatchedStateOf, taskLook } from "../src/lib/taskLook.ts";

function task(id, updatedAt) {
  return {
    id,
    parentId: null,
    mode: "single",
    status: "done",
    updatedAt,
    endedAt: updatedAt,
  };
}

const first = task("first", "2026-08-20T01:00:00.000Z");
const second = task("second", "2026-08-20T02:00:00.000Z");
const persisted = {
  first: { event: readEventForTask(first), readAt: 1 },
  second: { event: readEventForTask(second), readAt: 2 },
};

// 服务重启后，SSE 可能先于完整 GET 到达：useTasks 会短暂只有一条任务。
// 这份临时子集不能被当成删除任务的权威快照，否则 second 的已读记录会丢失，
// 完整列表到达后便重新亮成绿点。
const duringReconnect = reconcileReadState(persisted, [first], null);
assert.deepEqual(duringReconnect, persisted, "partial reconnect data must preserve other read entries");

const afterFullFetch = reconcileReadState(duringReconnect, [first, second], null);
assert.equal(
  afterFullFetch.second.event,
  readEventForTask(second),
  "the full task list must still recognize the task as read",
);

// 保留陈旧项不会掩盖真正的新一轮：终态事件版本变化时仍然不相等，调用方会判未读。
const restartedSecond = { ...second, updatedAt: "2026-08-20T03:00:00.000Z", endedAt: "2026-08-20T03:00:00.000Z" };
assert.notEqual(afterFullFetch.second.event, readEventForTask(restartedSecond));

const dot = (over, unread = false) => deriveTaskStatusIndicator({ ...task("dot", "2026-08-20T01:00:00.000Z"), ...over }, [], unread);

assert.equal(dot({ question: "选哪条？" }), "attention", "有待答问题 = 等你说话");
assert.equal(dot({ status: "paused" }), "attention", "暂停本身不能证明有后台任务");
assert.equal(dot({ status: "paused", monitorRunning: true }), "working");
assert.equal(dot({ status: "done", monitorRunning: true }), "working");
assert.equal(dot({ status: "paused", monitorRunning: false }), "attention");
assert.equal(dot({ status: "running", monitorRunning: true }), "active", "回合正跑着、顺手挂了哨兵：它本人在动，是在跑");
assert.equal(dot({ status: "awaiting_review", monitorRunning: true }), "active");
assert.equal(
  dot({ status: "paused", monitorRunning: true, question: "选哪条？" }),
  "attention",
  "既挂着哨兵又在问你：问题优先 —— 出路在你手上",
);
// 门禁跑的那十几分钟里任务的 status/stage 一个字都不变，只有这个字段看得出来。
assert.equal(dot({ stage: "awaiting_acceptance" }), "unaccepted", "干完等验收 = 靛蓝环");
assert.equal(
  dot({ stage: "awaiting_acceptance", acceptGateRunning: true }),
  "working",
  "验收前置命令正在跑：先说「有东西在跑」，别再显示成静静等你验收",
);
// 侧栏行首那张表（side-1 / side-2）：失败一直红、在跑和排队分开、验收过看过的空着。
assert.equal(dot({ status: "failed" }), "error", "失败看没看过都是红点");
assert.equal(dot({ status: "failed" }, true), "error");
assert.equal(dot({ status: "done", stage: "verify_failed" }), "error", "验证没过也是摔了");
assert.equal(dot({ status: "failed", stage: "accepted" }), "error", "盖过章又摔了的，事实是坏的");
assert.equal(dot({ status: "running" }), "active");
assert.equal(dot({ status: "awaiting_review" }), "active", "审查在跑 = 机器在动");
assert.equal(dot({ status: "queued" }), "queued");
assert.equal(dot({ status: "canceled" }), null, "取消的不亮");
assert.equal(dot({ status: "done", stage: "accepted" }), null, "验收过也看过的空着");
assert.equal(deriveTaskStatusIndicator({ ...task("dot", "2026-08-20T01:00:00.000Z"), stage: "accepted" }, [], true), "success", "验收过没看：绿点");
assert.equal(dot({ status: "done" }), "unaccepted", "做完没验收：一直在");
{
  const look = taskLook({ ...task("ask", "2026-08-20T01:00:00.000Z"), status: "paused", question: "  要不要\n顺手把旧接口删掉？ " });
  assert.equal(look.mark, "wait");
  assert.equal(look.bucket, "todo", "行首琥珀、顶上「需要你处理」：同一张表");
  assert.equal(look.word, "等你答复");
  assert.equal(look.detail, "要不要 顺手把旧接口删掉？");
  const parked = taskLook({ ...task("parked", "2026-08-20T01:00:00.000Z"), status: "paused", monitorRunning: true });
  assert.equal(parked.mark, "hold", "等哨兵：不跳的主色点，机器的事");
  assert.notEqual(parked.mark, look.mark, "等哨兵跟等你说话不是同一颗点");
  assert.equal(parked.bucket, "wait");
  assert.equal(parked.word, null, "等哨兵行尾不写字");
  const failed = taskLook({ ...task("failed", "2026-08-20T01:00:00.000Z"), status: "failed" });
  assert.deepEqual([failed.mark, failed.bucket], ["bad", "todo"]);
  const running = taskLook({ ...task("run", "2026-08-20T01:00:00.000Z"), status: "running" });
  assert.deepEqual([running.mark, running.bucket], ["run", "run"]);
  const quiet = taskLook({ ...task("quiet", "2026-08-20T01:00:00.000Z"), stage: "accepted" });
  assert.deepEqual([quiet.mark, quiet.say, quiet.bucket], [null, "", "accepted"]);
}

// 等你裁定（执行者驳回了一轮审查意见）：任务多半已经 done，不能读成「做完了，等验收」那一圈环。
{
  const at = "2026-08-20T01:00:00.000Z";
  const ruling = taskLook({ ...task("ruling", at), disputeOpen: true });
  assert.deepEqual([ruling.indicator, ruling.mark, ruling.word, ruling.bucket], ["attention", "wait", "等你裁定", "todo"]);
  const parkedRuling = taskLook({ ...task("ruling", at), status: "paused", disputeOpen: true });
  assert.deepEqual([parkedRuling.word, parkedRuling.bucket], ["等你裁定", "todo"], "停在检查点等裁定：也归「需要你处理」");
  assert.equal(dot({ stage: "verify_failed", disputeOpen: true }), "attention", "被驳回的正是没过的那一轮：下一步是你拍板");
  assert.equal(dot({ status: "running", disputeOpen: true }), "active", "跑着的时候事实是在跑");
  assert.equal(dot({ status: "failed", disputeOpen: true }), "error");
  assert.equal(dot({ stage: "accepted", disputeOpen: true }), null, "验收过的裁不了，不再催");
  assert.equal(dot({ archived: true, disputeOpen: true }), "unaccepted", "归档的裁不了");
  assert.equal(taskLook({ ...task("ask", at), status: "paused", question: "问你", disputeOpen: true }).word, "等你答复", "明着问你的先说");
}

{
  const at = "2026-08-20T01:00:00.000Z";
  const phrase = (over, dispatched = null, workers = []) => taskLook({ ...task("p", at), ...over }, workers, false, dispatched).phrase;
  const words = (over) => phrase(over)?.word ?? null;
  assert.equal(words({ status: "paused", question: "问你" }), "等你答复");
  assert.equal(words({ disputeOpen: true }), "等你裁定");
  assert.equal(words({ status: "paused" }), "已暂停");
  assert.equal(words({ status: "backlog", prerequisites: { prerequisites: [], dependents: [], waiting: false, blocked: "合不拢", launched: false } }), "开不了工");
  const open = { id: "pre", title: "前置", step: "running" };
  assert.equal(words({ status: "backlog", prerequisites: { prerequisites: [open], dependents: [], waiting: true, blocked: null, launched: false, holdup: null } }), "等前置");
  // 没有前置、只是等名额 / 分组恢复：不说「前置」，指上去那句是服务端说的在等什么。
  const capacity = { prerequisites: [], dependents: [], waiting: true, blocked: null, launched: false, holdup: "同组已有 4 条在跑，空出来就开工" };
  assert.equal(words({ status: "backlog", prerequisites: capacity }), "等开工");
  assert.equal(phrase({ status: "backlog", prerequisites: capacity }).tip, capacity.holdup);
  assert.equal(words({ status: "failed" }), "失败");
  assert.equal(words({ stage: "verify_failed" }), "验证没过");
  assert.equal(words({ status: "running", upstreamStalled: true }), "卡在上游");
  assert.equal(words({ status: "running" }), "运行中");
  assert.equal(words({ status: "awaiting_review" }), "审查中");
  assert.equal(words({ status: "paused", monitorRunning: true }), "等哨兵");
  assert.equal(words({ acceptGateRunning: true }), "跑验收检查");
  assert.equal(words({ status: "queued" }), "排队中");
  assert.equal(words({}), "待验收");
  assert.equal(taskLook({ ...task("p", at), stage: "accepted" }, [], true).phrase?.word, "有新动态");
  assert.equal(words({ stage: "accepted" }), null, "验收过也看过：什么都不写");
  assert.equal(words({ status: "canceled" }), null);
  assert.deepEqual([phrase({ status: "paused", question: "问你" }).tone, phrase({ status: "failed" }).tone, phrase({ status: "running" }).tone], ["ask", "bad", null]);
  assert.equal(phrase({ status: "paused", question: "  要不要\n删掉？ " }).tip, "要不要 删掉？", "指上去是问题本身");

  const child = (over, title) => dispatchedStateOf({ ...task(title, at), title, ...over });
  assert.equal(dispatchedRollUp([child({}, "a"), child({ stage: "accepted" }, "b")]), null, "名下做完没验收、验收过的不往上带");
  assert.equal(child({ stage: "accepted" }, "b"), null, "验收过的没有短语");
  const running = child({ status: "running" }, "跑着的");
  const asking = child({ status: "paused", question: "?" }, "问你的");
  const broken = child({ status: "failed" }, "摔了的");
  assert.equal(dispatchedRollUp([running, broken, asking]), asking, "轮到你的压过失败、在跑");
  assert.equal(dispatchedRollUp([running, broken]), broken);
  // 孙任务正跑着回合、又挂着哨兵：子任务、父任务都该带上「运行中」，不是「等哨兵」。
  const busy = child({ status: "running", monitorRunning: true }, "跑着还挂哨兵的");
  const parked = child({ status: "paused", monitorRunning: true }, "停着等哨兵的");
  assert.equal(busy.word, "运行中");
  assert.equal(dispatchedRollUp([parked, busy]), busy, "名下有在跑的压过等哨兵的");

  // 圆点只说它自己，行尾那一句只说名下：在动的一律「子项运行中」，轮到你的、出事的才说具体。
  const below = (over, dispatched) => taskLook({ ...task("p", at), ...over }, [], false, dispatched).below;
  assert.deepEqual(Object.values(below({}, running)), ["子项运行中", null, "子任务「跑着的」运行中"]);
  assert.deepEqual(Object.values(below({}, parked)), ["子项运行中", null, "子任务「停着等哨兵的」等哨兵"], "等哨兵也是子项运行中，指上去才说具体");
  assert.equal(below({}, child({ status: "queued" }, "排着的")).word, "子项运行中");
  assert.equal(below({}, child({ acceptGateRunning: true }, "跑门禁的")).word, "子项运行中");
  assert.deepEqual([below({}, asking).word, below({}, asking).tone], ["子项等答复", "ask"]);
  assert.equal(below({}, child({ disputeOpen: true }, "等裁定的")).word, "子项等裁定");
  assert.deepEqual([below({}, broken).word, below({}, broken).tone], ["子项失败", "bad"]);
  assert.equal(below({}, null), null);
  const parent = taskLook({ ...task("p", at), status: "running" }, [], false, asking);
  assert.deepEqual([parent.mark, parent.phrase.word, parent.below.word], ["run", "运行中", "子项等答复"], "父任务的圆点说它自己，名下的事不改它的圆点");
  assert.equal(taskLook({ ...task("p", at), stage: "accepted" }, [], false, running).mark, null, "验收过的父任务名下在跑：圆点照旧空着");
}

const lead = { ...task("lead", "2026-08-20T01:00:00.000Z"), mode: "team", status: "idle" };
const worker = (over) => ({ ...task("w", "2026-08-20T01:00:00.000Z"), parentId: "lead", ...over });
assert.equal(deriveTaskStatusIndicator(lead, [worker({ question: "问你" })]), "attention");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "paused" })]), "attention");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "paused", monitorRunning: true })]), "working");
assert.equal(deriveTaskStatusIndicator({ ...lead, status: "paused" }, []), "attention");
assert.equal(deriveTaskStatusIndicator({ ...lead, status: "paused", monitorRunning: true }, []), "working");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "paused", monitorRunning: true, question: "问你" })]), "attention");
assert.equal(deriveTaskStatusIndicator({ ...lead, acceptGateRunning: true }, []), "working");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "running", monitorRunning: true })]), "active");
assert.equal(
  deriveTaskStatusIndicator(lead, [worker({ status: "paused", monitorRunning: true }), worker({ status: "running" })]),
  "active",
  "一个在等哨兵、一个在跑：先说有人在动，跟名下往上带同一个次序",
);
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "queued" })]), "queued");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "done" }), worker({ status: "failed" })]), "error", "执行者摔了、收了工没盖章：一直红");
assert.equal(deriveTaskStatusIndicator({ ...lead, stage: "accepted" }, [worker({ status: "failed" })]), null, "盖过章就不再红");
assert.equal(deriveTaskStatusIndicator({ ...lead, status: "failed" }, []), "error", "调度台自己摔了");

// 「它在干等上游」那颗红环:停滞是**派生事实**(标记 + 会话未收尾 + 任务在跑,三条都在
// server/src/task-store.ts 的投影里),而后台水位只盯那个标记列 —— 乱序到达的旧响应能把
// 「旧的 true」和「新的状态」拼在一起(第 3 轮审查 N1)。所以这一侧跟服务端同口径再问一次。
assert.equal(dot({ status: "running", upstreamStalled: true }), "stalled", "正在跑却卡在上游:红环");
assert.equal(
  dot({ status: "running", upstreamStalled: true, monitorRunning: true }),
  "stalled",
  "停滞排在「有东西在跑」之前:它其实没在动,而这一档才需要你做点什么",
);
assert.notEqual(
  dot({ status: "done", upstreamStalled: true }),
  "stalled",
  "任务已经不在跑了,还亮着上一轮的停滞红环 —— 陈旧的 true 不许自己说话",
);
assert.equal(
  deriveTaskStatusIndicator(lead, [worker({ status: "running", upstreamStalled: true })]),
  "stalled",
  "执行者卡在上游,团队卡片上要看得出来",
);
assert.notEqual(
  deriveTaskStatusIndicator(lead, [worker({ status: "failed", upstreamStalled: true })]),
  "stalled",
  "执行者早就收尾了,团队卡片还亮着它的停滞环",
);

console.log("test-task-read-state: all assertions passed");
