import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCodexExit, RunTraceRecorder, type CodexExitEvidence } from "../src/executors/diagnostics.js";

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

const dir = mkdtempSync(join(tmpdir(), "harness-diagnostics-"));
try {
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("codex diagnostics tests passed");
