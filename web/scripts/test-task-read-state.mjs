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

// ── 行首那颗点：黄色分两种（用户 2026-10-23）────────────────────────────────
// 静止黄（attention）= 等**你**说话；呼吸黄（working）= 等一件**会自己回来**的事。
// 两者挨着写在一起，免得以后有人顺手把 paused 并回 attention（那就又看不出哪些
// 任务其实有东西在后台跑着了）。
const dot = (over) => deriveTaskStatusIndicator({ ...task("dot", "2026-08-20T01:00:00.000Z"), ...over });

assert.equal(dot({ question: "选哪条？" }), "attention", "有待答问题 = 等你说话");
assert.equal(dot({ status: "paused" }), "working", "停在检查点（多半挂着哨兵）= 等一件会自己回来的事");
assert.equal(
  dot({ status: "paused", question: "选哪条？" }),
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
// 团队：问题落在执行者身上也算等你说话；执行者停在检查点则是等它自己回来。
const lead = { ...task("lead", "2026-08-20T01:00:00.000Z"), mode: "team", status: "idle" };
const worker = (over) => ({ ...task("w", "2026-08-20T01:00:00.000Z"), parentId: "lead", ...over });
assert.equal(deriveTaskStatusIndicator(lead, [worker({ question: "问你" })]), "attention");
assert.equal(deriveTaskStatusIndicator(lead, [worker({ status: "paused" })]), "working");
assert.equal(deriveTaskStatusIndicator({ ...lead, acceptGateRunning: true }, []), "working");

console.log("test-task-read-state: all assertions passed");
