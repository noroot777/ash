import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outboundTasksForTarget, partitionBulkHandoffTasks } from "../src/workspace/bulkHandoff.ts";
import { handoffTargetsForTask } from "../src/task-detail/handoffTargetPolicy.ts";

const task = (id, overrides = {}) => ({
  id,
  projectId: "p1",
  parentId: null,
  archived: false,
  mode: "single",
  queueId: null,
  verifyRound: null,
  handoff: null,
  title: id,
  ...overrides,
});

const sourceFp = "a".repeat(64);
const thirdFp = "b".repeat(64);

const outbound = outboundTasksForTarget([
  task("older", { updatedAt: "2026-08-20T08:00:00.000Z", handoff: { direction: "out", peerUrl: "http://old-target:4317", peerFp: sourceFp, at: "2026-08-20T08:00:00.000Z" } }),
  task("newer", { updatedAt: "2026-08-20T09:00:00.000Z", handoff: { direction: "out", peerUrl: "http://target:4317/", peerFp: sourceFp, at: "2026-08-20T09:00:00.000Z" } }),
  task("pending", { handoff: { direction: "out", pending: true, peerUrl: "http://target:4317" } }),
  task("other-target", { handoff: { direction: "out", peerUrl: "http://elsewhere:4317" } }),
  task("reused-address", { handoff: { direction: "out", peerUrl: "http://target:4317", peerFp: thirdFp } }),
  task("inbound", { handoff: { direction: "in", peerUrl: "http://target:4317" } }),
  task("other-project", { projectId: "p2", handoff: { direction: "out", peerUrl: "http://target:4317" } }),
], "p1", "http://target:4317/", sourceFp);
assert.deepEqual(outbound.map((item) => item.id), ["newer", "older"]);

const result = partitionBulkHandoffTasks([
  task("ready"),
  task("other-project", { projectId: "p2" }),
  task("child", { parentId: "team" }),
  task("team", { mode: "team" }),
  task("queued", { queueId: "q1" }),
  task("verifying", { verifyRound: 2 }),
  task("pending", { handoff: { direction: "out", pending: true } }),
  task("moved", { handoff: { direction: "out" } }),
  task("inbound", { handoff: { direction: "in", peerFp: sourceFp } }),
  task("archived", { archived: true }),
], "p1", thirdFp);

assert.deepEqual(result.eligible.map((item) => item.id), ["ready"]);
assert.deepEqual(result.skipped.map((item) => item.task.id), ["team", "queued", "verifying", "pending", "inbound"]);
assert.match(result.skipped.find((item) => item.task.id === "pending").reason, /单独收口/);
assert.match(result.skipped.find((item) => item.task.id === "inbound").reason, /只能移回来源机器/);

const statusResult = partitionBulkHandoffTasks([
  task("running", { status: "running" }),
  task("paused", { status: "paused" }),
  task("done", { status: "done" }),
], "p1");
assert.deepEqual(statusResult.eligible.map((item) => item.id), ["running", "paused", "done"]);

const allSkipped = partitionBulkHandoffTasks([
  task("team-only", { mode: "team" }),
  task("inbound-only", { handoff: { direction: "in", peerFp: sourceFp } }),
  task("legacy-inbound", { handoff: { direction: "in" } }),
], "p1", thirdFp);
assert.equal(allSkipped.eligible.length, 0);
assert.equal(allSkipped.skipped.length, 3);

const bulkReturn = partitionBulkHandoffTasks([
  task("local"),
  task("return-home", { handoff: { direction: "in", peerFp: sourceFp } }),
], "p1", sourceFp);
assert.deepEqual(bulkReturn.eligible.map((item) => item.id), ["local", "return-home"]);

const returnedHome = partitionBulkHandoffTasks([
  task("returned-home", { handoff: { direction: "returned", peerFp: thirdFp } }),
], "p1", sourceFp);
assert.deepEqual(returnedHome.eligible.map((item) => item.id), ["returned-home"]);

const targets = [
  { name: "source", url: "http://source", peerFp: sourceFp },
  { name: "third", url: "http://third", peerFp: thirdFp },
];
assert.deepEqual(handoffTargetsForTask(targets, null), targets);
assert.deepEqual(
  handoffTargetsForTask(targets, { direction: "in", peerFp: sourceFp }).map((target) => target.name),
  ["source"],
);
assert.deepEqual(handoffTargetsForTask(targets, { direction: "in" }), []);
assert.deepEqual(handoffTargetsForTask(targets, { direction: "returned", peerFp: thirdFp }), targets);
assert.deepEqual(
  handoffTargetsForTask([], { direction: "in", peerFp: sourceFp }, { name: "自动来源", url: "http://source", peerFp: sourceFp }),
  [{ name: "自动来源", url: "http://source", peerFp: sourceFp }],
  "移回目标可由任务历史自动恢复，不要求先写入整机目标设置",
);

const bulkDialog = readFileSync(new URL("../src/workspace/HandoffMachines.tsx", import.meta.url), "utf8");
assert.doesNotMatch(bulkDialog, /<ConfirmDialog/, "批量接力不应继续使用旧确认框");
assert.match(bulkDialog, /<HandoffDialogHeader/, "批量接力应复用接力弹窗标题结构");
assert.match(bulkDialog, /<HandoffRouteCard/, "批量接力应展示与单任务一致的机器路线");
assert.match(bulkDialog, /handoff-result-panel handoff-bulk-result/, "批量接力结果页应使用同一套完成态视觉");

console.log("bulk handoff eligibility tests passed");
