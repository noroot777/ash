import assert from "node:assert/strict";
import "./test-task-background-sync.mjs";
import { applyTaskMetadataEvent, applyTaskStatusEvent, confirmedDeletions, mergeFetchedTasks } from "../src/lib/useTasks.ts";

// useTasks 数据同步纯函数的回归：SSE 事件应用、GET 快照合并。
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

// ── 权威快照确认删除(confirmedDeletions,第 8 轮审查)──
// fetch 发起时本地已有、响应里没有 → 确认删除;发起时还没有(创建在请求之后,
// SSE 在途中送达)→ 旧快照缺席是正常时序,不构成删除证据;响应里有 → 不是删除。
assert.deepEqual(
  confirmedDeletions(new Set(["t-kept", "t-deleted"]), [{ id: "t-kept" }]),
  ["t-deleted"],
  "发起时已存在、快照缺席的行确认删除",
);
assert.deepEqual(
  confirmedDeletions(new Set(["t-kept"]), [{ id: "t-kept" }]),
  [],
  "创建晚于 fetch 发起的新任务不被旧快照误判为删除",
);
assert.deepEqual(confirmedDeletions(new Set(), [{ id: "t-kept" }]), [], "发起时列表为空则无删除可确认");

console.log("test-task-sync: all assertions passed");
