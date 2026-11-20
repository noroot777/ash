import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { Agent, fetch as directFetch } from "undici";
import { recordListeningPort } from "../server/dist/listening-port.js";
import { activeRuntimeChannels, recordRuntimeChannels, runtimeChannelFile, runtimeChannelReasons } from "../server/dist/runtime-agent-channels.js";
import { beginRuntimeDrain, endRuntimeDrain, runtimeDrainGate, sealRuntimeChannels, waitRuntimeRequests } from "../server/dist/runtime-drain.js";
import { withTestResources } from "./test-process-resources.mjs";

const temporary = mkdtempSync(join(tmpdir(), "navi-runtime-channels-"));
const direct = new Agent();
const fetch = (url, options) => directFetch(url, { ...options, dispatcher: direct });
const app = new Hono();
app.use("*", runtimeDrainGate());
const streams = new Map();
app.all("/api/llm-providers/p/:channel/v1/*", (context) => {
  if (!context.req.query("hold")) return context.json({ served: true });
  return new Response(new ReadableStream({
    start(controller) { streams.set(context.req.query("hold"), controller); controller.enqueue(new TextEncoder().encode("first\n")); },
  }), { headers: { "content-type": "text/event-stream" } });
});
app.post("/api/hooks/claude-monitor", (context) => context.json({ hookSpecificOutput: { permissionDecision: "deny" } }));
app.post("/api/projects", (context) => context.json({ executed: true }));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await withTestResources(async () => {
  if (!server.listening) await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  recordListeningPort(port);
  const out = join(temporary, "run.agent-out.jsonl");
  const settings = join(temporary, "settings.json");
  writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${base}/api/llm-providers/p/context-1m`,
    ANTHROPIC_AUTH_TOKEN: "fixture-secret" }, hooks: { PreToolUse: [{ hooks: [{ type: "http", url: `${base}/api/hooks/claude-monitor` }] }] } }));
  recordRuntimeChannels(temporary, ["--settings", settings], {}, out);
  unlinkSync(settings);
  assert.match(runtimeChannelReasons(out).join(";"), /1M.*Monitor/);
  assert.doesNotMatch(readFileSync(runtimeChannelFile(out), "utf8"), /fixture-secret/);
  recordRuntimeChannels(temporary, ["-c", `model_providers.p.base_url="${base}/api/llm-providers/p/convert/v1"`], {}, out);
  assert.match(runtimeChannelReasons(out)[0], /模型协议转换/);
  recordRuntimeChannels(temporary, ["--settings", JSON.stringify({ hooks: { url: `${base}/api/hooks/claude-monitor` } }),
    "--settings", "{}"], { ANTHROPIC_BASE_URL: "https://upstream.invalid" }, out);
  assert.deepEqual(runtimeChannelReasons(out), []);
  recordRuntimeChannels(temporary, ["--settings", "missing.json"], {}, out);
  assert.match(runtimeChannelReasons(out)[0], /无法确认/);
  recordRuntimeChannels(temporary, ["--settings"], {}, out);
  assert.match(runtimeChannelReasons(out)[0], /无法确认/);
  unlinkSync(runtimeChannelFile(out));
  assert.match(runtimeChannelReasons(out)[0], /缺失或无效/);
  console.log("✓ launch-time channel snapshots survive removed settings, distinguish relay/hooks from direct traffic, and fail closed without leaking credentials");

  const response = await fetch(`${base}/api/llm-providers/p/convert/v1/responses?hold=live`, { method: "POST" });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
  beginRuntimeDrain();
  assert.equal(await waitRuntimeRequests(100), false, "response headers are not completion of a stream");
  assert.match(activeRuntimeChannels().join(";"), /模型协议转换/);
  for (const path of ["/api/llm-providers/p/context-1m/v1/messages", "/api/llm-providers/p/convert/v1/responses", "/api/hooks/claude-monitor"]) {
    const continued = await fetch(base + path, { method: "POST" });
    assert.equal(continued.status, 200, path);
    assert.equal(continued.headers.get("x-navi-undelivered"), null);
    const body = await continued.json();
    if (path.includes("hooks")) assert.equal(body.hookSpecificOutput.permissionDecision, "deny");
  }
  const refused = await fetch(base + "/api/projects", { method: "POST" });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("x-navi-undelivered"), "runtime-handoff-v1");
  await refused.text();
  streams.get("live").enqueue(new TextEncoder().encode("second\n"));
  streams.get("live").close();
  let tail = "";
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
  assert.equal(tail, "second\n");
  assert.equal(await waitRuntimeRequests(1000), true);
  const abort = new AbortController();
  const aborted = await fetch(`${base}/api/llm-providers/p/convert/v1/responses?hold=abort`, { signal: abort.signal });
  await aborted.body.getReader().read();
  abort.abort();
  assert.equal(await waitRuntimeRequests(1000), true, "disconnected real HTTP client releases its stream");
  for (const mode of ["cancel", "error"]) {
    const streamed = await app.request(`/api/llm-providers/p/convert/v1/responses?hold=${mode}`);
    const body = streamed.body.getReader();
    await body.read();
    if (mode === "cancel") await body.cancel("client left");
    else { streams.get(mode).error(new Error("upstream failed")); await assert.rejects(body.read(), /upstream failed/); }
    assert.equal(await waitRuntimeRequests(1000), true, mode);
  }
  console.log("✓ active streams remain in-flight until EOF/error/cancel; relay and Monitor requests continue during drain while ordinary MCP mutations remain definitely undelivered");
  sealRuntimeChannels();
  const sealed = await app.request("/api/llm-providers/p/convert/v1/responses", { method: "POST" });
  assert.equal(sealed.status, 503);
  assert.equal(sealed.headers.get("x-navi-undelivered"), "runtime-handoff-v1");
  const denied = await app.request("/api/hooks/claude-monitor", { method: "POST" });
  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).hookSpecificOutput.permissionDecision, "deny");
  endRuntimeDrain();
  assert.equal((await app.request("/api/llm-providers/p/convert/v1/responses", { method: "POST" })).status, 200);
  console.log("✓ final handoff seal closes the admission race without silently allowing Monitor; cancellation restores admission");
}, [
  () => endRuntimeDrain(),
  () => direct.destroy(),
  async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  () => rmSync(temporary, { recursive: true, force: true }),
]);
