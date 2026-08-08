import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendSessionTrace,
  parseSessionTrace,
  sessionTracePath,
} from "../src/transcript.js";

const taskId = `trace-test-${process.pid}`;
const sessionId = "session-1";
const turnStartedAt = "2026-08-01T01:00:00.000Z";
const path = sessionTracePath(taskId, sessionId);

try {
  assert.match(path, /session-1\.trace\.jsonl$/);
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "thinking",
    text: "检查现有实现",
  }, "2026-08-01T01:00:01.000Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "text",
    text: "先说明第一段。",
  }, "2026-08-01T01:00:01.500Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "tool",
    name: "exec",
    detail: "rg -n trace",
  }, "2026-08-01T01:00:02.000Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "attachment",
    path: "/tmp/data/uploads/agent-result.png",
  }, "2026-08-01T01:00:03.000Z");

  const parsed = parseSessionTrace(`${readFileSync(path, "utf8")}not-json\n`);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0]?.event.kind, "thinking");
  assert.equal(parsed[1]?.event.kind, "text");
  assert.equal(parsed[2]?.event.kind, "tool");
  assert.equal(parsed[2]?.turnStartedAt, turnStartedAt);
  assert.deepEqual(parsed[3]?.event, {
    kind: "attachment",
    path: "/tmp/data/uploads/agent-result.png",
  });
  console.log("会话执行轨迹持久化验证通过");
} finally {
  rmSync(dirname(path), { recursive: true, force: true });
}
