import assert from "node:assert/strict";
import { applyStarredAt, applyTaskMetadataEvent, applyTaskStatusEvent, mergeFetchedTasks } from "../src/lib/useTasks.ts";

// useTasks 数据同步纯函数的回归：SSE 事件应用、星标回写、GET 快照合并。
// 共同主题是「三条通道（SSE / PATCH 响应 / GET 快照）没有到达顺序保证，
// 旧数据不许覆盖新状态」。

const task = {
  id: "task-1",
  status: "done",
  startedAt: "2026-07-30T01:00:00.000Z",
  endedAt: "2026-07-30T01:10:00.000Z",
  activeMs: 600000,
  liveSince: "2026-07-30T01:00:00.000Z",
  updatedAt: "2026-07-30T01:10:00.000Z",
  starredAt: null,
};

// ── SSE 事件应用 ─────────────────────────────────────────────

const updated = applyTaskStatusEvent(task, {
  type: "task.status",
  taskId: "task-1",
  status: "running",
  updatedAt: "2026-07-30T01:11:00.000Z",
  endedAt: null,
  liveSince: null,
});
assert.equal(updated.startedAt, task.startedAt);
assert.equal(updated.activeMs, task.activeMs);
assert.equal(updated.endedAt, null);
assert.equal(updated.liveSince, null);
assert.equal(updated.updatedAt, "2026-07-30T01:11:00.000Z");
assert.equal(applyTaskMetadataEvent(task, {
  type: "task.stage",
  taskId: task.id,
  stage: "awaiting_acceptance",
  updatedAt: "2026-07-30T01:12:00.000Z",
}).updatedAt, "2026-07-30T01:12:00.000Z");
assert.equal(applyTaskMetadataEvent(task, {
  type: "task.title",
  taskId: task.id,
  title: "新标题",
  updatedAt: "2026-07-30T01:13:00.000Z",
}).updatedAt, "2026-07-30T01:13:00.000Z");
assert.equal(applyTaskMetadataEvent(task, {
  type: "task.question",
  taskId: task.id,
  question: "需要确认吗？",
  questionOptions: ["确认"],
  questionItems: null,
  updatedAt: "2026-07-30T01:14:00.000Z",
}).updatedAt, "2026-07-30T01:14:00.000Z");

// ── 星标回写 ─────────────────────────────────────────────────
// applyStarredAt 只合并 starredAt —— 任务在星标请求 in-flight 期间完成/改名，迟到的
// PATCH 响应不能把它回滚；任务已删除时不复活。

const doneMeanwhile = { ...task, status: "done", title: "跑完了", starredAt: null };
const starMerged = applyStarredAt([doneMeanwhile], "task-1", 1754900000000);
assert.equal(starMerged[0].starredAt, 1754900000000);
assert.equal(starMerged[0].status, "done", "stale star response must not roll back status");
assert.equal(starMerged[0].title, "跑完了");
assert.deepEqual(applyStarredAt([], "task-1", 1754900000000), [], "must not revive a deleted task");

// ── GET 快照合并 ─────────────────────────────────────────────
// mergeFetchedTasks 按行比 updatedAt：本地行更新（SSE 已推进）就保留本地行，
// 其余以快照为准；快照里没有的行按删除处理。

const localNewer = { ...task, id: "t-new", status: "done", updatedAt: "2026-07-30T02:00:00.000Z" };
const fetchedOlder = { ...task, id: "t-new", status: "running", updatedAt: "2026-07-30T01:00:00.000Z" };
const fetchedNewer = { ...task, id: "t-fresh", title: "快照更新", updatedAt: "2026-07-30T03:00:00.000Z" };
const localStale = { ...task, id: "t-fresh", title: "本地陈旧", updatedAt: "2026-07-30T01:00:00.000Z" };
const localDeleted = { ...task, id: "t-gone" };
const merged = mergeFetchedTasks([localNewer, localStale, localDeleted], [fetchedOlder, fetchedNewer]);
assert.deepEqual(merged.map((row) => row.id), ["t-new", "t-fresh"]);
assert.equal(merged[0].status, "done", "stale GET row must not overwrite newer local row");
assert.equal(merged[1].title, "快照更新");

// 星标 PATCH 特意不推进 updatedAt（不污染最后活动时间），所以「点星前生成、点星后到达」
// 的旧快照和本地行 updatedAt 完全相同 —— 光比时间分不出新旧。protectStars 里的行
// （发起晚于本地星标写入的快照不需要保护，调用方只报竞态窗口内的行）starredAt 以本地为准。
const starredLocal = { ...task, id: "t-star", starredAt: 1754900000000 };
const staleSnapshotRow = { ...task, id: "t-star", starredAt: null };
const protectedMerge = mergeFetchedTasks([starredLocal], [staleSnapshotRow], new Set(["t-star"]));
assert.equal(
  protectedMerge[0].starredAt, 1754900000000,
  "same-updatedAt stale GET must not clear a protected local star",
);

// 取消星标同样受保护：旧快照带着星标回来，不能把刚取消的又点亮。
const unstarredLocal = { ...task, id: "t-star", starredAt: null };
const staleStarredRow = { ...task, id: "t-star", starredAt: 1754900000000 };
assert.equal(
  mergeFetchedTasks([unstarredLocal], [staleStarredRow], new Set(["t-star"]))[0].starredAt, null,
  "same-updatedAt stale GET must not re-star a protected local unstar",
);

// 保护是字段级的：快照行确实更新（任务有了别的活动）时行本体取快照，只有 starredAt 留本地。
const activeSnapshotRow = { ...task, id: "t-star", status: "running", starredAt: null, updatedAt: "2026-07-30T02:00:00.000Z" };
const fieldLevel = mergeFetchedTasks([starredLocal], [activeSnapshotRow], new Set(["t-star"]))[0];
assert.equal(fieldLevel.status, "running", "protected row must still take newer snapshot fields");
assert.equal(fieldLevel.starredAt, 1754900000000, "protection only pins starredAt");

// 无保护时同 updatedAt 采纳快照：断线期间别的客户端点的星要靠追平快照同步过来。
assert.equal(
  mergeFetchedTasks([{ ...task, id: "t-star", starredAt: null }], [staleStarredRow])[0].starredAt,
  1754900000000,
  "unprotected same-updatedAt merge must adopt snapshot star (cross-client catch-up)",
);

// 保护不复活快照里已删除的行，也不虚构本地没有的行。
assert.deepEqual(
  mergeFetchedTasks([starredLocal], [], new Set(["t-star"])), [],
  "protection must not revive a deleted task",
);
assert.equal(
  mergeFetchedTasks([], [staleSnapshotRow], new Set(["t-star"]))[0].starredAt, null,
  "protection without a local row keeps the snapshot value",
);

console.log("test-task-sync: all assertions passed");
