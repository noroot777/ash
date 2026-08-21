import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { ServerEvent } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared";
import { bus } from "../src/bus.js";
import { recordUserConversationTurn } from "../src/conversation-turn.js";

let transcript = "";
const out = new Writable({
  write(chunk, _encoding, callback) {
    transcript += chunk.toString();
    callback();
  },
});
const events: ServerEvent[] = [];
const unsubscribe = bus.subscribe((event) => events.push(event));

try {
  recordUserConversationTurn({
    taskId: "task-live-turn",
    sessionId: "session-live-turn",
    role: "single",
    agentType: "codex",
    out,
    text: "【审查未通过】请读取 report.md",
    at: "2026-08-10T01:02:03.000Z",
    bySystem: true,
  });
} finally {
  unsubscribe();
  out.end();
}

const turn = parseSessionOutput(transcript).at(0);
assert.deepEqual(turn, {
  kind: "user",
  text: "【审查未通过】请读取 report.md",
  at: "2026-08-10T01:02:03.000Z",
  bySystem: true,
});
assert.deepEqual(events, [{
  type: "conversation.turn",
  taskId: "task-live-turn",
  sessionId: "session-live-turn",
  role: "single",
  agentType: "codex",
  text: "【审查未通过】请读取 report.md",
  at: "2026-08-10T01:02:03.000Z",
  bySystem: true,
}]);

console.log("conversation turn persistence/live parity passed");
