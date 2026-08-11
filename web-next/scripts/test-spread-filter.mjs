import assert from "node:assert/strict";
import {
  SPREAD_BUCKET_FILTERS,
  SPREAD_FILTERS,
  spreadBucket,
  spreadCounts,
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
    parentId: null,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

// 窄态那排点必须画满每一档：少一档就等于那档的任务从筛选里消失了，而且没人会发现。
assert.deepEqual(
  SPREAD_BUCKET_FILTERS.map((item) => item.key),
  SPREAD_FILTERS.filter((item) => item.key !== "all").map((item) => item.key),
);
assert.ok(!SPREAD_BUCKET_FILTERS.some((item) => item.key === "all"));

const tasks = [
  task("todo-question", { status: "running", question: "选哪个？" }),
  task("todo-failed", { status: "failed" }),
  task("todo-await", { status: "done", stage: "awaiting_acceptance" }),
  task("run-running", { status: "running" }),
  task("run-accepted-review", { status: "awaiting_review", stage: "accepted" }),
  task("wait-backlog", { status: "backlog" }),
  task("done-done", { status: "done" }),
  task("accepted-merged", { status: "done", stage: "merged" }),
  // 下面三条都不该进计数：执行者不是顶层行、归档的不在树里、别的项目也不在。
  task("worker", { status: "running", parentId: "run-running" }),
  task("archived", { status: "done", archived: true }),
  task("other-project", { status: "running", projectId: "p2" }),
];

const counts = spreadCounts(tasks, "p1");
assert.equal(counts.all, 8);
assert.equal(counts.todo, 3);
assert.equal(counts.run, 2);
assert.equal(counts.wait, 1);
assert.equal(counts.done, 1);
assert.equal(counts.accepted, 1);

// 五个桶互斥且铺满：加起来必须正好是「全部」，否则筛选条上的数字自己就打架了。
assert.equal(
  SPREAD_BUCKET_FILTERS.reduce((sum, item) => sum + counts[item.key], 0),
  counts.all,
);

// 计数和列表是两处代码：这里钉住它们同一个口径 —— 按钮上写 3 条，点开只剩 1 条是最难查的那种 bug。
const rows = orderedTopLevelTasks(
  tasks.filter((row) => row.projectId === "p1" && !row.archived),
  { unifiedPinned: true },
);
assert.equal(rows.length, counts.all);
for (const item of SPREAD_BUCKET_FILTERS) {
  assert.equal(rows.filter((row) => spreadBucket(row) === item.key).length, counts[item.key], item.key);
}

// 空项目：每一档都是 0，点还是画五颗（画不出来就没地方取消筛选了）。
const empty = spreadCounts(tasks, "p3");
assert.equal(empty.all, 0);
assert.equal(SPREAD_BUCKET_FILTERS.reduce((sum, item) => sum + empty[item.key], 0), 0);

console.log("spread filter counting tests passed");
