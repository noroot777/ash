import assert from "node:assert/strict";
import { readEventForTask, reconcileReadState } from "../src/lib/useTaskReadState.ts";

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

console.log("test-task-read-state: all assertions passed");
