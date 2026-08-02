import assert from "node:assert/strict";
import { runActivityCopy } from "../src/runActivityCopy.ts";

const running = (mode, executor) => runActivityCopy({ status: "running", mode, executor });

assert.deepEqual(running("single", "codex@local"), {
  title: "codex@local 正在启动",
  detail: "正在准备运行环境、读取任务并连接执行器。首条输出会自动出现在这里，无需重复点击。",
});
assert.match(running("team", "claude@ssh").title, /正在启动调度台/);
assert.match(running("debate").detail, /第一位辩手开始发言后/);
assert.deepEqual(
  runActivityCopy({ status: "queued", mode: "single", queuePosition: 1, queueSize: 4 }),
  { title: "已进入队列 · 第 2 / 4 位", detail: "前面的任务结束后会自动启动，无需重复点击。" },
);
assert.equal(runActivityCopy({ status: "backlog", mode: "single" }), null);

console.log("run activity copy tests passed");
