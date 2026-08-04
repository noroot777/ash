import assert from "node:assert/strict";
import { runActivityCopy, runActivityPhase } from "@harness/shared/run-activity";
import { latestActiveDebateTurn, rebuildDebateState } from "../src/debate/debateState.ts";

assert.equal(runActivityPhase("running", "empty"), "starting");
assert.equal(runActivityPhase("running", "user"), "replying");
assert.equal(runActivityPhase("running", "agent-ended"), "continuing");
assert.equal(runActivityPhase("running", "agent-active"), null);
assert.equal(runActivityPhase("backlog", "user"), null);

assert.deepEqual(runActivityCopy({ status: "running", mode: "single", executor: "codex@local" }), {
  title: "codex@local 正在启动",
  detail: "正在准备运行环境、读取任务并连接执行器。首条输出会自动出现在这里，无需重复点击。",
});
assert.match(runActivityCopy({ status: "running", mode: "team" }).title, /正在启动调度台/);
assert.match(runActivityCopy({ status: "running", mode: "debate" }).detail, /第一位辩手开始发言后/);
assert.deepEqual(runActivityCopy({ status: "queued", mode: "single", queuePosition: 1 }), {
  title: "已进入队列 · 第 2 位",
  detail: "前面的任务结束后会自动启动，无需重复点击。",
});
assert.deepEqual(runActivityCopy({ status: "running", mode: "single", phase: "replying", executor: "codex@local" }), {
  title: "codex@local 已收到你的消息",
  detail: "正在恢复原会话并读取你的补充，下一条回复会自动出现在这里。",
});
assert.match(runActivityCopy({ status: "running", mode: "team", phase: "replying" }).detail, /调整方向/);
assert.match(runActivityCopy({ status: "running", mode: "debate", phase: "replying" }).title, /收到你的补充/);
assert.equal(runActivityCopy({ status: "done", mode: "single", phase: "continuing" }), null);

const openingStarts = [
  { type: "debate.progress", taskId: "debate-1", round: 1, speaker: "A", phase: "start", startedAt: "2026-08-04T00:00:00.000Z" },
  { type: "debate.progress", taskId: "debate-1", round: 1, speaker: "B", phase: "start", startedAt: "2026-08-04T00:00:01.000Z" },
];
const parallelOpening = rebuildDebateState([
  ...openingStarts,
  { round: 1, speaker: "B", text: "B 先完成", at: "2026-08-04T00:00:02.000Z" },
]);
assert.equal(parallelOpening.turns.length, 2);
assert.equal(parallelOpening.turns.at(-1)?.speaker, "B");
assert.equal(parallelOpening.turns.at(-1)?.done, true);
assert.equal(latestActiveDebateTurn(parallelOpening.turns)?.speaker, "A");

const completedOpening = rebuildDebateState([
  ...openingStarts,
  { round: 1, speaker: "B", text: "B 先完成" },
  { round: 1, speaker: "A", text: "A 后完成" },
]);
assert.equal(completedOpening.turns.length, 2);
assert.equal(latestActiveDebateTurn(completedOpening.turns), null);

console.log("run activity state tests passed");
