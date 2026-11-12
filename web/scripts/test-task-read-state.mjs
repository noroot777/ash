import assert from "node:assert/strict";
import { deriveTaskStatusIndicator, readEventForTask, reconcileReadState } from "../src/lib/useTaskReadState.ts";
import { taskLook } from "../src/lib/taskLook.ts";

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
  assert.equal(parked.mark, "breathe", "等哨兵：会呼吸的琥珀点");
  assert.equal(parked.word, null, "等哨兵行尾不写字");
  const failed = taskLook({ ...task("failed", "2026-08-20T01:00:00.000Z"), status: "failed" });
  assert.deepEqual([failed.mark, failed.bucket], ["bad", "todo"]);
  const running = taskLook({ ...task("run", "2026-08-20T01:00:00.000Z"), status: "running" });
  assert.deepEqual([running.mark, running.bucket], ["run", "run"]);
  const quiet = taskLook({ ...task("quiet", "2026-08-20T01:00:00.000Z"), stage: "accepted" });
  assert.deepEqual([quiet.mark, quiet.say, quiet.bucket], [null, "", "accepted"]);
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
