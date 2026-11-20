import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { withTestResources } from "./test-process-resources.mjs";
import { assertRuntimeCompatibility } from "../server/dist/runtime-compatibility.js";
import { acquireRuntimeHandover } from "../server/dist/runtime-handover.js";
import { checkpointRuntimeHandover } from "../server/dist/runtime-handover-prepare.js";
import { releaseRuntimeHandover, reserveRuntimeHandover, runtimeHandoverMatches } from "../server/dist/runtime-handover-state.js";
import { preflightRuntimeHandover } from "../server/dist/runtime-handover-preflight.js";
import { initializeRuntimeGateway } from "../server/dist/runtime-channel-gateway.js";
import { runtimeHandoverGate } from "../server/dist/runtime-handover-gate.js";

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
    if (++assessments === 3) {
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

let changed = false;
let raceSeals = 0;
let raceResumes = 0;
const raceImpact = async () => ({ survives: [], interrupted: [], resumes: [], mcpDisrupted: [],
  runtimeHandover: { sessions: [], blocked: changed ? [{ id: "runtime-gateway", title: "稳定通道", reason: "准备期间通道失效" }] : [] } });
await assert.rejects(acquireRuntimeHandover(raceImpact, () => [], {
  async seal() {
    raceSeals++;
    const { afterRuntimeHandover } = await import("../server/dist/runtime-handover-state.js");
    afterRuntimeHandover(() => { raceResumes++; });
    changed = true;
  }, checkpoint: checkpointRuntimeHandover,
}), /准备期间通道失效/);
assert.equal(raceResumes, 1, "a failure after sealing must release the local lease and its consumers");
for (let cycle = 0; cycle < 3; cycle++) {
  const result = await acquireRuntimeHandover(raceImpact, () => [], { async seal() { raceSeals++; }, checkpoint: checkpointRuntimeHandover });
  assert.equal(result.lease, undefined);
}
assert.equal(raceSeals, 1, "a dynamically discovered blocker must prevent the next attempt from sealing again");
console.log("✓ a blocker appearing after preflight is rechecked, releases its lease and prevents subsequent repeated seals");

const temporary = mkdtempSync(join(tmpdir(), "navi-preflight-"));
let degraded;
try {
  degraded = await initializeRuntimeGateway({ home: join(temporary, "gateway"), socket: join(temporary, "control.sock"),
    entry: join(temporary, "missing-daemon.js"), node: process.execPath, owner: "preflight", port: 4317, hasConsumers: async () => false });
  assert.equal(degraded.state, undefined);
  const app = new Hono();
  app.use("*", runtimeHandoverGate());
  app.get("/api/check", (context) => context.json({ available: true }));
  let seals = 0;
  let checkpoints = 0;
  const assess = async () => {
    const impact = { survives: [], interrupted: [], resumes: [], mcpDisrupted: [], runtimeHandover: { sessions: [], blocked: [] } };
    await preflightRuntimeHandover(impact);
    return impact;
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    const preview = await assess();
    assert.ok(preview.runtimeHandover.blocked.some((item) => item.id === "runtime-gateway" && /暂不可用/.test(item.reason)));
    const refused = await acquireRuntimeHandover(assess, () => [], {
      async seal() { seals++; }, async checkpoint() { checkpoints++; },
    });
    assert.equal(refused.lease, undefined);
    assert.match(refused.error, /稳定通道暂不可用/);
    assert.equal((await app.request("/api/check")).status, 200, "refused preflight must never seal normal API traffic");
  }
  assert.equal(seals, 0);
  assert.equal(checkpoints, 0);
  console.log("✓ disabled gateway is reported by the shared preflight; repeated attempts never reserve, seal or checkpoint even without tasks");
} finally { degraded?.close(); rmSync(temporary, { recursive: true, force: true }); }

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
