import assert from "node:assert/strict";
import {
  advanceReadWatermarks,
  taskActivity,
  teamActivity,
  unreadTaskIds,
} from "../src/unreadTaskState.ts";

const task = (id, updatedAt, parentId = null, mode = parentId ? "single" : "team") => ({
  id,
  updatedAt,
  parentId,
  mode,
});

const initial = [
  task("team", "2026-08-01T00:00:00.000Z"),
  task("worker-a", "2026-08-01T00:00:01.000Z", "team"),
  task("worker-b", "2026-08-01T00:00:02.000Z", "team"),
];

const baseline = advanceReadWatermarks({}, taskActivity(initial));
assert.deepEqual([...unreadTaskIds(taskActivity(initial), baseline)], [], "首次看到的存量任务不应全亮未读");

const changed = [
  initial[0],
  task("worker-a", "2026-08-01T00:00:03.000Z", "team"),
  task("worker-b", "2026-08-01T00:00:04.000Z", "team"),
];
const changedActivity = taskActivity(changed);
assert.deepEqual(
  [...unreadTaskIds(changedActivity, baseline)].sort(),
  ["worker-a", "worker-b"],
  "两个执行者的新动态应分别记未读",
);

const workerARead = advanceReadWatermarks(baseline, changedActivity, ["worker-a"]);
assert.deepEqual([...unreadTaskIds(changedActivity, workerARead)], ["worker-b"], "点过的执行者应单独消除未读");

const allRead = advanceReadWatermarks(workerARead, changedActivity, ["worker-b"]);
assert.deepEqual([...unreadTaskIds(changedActivity, allRead)], [], "全部点过后执行者未读应消失");

const refreshed = taskActivity(changed);
assert.deepEqual([...unreadTaskIds(refreshed, allRead)], [], "刷新后相同 updatedAt 不得让绿点复活");

const teamBaseline = advanceReadWatermarks({}, teamActivity(initial));
assert.deepEqual([...unreadTaskIds(teamActivity(changed), teamBaseline)], ["team"], "任一成员更新应点亮团队聚合提醒");
const teamRead = advanceReadWatermarks(teamBaseline, teamActivity(changed), ["team"]);
assert.deepEqual([...unreadTaskIds(teamActivity(changed), teamRead)], [], "点开团队应清掉左侧聚合提醒");
assert.deepEqual([...unreadTaskIds(teamActivity(changed), teamRead)], [], "团队聚合水位刷新后不得复活");

console.log("unread task watermark tests passed");
