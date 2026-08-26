import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { classifyCodexExit, formatFailureForTimeline, RunTraceRecorder, type CodexExitEvidence } from "../src/executors/diagnostics.js";
import { parseCodexStream } from "../src/executors/codex.js";

const base = (overrides: Partial<CodexExitEvidence> = {}): CodexExitEvidence => ({
  exitStatus: 0,
  exitSignal: null,
  stopRequested: false,
  turnCompleted: true,
  turnFailedMessage: null,
  structuredErrors: [],
  stderrTail: "",
  lastEventType: "turn.completed",
  lastEventSummary: "turn.completed",
  agentMessageCount: 1,
  ...overrides,
});

assert.deepEqual(classifyCodexExit(base()), {
  terminationKind: "completed",
  failureKind: null,
  failureReason: null,
});

assert.equal(
  classifyCodexExit(base({ exitStatus: 1, turnCompleted: false, lastEventType: "item.completed:mcp_tool_call" })).failureKind,
  "silent_nonzero_exit",
);

assert.deepEqual(classifyCodexExit(base({ turnFailedMessage: "upstream disconnected" })), {
  terminationKind: "turn_failed",
  failureKind: "turn_failed",
  failureReason: "upstream disconnected",
});

assert.equal(classifyCodexExit(base({ exitStatus: 1, exitSignal: "SIGTERM" })).failureKind, "process_signal");
assert.equal(classifyCodexExit(base({ exitStatus: 1, structuredErrors: ["rate limit"] })).failureReason, "rate limit");
assert.equal(classifyCodexExit(base({ turnCompleted: false })).failureKind, "missing_turn_completion");
assert.deepEqual(classifyCodexExit(base({ exitStatus: 1, stopRequested: true })), {
  terminationKind: "manual_stop",
  failureKind: null,
  failureReason: null,
});

const poisonedStderr = [
  "ignored world-state patch without a full snapshot\n",
  "dropping turn-scoped item for unknown turn id 01a03642-0000-7000-8000-000000000000\n".repeat(15),
];
for (const stderrTail of poisonedStderr) {
  const classified = classifyCodexExit(base({ stderrTail }));
  assert.equal(classified.failureKind, null, "poisoned 不得篡改本回合的真实结束原因");
}
const resumableFlushWarning =
  "failed to flush rollout after emitting terminal turn event: thread 01a036d3-b959-7462-9f46-7b4b5e2327e3 not found\n";

function finishWithStderr(stderr: string, overrides: Partial<CodexExitEvidence> = {}) {
  const recorder = new RunTraceRecorder();
  recorder.stderr(stderr);
  const { stderrTail: _stderrTail, ...evidence } = base(overrides);
  return recorder.finish(evidence);
}

for (const stderr of [...poisonedStderr, resumableFlushWarning]) {
  const diagnostics = finishWithStderr(stderr);
  assert.equal(diagnostics.terminationKind, "completed");
  assert.ok(diagnostics.sessionPoisonedReason, "中毒/前兆信号必须正交记录并触发会话轮换");
}

const longStderr = finishWithStderr(poisonedStderr[1] + "x".repeat(8190));
assert.doesNotMatch(longStderr.stderrTail ?? "", /dropping turn-scoped item/, "前置指纹应已被展示尾窗挤掉");
assert.match(longStderr.sessionPoisonedReason ?? "", /unknown turn id/, "流式粘性判定不能随尾窗丢失");

assert.deepEqual(
  finishWithStderr(poisonedStderr[0], { stopRequested: true, exitStatus: 1 }).terminationKind,
  "manual_stop",
);
assert.equal(
  finishWithStderr(poisonedStderr[0], { turnFailedMessage: "Credit balance is too low" }).failureReason,
  "Credit balance is too low",
);
assert.equal(
  finishWithStderr(poisonedStderr[0], { spawnError: "找不到 codex 可执行文件", exitStatus: 1 }).failureReason,
  "找不到 codex 可执行文件",
);

const dir = mkdtempSync(join(tmpdir(), "ash-diagnostics-"));
try {
  const originalCodexHome = process.env.CODEX_HOME;
  const emptyCodexHome = join(dir, "codex-home");
  mkdirSync(emptyCodexHome, { recursive: true });
  process.env.CODEX_HOME = emptyCodexHome;
  try {
    for (const [index, stderr] of poisonedStderr.entries()) {
      const stdout = [
        JSON.stringify({ type: "thread.started", thread_id: `poisoned-thread-${index}` }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }),
      ].join("\n") + "\n";
      const child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});`], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.end();
      const events: AgentEvent[] = [];
      for await (const event of parseCodexStream(child as any, undefined, { stopRequested: false }, {
        initialThreadId: `poisoned-thread-${index}`,
        contextNotBeforeMs: Date.now(),
      })) events.push(event);
      assert.equal(events.find((event) => event.kind === "done")?.exitStatus, 0, "假 Codex 前置条件必须是 exit 0");
      assert.ok(
        events.some((event) => event.kind === "error" && event.scope === "session" && /session=poisoned_session/.test(event.message)),
        `exit 0 的 poisoned stderr 没进入 error 事件:${JSON.stringify(events)}`,
      );
    }
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }

  const paths = {
    eventsPath: join(dir, "events.jsonl"),
    stderrPath: join(dir, "stderr.log"),
    diagnosticsPath: join(dir, "diagnostics.json"),
  };
  const recorder = new RunTraceRecorder(paths);
  recorder.event('{"type":"thread.started"}');
  recorder.stderr("connection closed\n");
  const { stderrTail: _stderrTail, ...evidence } = base({ exitStatus: 1, turnCompleted: false });
  const diagnostics = recorder.finish(evidence);
  assert.equal(readFileSync(paths.eventsPath, "utf8"), '{"type":"thread.started"}\n');
  assert.equal(readFileSync(paths.stderrPath, "utf8"), "connection closed\n");
  assert.equal(JSON.parse(readFileSync(paths.diagnosticsPath, "utf8")).failureReason, "connection closed");
  assert.equal(diagnostics.failureKind, "nonzero_exit");
  const rootCauseSentinel = "THE_REAL_ROOT_CAUSE_SENTINEL: disk quota exceeded";
  const longTimeline = formatFailureForTimeline({
    ...diagnostics,
    failureReason: `${"重复 stderr 行\n".repeat(1000)}${rootCauseSentinel}`,
  }) ?? "";
  assert.match(longTimeline, /中间已截断 \d+ 字/, "时间线失败摘要没有截断长 stderr");
  assert.match(longTimeline, new RegExp(rootCauseSentinel), "时间线失败摘要丢失 stderr 尾部的真实根因");
  assert.match(longTimeline, /原始日志：.*events\.jsonl.*stderr\.log/, "截断后必须保留原始日志入口");
  assert.ok(longTimeline.length < 1800, `时间线失败摘要仍过长:${longTimeline.length}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("codex diagnostics tests passed");
