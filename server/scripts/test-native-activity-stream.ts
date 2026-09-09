import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { AgentEvent, NativeAgentActivity } from "@ash/shared";
import { parseClaudeStream } from "../src/executors/claude.js";
import { CodexChildActivity, childActivity } from "../src/executors/native-agent-activity.js";
import { NativeActivityBuffer } from "../src/executors/native-activity-buffer.js";
import { openCodexAppServer } from "../src/executors/codex-app-server.js";

const activity = (events: AgentEvent[]) => events.flatMap((event) => event.kind === "tool" && event.nativeWork?.type === "activity" ? [event.nativeWork.event] : []);
const body = (events: AgentEvent[], kind: "text" | "thinking" = "text") => activity(events).flatMap((event) => event.kind === kind ? [event.text] : []).join("");
const traceBytes = (events: AgentEvent[]) => Buffer.byteLength(events.filter((event) => event.kind === "tool" || event.kind === "thinking" || event.kind === "error")
  .map((event) => JSON.stringify({ at: "2026-09-09T00:00:00.000Z", turnStartedAt: "2026-09-09T00:00:00.000Z", event }) + "\n").join(""));

async function claude(lines: unknown[]): Promise<AgentEvent[]> {
  const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const events: AgentEvent[] = [];
  for await (const event of parseClaudeStream(child)) events.push(event);
  return events;
}

const delta = (text: string, kind = "text_delta") => ({ type: "stream_event", parent_tool_use_id: "child",
  event: { type: "content_block_delta", delta: kind === "text_delta" ? { type: kind, text } : { type: kind, thinking: text } } });

const text = "word".repeat(2000);
const pure = await claude([
  ...Array.from({ length: 2000 }, () => delta("word")),
  { type: "assistant", parent_tool_use_id: "child", message: { content: [{ type: "text", text }] } },
]);
assert.equal(body(pure), text + "\n\n");
assert.ok(pure.length <= 205, `8000-character output emitted ${pure.length} events`);
assert.ok(traceBytes(pure) < 80 * 1024, `pure text trace grew to ${traceBytes(pure)} bytes`);

const mixedLines: unknown[] = [];
for (let index = 0; index < 20; index++) mixedLines.push(
  { type: "assistant", parent_tool_use_id: "child", message: { content: [{ type: "tool_use", id: `read-${index}`, name: "Read", input: { file_path: `src/file-${index}.ts` } }] } },
  { type: "user", parent_tool_use_id: "child", message: { content: [{ type: "tool_result", tool_use_id: `read-${index}`, content: "x".repeat(12 * 1024) }] } },
);
mixedLines.push(...Array.from({ length: 1500 }, () => delta("word")),
  { type: "assistant", parent_tool_use_id: "child", message: { content: [{ type: "text", text: "word".repeat(1500) }] } });
const mixed = await claude(mixedLines);
assert.equal(body(mixed), "word".repeat(1500) + "\n\n");
assert.ok(mixed.length <= 220, `mixed workload emitted ${mixed.length} events`);
assert.ok(traceBytes(mixed) < 100 * 1024, `mixed trace grew to ${traceBytes(mixed)} bytes`);
const results = activity(mixed).filter((event) => event.kind === "tool" && event.name === "Read 结果");
assert.equal(results.length, 20);
assert.ok(results.every((event) => event.kind === "tool" && event.detail!.length <= 1500 && event.detail!.endsWith("…（内容已截断）")));

const reasoning = await claude([...Array.from({ length: 2000 }, () => delta("word", "thinking_delta")), delta("未达到阈值的尾部")]);
assert.equal(body(reasoning, "thinking"), text);
assert.equal(body(reasoning), "未达到阈值的尾部", "process exit flushes an unfinished child's tail");
assert.ok(reasoning.length <= 203);

const buffer = new NativeActivityBuffer();
const push = (id: string, event: NativeAgentActivity) => buffer.push(childActivity(id, event));
assert.deepEqual(push("a", { kind: "text", text: "A" }), []);
assert.deepEqual(push("b", { kind: "text", text: "B" }), [], "parallel children batch independently");
assert.equal(body(push("a", { kind: "thinking", text: "分析" })), "A");
const beforeTool = push("a", { kind: "tool", name: "Read", detail: "src/main.ts" });
assert.deepEqual(activity(beforeTool).map((event) => event.kind), ["thinking", "tool"]);
assert.equal(body(buffer.push({ kind: "tool", name: "Agent", nativeWork: { type: "agent", id: "b", status: "completed" } })), "B");
assert.deepEqual(push("c", { kind: "text", text: "换行\n" }), [childActivity("c", { kind: "text", text: "换行\n" })]);
push("a", { kind: "text", text: "续跑末尾" });
assert.equal(body(buffer.push({ kind: "turnEnd" })), "续跑末尾");
assert.deepEqual(buffer.push({ kind: "done", exitStatus: 0 }), [{ kind: "done", exitStatus: 0 }]);

const codex = new CodexChildActivity();
const codexBuffer = new NativeActivityBuffer();
const codexEvents = Array.from({ length: 2000 }, () => codex.notification("item/agentMessage/delta", { threadId: "c", itemId: "msg", delta: "word" }))
  .flat().flatMap((event) => codexBuffer.push(event));
codexEvents.push(...codex.notification("item/completed", { threadId: "c", item: { type: "agentMessage", id: "msg", text } }).flatMap((event) => codexBuffer.push(event)));
assert.equal(body(codexEvents), text + "\n\n");
assert.equal(codexEvents.length, 201, "Codex uses the same batching threshold");
const longTool = codex.notification("item/started", { threadId: "c", item: { type: "commandExecution", command: "x".repeat(12 * 1024) } });
assert.ok(activity(longTool).every((event) => event.kind === "tool" && event.detail!.length <= 1500));
const longResult = codex.notification("item/completed", { threadId: "c", item: { type: "commandExecution", aggregatedOutput: "x".repeat(12 * 1024), exitCode: 1 } });
assert.ok(activity(longResult).every((event) => event.kind === "tool" && event.detail!.length <= 1500 && event.detail!.startsWith("退出码：1\n")));

const app = openCodexAppServer({ bin: "fixture", args: [], cwd: process.cwd(), prompt: "fixture", startProcess: () => spawn(process.execPath, ["-e", `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'main' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    for (let index = 0; index < 2000; index++) send({ method: 'item/agentMessage/delta', params: { threadId: 'child', itemId: 'msg', delta: 'word' } });
    send({ method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', id: 'msg', text: 'word'.repeat(2000) } } });
    send({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
    send({ method: 'turn/completed', params: { threadId: 'main', turn: { status: 'completed' } } });
  }
});
`], { stdio: ["pipe", "pipe", "pipe"] }) });
const appEvents: AgentEvent[] = [];
for await (const event of app.events) appEvents.push(event);
assert.equal(body(appEvents), text + "\n\n");
assert.equal(activity(appEvents).filter((event) => event.kind === "text").length, 201, "production App Server batches before exposing events to consumers");
assert.ok(traceBytes(appEvents) < 80 * 1024);

console.log(`child stream batching: pure=${pure.length} events/${traceBytes(pure)} bytes; mixed=${mixed.length} events/${traceBytes(mixed)} bytes; text/thinking/order/exit tails preserved`);
