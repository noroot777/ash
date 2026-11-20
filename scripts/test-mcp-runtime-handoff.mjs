import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { withTestResources } from "./test-process-resources.mjs";

const { eventQueue } = await import("../server/dist/executors/event-queue.js");
const { checkpointOutput, supportsOutputCheckpoint } = await import("../server/dist/executors/output-checkpoint.js");
const { NativeActivityBuffer } = await import("../server/dist/executors/native-activity-buffer.js");
const child = new EventEmitter();
let suspended = false;
child.naviSuspend = () => { suspended = true; return () => { suspended = false; }; };
assert.equal(supportsOutputCheckpoint(child), false);
const queue = eventQueue({ child, activity: new NativeActivityBuffer(), coalesce: { text: 1000 }, maxHoldMs: 10_000 });
assert.equal(supportsOutputCheckpoint(child), true);
const { registerRuntimeConsumer, runtimeConsumerAvailable } = await import("../server/dist/runtime-consumers.js");
let available = false;
const unregister = registerRuntimeConsumer("test-session", () => checkpointOutput(child), () => available);
assert.equal(runtimeConsumerAvailable("test-session"), false);
available = true;
assert.equal(runtimeConsumerAvailable("test-session"), true);
unregister();
assert.equal(runtimeConsumerAvailable("test-session"), false);
const received = [];
const consuming = (async () => {
  for await (const event of queue.drain()) {
    await new Promise((done) => setTimeout(done, 25));
    received.push(event);
  }
})();
queue.delta("text", "buffered fragment without newline");
queue.push({ kind: "tool", nativeWork: { type: "activity", id: "child", event: { kind: "text", text: "tiny" } } });
const checkpoint = checkpointOutput(child);
await checkpoint.ready;
assert.equal(suspended, true);
assert.equal(received[0].text, "buffered fragment without newline");
assert.equal(received[1].nativeWork.event.text, "tiny");
queue.push({ kind: "text", text: "after barrier" });
await new Promise((done) => setTimeout(done, 60));
assert.equal(received.length, 2, "checkpoint waits for consumption, then holds later events");
checkpoint.resume();
assert.equal(suspended, false);
queue.close();
await consuming;
assert.equal(received[2].text, "after barrier");
console.log("✓ output checkpoint flushes partial text/child activity, waits for slow persistence, and holds subsequent events until resumed");

const attempts = new Map();
const executed = new Map();
const server = createServer((request, response) => {
  const path = request.url;
  attempts.set(path, (attempts.get(path) ?? 0) + 1);
  if (path === "/api/draining" && attempts.get(path) === 1) {
    response.writeHead(503, { "x-navi-undelivered": "runtime-handoff-v1" });
    response.end('{"error":"not executed"}');
    return;
  }
  executed.set(path, (executed.get(path) ?? 0) + 1);
  if (path === "/api/uncertain") { request.socket.destroy(); return; }
  response.writeHead(path === "/api/unmarked" ? 503 : 200, { "content-type": "application/json" });
  response.end('{"ok":true}');
});
await withTestResources(async () => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  process.env.NAVI_URL = `http://127.0.0.1:${port}`;
  process.env.NAVI_RECONNECT_MS = "3000";
  const { call, retryableCode } = await import("../mcp/dist/runtime.js");
  assert.equal(retryableCode({ cause: { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }] } }), null);
  assert.deepEqual(await call("POST", "/draining", { nonIdempotent: true }), { ok: true });
  assert.equal(attempts.get("/api/draining"), 2);
  assert.equal(executed.get("/api/draining"), 1);
  await assert.rejects(call("POST", "/uncertain", {}), /连不上/);
  assert.equal(executed.get("/api/uncertain"), 1);
  await assert.rejects(call("POST", "/unmarked", {}), /503/);
  assert.equal(executed.get("/api/unmarked"), 1);
  await new Promise((done) => server.close(done));
  const waiting = call("POST", "/reconnected", {});
  await new Promise((done) => setTimeout(done, 250));
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  assert.deepEqual(await waiting, { ok: true });
  assert.equal(executed.get("/api/reconnected"), 1);
  console.log("✓ MCP retries only definitely-undelivered drains/refused connections; uncertain non-idempotent requests are never replayed");
}, [async () => { if (server.listening) await new Promise((done) => server.close(done)); }]);
