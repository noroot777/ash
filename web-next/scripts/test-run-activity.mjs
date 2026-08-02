import assert from "node:assert/strict";
import { runActivityCopy, runActivityPhase } from "@harness/shared/run-activity";

assert.equal(runActivityPhase("running", "empty"), "starting");
assert.equal(runActivityPhase("running", "user"), "replying");
assert.equal(runActivityPhase("running", "agent-ended"), "continuing");
assert.equal(runActivityPhase("running", "agent-active"), null);
assert.equal(runActivityPhase("backlog", "user"), null);

assert.deepEqual(runActivityCopy({ status: "running", mode: "single", phase: "replying", executor: "codex@local" }), {
  title: "codex@local 已收到你的消息",
  detail: "正在恢复原会话并读取你的补充，下一条回复会自动出现在这里。",
});
assert.match(runActivityCopy({ status: "running", mode: "team", phase: "replying" }).detail, /调整方向/);
assert.match(runActivityCopy({ status: "running", mode: "debate", phase: "replying" }).title, /收到你的补充/);
assert.equal(runActivityCopy({ status: "done", mode: "single", phase: "continuing" }), null);

console.log("run activity state tests passed");
