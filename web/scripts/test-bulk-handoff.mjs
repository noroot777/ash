import assert from "node:assert/strict";
import { partitionBulkHandoffTasks } from "../src/workspace/bulkHandoff.ts";

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

const result = partitionBulkHandoffTasks([
  task("ready"),
  task("other-project", { projectId: "p2" }),
  task("child", { parentId: "team" }),
  task("team", { mode: "team" }),
  task("queued", { queueId: "q1" }),
  task("verifying", { verifyRound: 2 }),
  task("pending", { handoff: { direction: "out", pending: true } }),
  task("moved", { handoff: { direction: "out" } }),
  task("inbound", { handoff: { direction: "in" } }),
  task("archived", { archived: true }),
], "p1");

assert.deepEqual(result.eligible.map((item) => item.id), ["ready"]);
assert.deepEqual(result.skipped.map((item) => item.task.id), ["team", "queued", "verifying", "pending", "moved", "inbound"]);
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
  task("inbound-only", { handoff: { direction: "in" } }),
], "p1");
assert.equal(allSkipped.eligible.length, 0);
assert.equal(allSkipped.skipped.length, 2);

console.log("bulk handoff eligibility tests passed");
