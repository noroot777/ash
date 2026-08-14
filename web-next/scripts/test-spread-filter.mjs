import assert from "node:assert/strict";
import {
  SPREAD_DOT_FILTERS,
  SPREAD_FILTERS,
  matchesSpreadFilter,
  spreadBucket,
  spreadCounts,
  spreadVisibleTasks,
} from "../src/workspace/useSidebarSpread.ts";
import { orderedTopLevelTasks } from "../src/workspace/taskTreeModel.ts";

function task(id, extra = {}) {
  return {
    id,
    projectId: "p1",
    mode: "single",
    status: "backlog",
    stage: null,
    question: null,
    pinnedAt: null,
    starredAt: null,
    parentId: null,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

// 窄态那排点必须画满每一档：少一档就等于那档的任务从筛选里消失了，而且没人会发现。
assert.deepEqual(
  SPREAD_DOT_FILTERS.map((item) => item.key),
  SPREAD_FILTERS.filter((item) => item.key !== "all").map((item) => item.key),
);
assert.ok(!SPREAD_DOT_FILTERS.some((item) => item.key === "all"));

// 星标是手动记号，与状态桶正交：点位列表里有它，但它不是 spreadBucket 的产出。
const BUCKET_FILTERS = SPREAD_DOT_FILTERS.filter((item) => item.key !== "starred");

const tasks = [
  task("todo-question", { status: "running", question: "选哪个？", starredAt: 1754900000000 }),
  task("todo-failed", { status: "failed" }),
  task("todo-await", { status: "done", stage: "awaiting_acceptance" }),
  task("run-running", { status: "running" }),
  task("run-accepted-review", { status: "awaiting_review", stage: "accepted" }),
  task("wait-backlog", { status: "backlog", starredAt: 1754900001000 }),
  task("done-done", { status: "done" }),
  task("accepted-merged", { status: "done", stage: "merged" }),
  // 下面三条都不该进计数：执行者不是顶层行、归档的不在树里、别的项目也不在。
  // 执行者/归档行就算带着星也不算——它们根本不在树里。
  task("worker", { status: "running", parentId: "run-running", starredAt: 1754900002000 }),
  task("archived", { status: "done", archived: true, starredAt: 1754900003000 }),
  task("other-project", { status: "running", projectId: "p2" }),
];

const counts = spreadCounts(tasks, "p1");
assert.equal(counts.all, 8);
assert.equal(counts.starred, 2);
assert.equal(counts.todo, 3);
assert.equal(counts.run, 2);
assert.equal(counts.wait, 1);
assert.equal(counts.done, 1);
assert.equal(counts.accepted, 1);

// 五个桶互斥且铺满：加起来必须正好是「全部」，否则筛选条上的数字自己就打架了。
// 星标不进这笔账 —— 它跟桶正交，进来就会重复计。
assert.equal(
  BUCKET_FILTERS.reduce((sum, item) => sum + counts[item.key], 0),
  counts.all,
);

// 计数和列表是两处代码：这里钉住它们同一个口径 —— 按钮上写 3 条，点开只剩 1 条是最难查的那种 bug。
const rows = orderedTopLevelTasks(
  tasks.filter((row) => row.projectId === "p1" && !row.archived),
  { unifiedPinned: true },
);
assert.equal(rows.length, counts.all);
for (const item of SPREAD_DOT_FILTERS) {
  assert.equal(rows.filter((row) => matchesSpreadFilter(row, item.key)).length, counts[item.key], item.key);
}

// matchesSpreadFilter 与 spreadBucket 对桶档同口径；星标档只认 starredAt。
for (const row of rows) {
  for (const item of BUCKET_FILTERS) {
    assert.equal(matchesSpreadFilter(row, item.key), spreadBucket(row) === item.key, `${row.id}:${item.key}`);
  }
  assert.equal(matchesSpreadFilter(row, "starred"), row.starredAt != null, `${row.id}:starred`);
  assert.equal(matchesSpreadFilter(row, "all"), true);
}

// J/K 快捷键遍历的可见列表（spreadVisibleTasks）必须与树同口径。它曾在调用点自己拼
// `spreadBucket === filter`：starred 不是桶，星标筛选下快捷键拿到空数组、按键被吞。
for (const item of SPREAD_FILTERS) {
  assert.deepEqual(
    spreadVisibleTasks(tasks, "p1", item.key).map((row) => row.id),
    rows.filter((row) => matchesSpreadFilter(row, item.key)).map((row) => row.id),
    `visible:${item.key}`,
  );
}
assert.equal(spreadVisibleTasks(tasks, "p1", "starred").length, counts.starred);

// 空项目：每一档都是 0，点还是画满一排（画不出来就没地方取消筛选了）。
const empty = spreadCounts(tasks, "p3");
assert.equal(empty.all, 0);
assert.equal(SPREAD_DOT_FILTERS.reduce((sum, item) => sum + empty[item.key], 0), 0);

console.log("spread filter counting tests passed");
