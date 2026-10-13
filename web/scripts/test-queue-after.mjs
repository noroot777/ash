import assert from "node:assert/strict";
import { canJoinQueue, queueAfterOptions } from "../src/lib/queueAfter.ts";

// 「排在某任务之后」候选与主体资格的回归(用户 2026-10-10 反馈):
// - running 的独立任务可以作为主体入队(高频编排:正在跑 A,让 B 接着跑);
// - 候选列表可选的排上面、置灰的沉底;
// - 主体 running 时,已有成员在跑的队列置灰(同队至多一个在跑的编排语义)。

const t = (id, overrides = {}) => ({
  id, title: id, projectId: "p1", parentId: null, archived: false, mode: "single",
  groupId: null, queueId: null, queuePosition: null, status: "backlog", ...overrides,
});

// ── canJoinQueue:backlog / paused / running 放行,queued 与终态不放 ──
assert.equal(canJoinQueue(t("a")), true);
assert.equal(canJoinQueue(t("a", { status: "paused" })), true);
assert.equal(canJoinQueue(t("a", { status: "running" })), true, "正在跑的独立任务必须能入队");
assert.equal(canJoinQueue(t("a", { status: "queued" })), false, "queued 是队列调度的瞬态");
assert.equal(canJoinQueue(t("a", { status: "done" })), false);
assert.equal(canJoinQueue(t("a", { status: "running", queueId: "q1" })), false, "已在队列的不重复入队");
assert.equal(canJoinQueue(t("a", { status: "running", mode: "team" })), false);

// ── 排序:可选在上、置灰沉底(各自保持原相对顺序)──
const tasks = [
  t("t-done", { status: "done" }),
  t("t-team", { mode: "team" }),
  t("t-run", { status: "running" }),
  t("t-back"),
  t("t-queued", { queueId: "q1", queuePosition: 0, status: "done" }),
];
const options = queueAfterOptions({ tasks, groups: [], projectId: "p1" });
assert.deepEqual(options.map((o) => o.value), ["t-run", "t-back", "t-queued", "t-done", "t-team"],
  "可选候选必须排在置灰候选前面,组内保持原序");
assert.deepEqual(options.filter((o) => o.disabled).map((o) => o.value), ["t-done", "t-team"]);

// ── 主体 running:目标所在队列已有成员在跑 → 置灰;安静队列照常可选 ──
const withRunningQueue = [
  t("t-busy", { queueId: "q2", queuePosition: 0, status: "running" }),
  t("t-busy-tail", { queueId: "q2", queuePosition: 1 }),
  t("t-quiet", { queueId: "q3", queuePosition: 0, status: "done" }),
  t("t-free"),
  t("t-free-run", { status: "running" }),
  t("t-ended", { status: "failed" }),
];
const runningSubject = queueAfterOptions({
  tasks: withRunningQueue, groups: [], projectId: "p1", excludeId: "me", subjectGroupId: null, subjectRunning: true,
});
const byValue = new Map(runningSubject.map((o) => [o.value, o]));
assert.equal(byValue.get("t-busy").disabled, true, "有人在跑的队列对 running 主体置灰");
assert.equal(byValue.get("t-busy-tail").disabled, true);
assert.match(byValue.get("t-busy").detail, /已有任务在跑/);
assert.equal(byValue.get("t-quiet").disabled, undefined, "安静队列照常可选");
assert.equal(byValue.get("t-free").disabled, undefined);
assert.equal(byValue.get("t-free-run").disabled, true, "独立但也在跑的目标必须置灰(两个在跑的不能捆成一队)");
assert.match(byValue.get("t-free-run").detail, /它也在运行/);
assert.match(byValue.get("t-ended").detail, /无需排队等它/, "running 主体下终态候选的置灰理由不再是「排后面会立刻跑」");

// 主体不是 running 时,同样的在跑队列照常可选(排后面等它跑完,经典用法)。
const idleSubject = queueAfterOptions({
  tasks: withRunningQueue, groups: [], projectId: "p1", excludeId: "me", subjectGroupId: null,
});
const idleByValue = new Map(idleSubject.map((o) => [o.value, o]));
assert.equal(idleByValue.get("t-busy").disabled, undefined,
  "backlog 主体排进在跑队列是经典等待语义,不得置灰");
assert.equal(idleByValue.get("t-free-run").disabled, undefined,
  "backlog 主体接在独立 running 任务之后同样是经典等待语义");

console.log("queue-after: all assertions passed");
