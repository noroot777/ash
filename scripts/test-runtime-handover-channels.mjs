import assert from "node:assert/strict";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Agent, fetch as directFetch } from "undici";
import { runtimeHandoverGate, waitRuntimeRequests } from "../server/dist/runtime-handover-gate.js";
import { reserveRuntimeHandover, releaseRuntimeHandover } from "../server/dist/runtime-handover-state.js";
import { activeRuntimeChannels } from "../server/dist/runtime-agent-channels.js";
import { withTestResources } from "./test-process-resources.mjs";

const direct = new Agent();
const app = new Hono();
const streams = new Map();
let lease;
app.use("*", runtimeHandoverGate());
app.get("/api/llm-providers/p/convert/v1/responses", (context) => new Response(new ReadableStream({
  start(controller) { streams.set(context.req.query("mode"), controller); controller.enqueue(new TextEncoder().encode("first")); },
}), { headers: { "content-type": "text/event-stream" } }));
app.post("/api/projects", (context) => context.json({ executed: true }));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await withTestResources(async () => {
  if (!server.listening) await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetch = (path, options) => directFetch(base + path, { ...options, dispatcher: direct });
  const channel = "/api/llm-providers/p/convert/v1/responses";
  const response = await fetch(channel + "?mode=live");
  const body = response.body.getReader();
  await body.read();
  lease = reserveRuntimeHandover();
  assert.equal(await waitRuntimeRequests(100), false);
  assert.match(activeRuntimeChannels().join(";"), /模型协议转换/);
  const refused = await fetch("/api/projects", { method: "POST" });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("x-navi-undelivered"), "runtime-handoff-v1");
  await refused.text();
  const monitor = await fetch("/api/hooks/claude-monitor", { method: "POST" });
  assert.equal((await monitor.json()).hookSpecificOutput.permissionDecision, "deny");
  streams.get("live").enqueue(new TextEncoder().encode("second"));
  streams.get("live").close();
  let tail = "";
  for (;;) { const chunk = await body.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
  assert.equal(tail, "second");
  assert.equal(await waitRuntimeRequests(1000), true);
  releaseRuntimeHandover(lease);
  const abort = new AbortController();
  const aborted = await fetch(channel + "?mode=abort", { signal: abort.signal });
  await aborted.body.getReader().read();
  abort.abort();
  assert.equal(await waitRuntimeRequests(1000), true);
  for (const mode of ["cancel", "error"]) {
    const response = await app.request(channel + `?mode=${mode}`);
    const reader = response.body.getReader();
    await reader.read();
    if (mode === "cancel") await reader.cancel("client left");
    else { streams.get(mode).error(new Error("upstream failed")); await assert.rejects(reader.read(), /upstream failed/); }
    assert.equal(await waitRuntimeRequests(1000), true);
  }
  assert.equal((await app.request("/api/projects", { method: "POST" })).status, 200);
  console.log("✓ the main handover lease seals admission, preserves delivered streams, and drains EOF/error/cancel/real HTTP abort");
}, [
  () => releaseRuntimeHandover(lease),
  () => direct.destroy(),
  async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
]);
