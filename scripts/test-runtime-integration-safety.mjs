import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { withTestResources } from "./test-process-resources.mjs";
import { assertRuntimeCompatibility } from "../server/dist/runtime-compatibility.js";
import { acquireRuntimeHandover } from "../server/dist/runtime-handover.js";
import { checkpointRuntimeHandover } from "../server/dist/runtime-handover-prepare.js";
import { releaseRuntimeHandover, reserveRuntimeHandover, runtimeHandoverMatches } from "../server/dist/runtime-handover-state.js";

const compatibility = { protocol: 1, schema: "a".repeat(64) };
assert.throws(() => assertRuntimeCompatibility(compatibility, { ...compatibility, protocol: 2 }, false), /协议/);
assert.throws(() => assertRuntimeCompatibility(compatibility, { ...compatibility, schema: "b".repeat(64) }, true), /迁移/);
assertRuntimeCompatibility(compatibility, { ...compatibility, schema: "b".repeat(64) }, false);
console.log("✓ the sole handover protocol rejects unknown versions and active schema changes");

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

let thawed = false;
const unregisterFrozen = registerRuntimeConsumer("frozen", () => ({ ready: Promise.resolve(), resume() { thawed = true; } }), () => true);
const frozenImpact = { survives: [], interrupted: [], resumes: [], mcpDisrupted: [], runtimeHandover: { sessions: ["frozen"], blocked: [] } };
const prepared = await acquireRuntimeHandover(async () => frozenImpact, () => [], { seal: async () => {}, checkpoint: checkpointRuntimeHandover });
assert.ok(prepared.lease);
assert.equal(thawed, false);
releaseRuntimeHandover(prepared.lease);
assert.equal(thawed, true);
thawed = false;
const expiring = await acquireRuntimeHandover(async () => frozenImpact, () => [], { seal: async () => {}, checkpoint: checkpointRuntimeHandover });
const now = Date.now;
try { Date.now = () => now() + 61_000; assert.equal(runtimeHandoverMatches(expiring.lease), false); }
finally { Date.now = now; releaseRuntimeHandover(expiring.lease); unregisterFrozen(); }
assert.equal(thawed, true);
console.log("✓ lease release and expiry thaw the very same persisted consumer checkpoint");

let replacementLease;
let assessments = 0;
try {
  const replaced = await acquireRuntimeHandover(async () => {
    if (++assessments === 2) {
      try { Date.now = () => now() + 61_000; replacementLease = reserveRuntimeHandover(); }
      finally { Date.now = now; }
    }
    return { ...frozenImpact, runtimeHandover: { sessions: [], blocked: [] } };
  }, () => [], { seal: async () => {}, checkpoint: async () => {} });
  assert.ok(replacementLease);
  assert.equal(replaced.lease, undefined, "an expired acquisition cannot return a replacement lease's authority");
  assert.equal(runtimeHandoverMatches(replacementLease), true, "stale cleanup cannot release the new lease");
} finally {
  Date.now = now;
  if (replacementLease) releaseRuntimeHandover(replacementLease);
}
console.log("✓ a lease replaced during the final assessment cannot authorize the stale takeover");

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
