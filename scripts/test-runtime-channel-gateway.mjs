import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as directFetch } from "undici";
import { gatewayRequest } from "../server/dist/runtime-channel-gateway.js";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { runTestProcess } from "./test-process.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS channel gateway Unix control socket");
} else {
  const temporary = mkdtempSync(join(tmpdir(), "navi-gateway-"));
  const socket = join(temporary, "control.sock");
  const entry = fileURLToPath(new URL("../server/dist/runtime-channel-daemon.js", import.meta.url));
  const daemon = spawnTestFixture(process.execPath, [entry, socket], { stdio: ["ignore", "pipe", "pipe"] });
  const servers = [];
  const waitFor = async (check, label) => {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const value = await check();
      if (value) return value;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(label);
  };
  const counts = new Map();
  const direct = new Agent();
  const fetch = (url, options) => directFetch(url, { ...options, dispatcher: direct });
  let stream;
  const backend = async (version) => {
    const server = createServer(async (incoming, outgoing) => {
      let text = "";
      for await (const chunk of incoming) text += chunk;
      const body = JSON.parse(text || "{}");
      counts.set(body.key, (counts.get(body.key) ?? 0) + 1);
      if (body.abort) { outgoing.destroy(); return; }
      if (body.hold) { stream = outgoing; outgoing.writeHead(200); outgoing.write("first\n"); return; }
      if (incoming.url.includes("hooks")) {
        if (body.invalid) { outgoing.writeHead(500); outgoing.end("broken"); return; }
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: version } }));
      } else outgoing.end(JSON.stringify({ version, key: body.key, auth: incoming.headers.authorization }));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
  };
  await withTestResources(async () => {
    const state = await waitFor(async () => {
      try { return await gatewayRequest(socket, "/status"); } catch { return false; }
    }, "gateway starts");
    const base = `http://127.0.0.1:${state.port}`;
    const old = await backend("old");
    const activate = (server, owner) => gatewayRequest(socket, "/activate", { port: server.address().port, owner, pid: process.pid });
    const pause = (owner) => gatewayRequest(socket, "/pause", { owner });
    const resume = (owner) => gatewayRequest(socket, "/resume", { owner });
    const send = (body, hook = false, signal) => fetch(base + (hook ? "/api/hooks/claude-monitor" : "/api/llm-providers/p/convert/v1/responses"), {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(body), signal,
    });
    await activate(old, "old");
    assert.equal((await send({ key: "auth" })).status, 200);
    assert.equal(counts.get("auth"), 1);
    assert.equal((await fetch(base + "/api/tasks")).status, 404);
    const streaming = await send({ key: "stream", hold: true });
    const reader = streaming.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
    assert.equal((await pause("old")).active, 1);
    await assert.rejects(gatewayRequest(socket, "/retire", { owner: "old" }), /409/);
    const queued = send({ key: "gap" });
    const hook = send({ key: "gap-hook" }, true);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(counts.get("gap"), undefined);
    assert.equal(counts.get("gap-hook"), undefined);
    const next = await backend("new");
    await assert.rejects(activate(next, "new"), /409/);
    stream.end("last\n");
    assert.equal(new TextDecoder().decode((await reader.read()).value), "last\n");
    assert.equal((await reader.read()).done, true);
    await waitFor(async () => (await gatewayRequest(socket, "/status")).active === 0, "EOF releases delivery barrier");
    await new Promise((done) => old.close(done));
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(counts.get("gap"), undefined, "no backend connection in the switch gap");
    await activate(next, "new");
    assert.deepEqual(await (await queued).json(), { version: "new", key: "gap", auth: "Bearer fixture" });
    assert.equal((await (await hook).json()).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(counts.get("gap"), 1);
    assert.equal(counts.get("gap-hook"), 1);
    await assert.rejects(resume("old"), /409/);
    assert.equal((await gatewayRequest(socket, "/status")).id, state.id);
    console.log("✓ independent gateway survives backend replacement; streams drain, new model/hook requests queue, identity fencing prevents stale unfreeze");

    const abortStream = new AbortController();
    const abandoned = await send({ key: "abandoned-stream", hold: true }, false, abortStream.signal);
    await abandoned.body.getReader().read();
    abortStream.abort();
    await waitFor(async () => (await gatewayRequest(socket, "/status")).active === 0, "disconnected stream releases the gateway barrier");

    const uncertain = await send({ key: "non-idempotent", abort: true });
    assert.equal(uncertain.status, 503);
    assert.equal(uncertain.headers.get("x-navi-undelivered"), null);
    await uncertain.text();
    assert.equal(counts.get("non-idempotent"), 1, "a delivered write is never replayed");
    for (const body of [{ key: "hook-crash", abort: true }, { key: "hook-500", invalid: true }]) {
      const response = await send(body, true);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).hookSpecificOutput.permissionDecision, "deny");
    }
    await pause("new");
    const expired = await send({ key: "expired-hook" }, true);
    assert.equal(expired.status, 200);
    assert.match((await expired.json()).hookSpecificOutput.permissionDecisionReason, /未执行/);
    const abort = new AbortController();
    const cancelled = send({ key: "cancelled" }, false, abort.signal);
    await new Promise((done) => setTimeout(done, 50));
    abort.abort();
    await assert.rejects(cancelled);
    await new Promise((done) => setTimeout(done, 50));
    const resumed = send({ key: "rollback" });
    await resume("new");
    assert.equal((await (await resumed).json()).version, "new");
    assert.equal(counts.get("expired-hook"), undefined, "expired hooks never execute later");
    assert.equal(counts.get("cancelled"), undefined, "disconnected queued callers never execute later");
    const exit = once(daemon, "exit");
    await gatewayRequest(socket, "/retire", { owner: "new" });
    assert.deepEqual(await exit, [0, null]);
    const decision = await runTestProcess(process.execPath, [entry, "--deny-monitor"]);
    assert.equal(JSON.parse(decision.stdout).hookSpecificOutput.permissionDecision, "deny");
    console.log("✓ no replay of uncertain writes; Monitor returns explicit deny for offline/failed/expired delivery, command fallback denies even with the gateway dead, cancellation and rollback recover");
  }, [
    () => daemon.dispose(),
    () => direct.destroy(),
    async () => { for (const server of servers) { server.closeAllConnections(); await new Promise((done) => server.close(done)); } },
    () => rmSync(temporary, { recursive: true, force: true }),
  ]);
}
