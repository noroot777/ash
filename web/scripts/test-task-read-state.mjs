import assert from "node:assert/strict";
import { deriveTaskStatusIndicator, readEventForTask, reconcileReadState } from "../src/lib/useTaskReadState.ts";

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

const dot = (over) => deriveTaskStatusIndicator({ ...task("dot", "2026-08-20T01:00:00.000Z"), ...over });

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
const lead = { ...task("lead", "2026-08-20T01:00:00.000Z"), mode: "team", status: "idle" };
const worker = (over) => ({ ...task("w", "2026-08-20T01:00:00.000Z"), parentId: "lead", ...over });
assert.equal(deriveTaskStatusIndicator(lead, [worker({ question: "问你" })]), "attention");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "paused" })]), "attention");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "paused", monitorRunning: true })]), "working");
assert.equal(deriveTaskStatusIndicator({ ...lead, status: "paused" }, []), "attention");
assert.equal(deriveTaskStatusIndicator({ ...lead, status: "paused", monitorRunning: true }, []), "working");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "paused", monitorRunning: true, question: "问你" })]), "attention");
assert.equal(deriveTaskStatusIndicator({ ...lead, acceptGateRunning: true }, []), "working");

console.log("test-task-read-state: all assertions passed");
