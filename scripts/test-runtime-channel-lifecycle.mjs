import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as directFetch } from "undici";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { withTestResources } from "./test-process-resources.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";

if (process.platform === "win32") {
  console.log("SKIP: macOS stable channel lifecycle");
} else {
  const temporary = mkdtempSync(join(tmpdir(), "navi-channel-life-"));
  process.env.NAVI_DATA_DIR = temporary;
  process.env.NAVI_DB = join(temporary, "navi.db");
  process.env.NAVI_RUNS_DIR = join(temporary, "runs");
  const { RuntimeGatewayController, gatewayRequest } = await import("../server/dist/runtime-channel-controller.js");
  const { hasGatewayConsumers, processProof } = await import("../server/dist/runtime-channel-consumers.js");
  const { readRuntimeRecord, replaceRuntimeRecord } = await import("../server/dist/runtime-channel-record.js");
  const { initializeRuntimeGateway, runtimeMonitorFallback } = await import("../server/dist/runtime-channel-gateway.js");
  const { INSTANCE_ID } = await import("../server/dist/instance-binding.js");
  const { beginRuntimeDrain, endRuntimeDrain, holdRuntimeDrain, onRuntimeDrainEnd, runtimeDraining,
    runtimeDrainGate, sealRuntimeChannels } = await import("../server/dist/runtime-drain.js");
  const { acquireDbSingletonLock, liveLockToken } = await import("../server/dist/singleton.js");
  const { NAVI_HEADERS } = await import("../server/dist/request-headers.js");
  const direct = new Agent();
  const fetch = (url, options) => directFetch(url, { ...options, dispatcher: direct });
  const servers = [];
  const controllers = [];
  const sockets = new Map();
  const children = [];
  const consumerDbFile = join(temporary, "consumers.db");
  const consumerDb = new DatabaseSync(consumerDbFile);
  consumerDb.exec("CREATE TABLE sessions (id TEXT, task_id TEXT, ended_at TEXT, agent_pid INTEGER, agent_started_at TEXT, agent_out_path TEXT)");
  const insert = consumerDb.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)");
  const child = async () => {
    const fixture = spawnTestFixture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(fixture);
    await once(fixture, "spawn");
    return fixture;
  };
  const consumer = (fixture, id, key, ended = null) => {
    const out = join(temporary, key + ".out");
    writeFileSync(out + ".runtime-channels.json", JSON.stringify({ version: 2, stable: ["monitor"], gateway: id, channels: [], unknown: false }));
    insert.run(key, "missing-task", ended, fixture.pid, new Date(processProof(fixture.pid).startedAt).toISOString(), out);
    return out;
  };
  const waitFor = async (check, label) => {
    const until = Date.now() + 8_000;
    while (Date.now() < until) {
      try { const result = await check(); if (result) return result; } catch {}
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(label);
  };
  const listen = async (server, address) => {
    servers.push(server);
    server.listen(address, typeof address === "number" ? "127.0.0.1" : undefined);
    await once(server, "listening");
    return server;
  };
  const counts = new Map();
  const requests = new AbortController();
  let stream;
  const backend = createServer(async (incoming, outgoing) => {
    let text = "";
    for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text || "{}");
    counts.set(body.key, (counts.get(body.key) ?? 0) + 1);
    if (body.hold) { stream = outgoing; outgoing.writeHead(200); outgoing.write("first\n"); return; }
    if (incoming.url.includes("hooks")) outgoing.end(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }));
    else outgoing.end(JSON.stringify({ key: body.key }));
  });
  const entry = fileURLToPath(new URL("../server/dist/runtime-channel-daemon.js", import.meta.url));
  let node = process.execPath;
  if (process.platform === "darwin") {
    const common = (await runTestProcess("git", ["rev-parse", "--git-common-dir"])).stdout.trim();
    const root = dirname(realpathSync(common));
    const bundler = readFileSync(new URL("../desktop/macos/scripts/bundle-runtime.mjs", import.meta.url), "utf8");
    const version = bundler.match(/const NODE_VERSION = "([^"]+)"/)[1];
    node = join(process.env.NAVI_MAC_CACHE ?? join(root, "desktop/macos/build/cache"), `node-${version}-darwin-arm64/bin/node`);
    assert.ok(existsSync(node), "prepare the pinned macOS runtime cache before testing portable Node installation");
  }
  const home = join(temporary, "gateway");
  const socket = join(temporary, "control.sock");
  const options = { home, socket, entry, node, owner: INSTANCE_ID, port: 0,
    hasConsumers: async () => false };
  const start = async (overrides = {}) => {
    const controller = new RuntimeGatewayController({ ...options, ...overrides });
    controllers.push(controller);
    await controller.start();
    if (controller.state) sockets.set(controller.socket, overrides.owner ?? INSTANCE_ID);
    return controller;
  };
  const stopDaemon = async (state) => {
    process.kill(state.pid, "SIGTERM");
    await waitFor(() => { try { process.kill(state.pid, 0); return false; } catch { return true; } }, "owned daemon exits");
  };
  let lock;
  await withTestResources(async () => {
    lock = acquireDbSingletonLock();
    assert.ok(lock);
    const { mountRuntimeHandoff } = await import("../server/dist/runtime-handoff.js");
    await listen(backend, 0);
    options.port = backend.address().port;
    const probe = join(temporary, "probe-endpoint.json");
    const empty = readRuntimeRecord(probe);
    replaceRuntimeRecord(probe, empty, { id: "winner" });
    const winner = readRuntimeRecord(probe);
    assert.throws(() => replaceRuntimeRecord(probe, empty, { id: "stale-writer" }), /changed concurrently/);
    assert.throws(() => replaceRuntimeRecord(probe, empty, null), /changed concurrently/);
    const writerLock = new DatabaseSync(probe + ".writer.sqlite");
    try {
      writerLock.exec("BEGIN IMMEDIATE");
      assert.throws(() => replaceRuntimeRecord(probe, winner, { id: "locked-out" }), /locked|busy/);
      assert.deepEqual(readRuntimeRecord(probe), winner);
    } finally { writerLock.close(); }
    replaceRuntimeRecord(probe, winner, null);
    assert.deepEqual(readRuntimeRecord(probe), empty);
    assert.equal(JSON.parse(readFileSync(probe + ".previous", "utf8")).id, "winner");
    console.log("✓ identity writes and archives reject stale snapshots; a process-shared transaction excludes concurrent writers and releases on close");
    const first = await start();
    const original = { ...first.state };
    const base = `http://127.0.0.1:${original.port}`;
    const send = (key, hook = false, body = {}) => {
      const response = fetch(base + (hook ? "/api/hooks/claude-monitor" : "/api/llm-providers/p/convert/v1/responses"), {
        method: "POST", body: JSON.stringify({ key, ...body }), headers: { "content-type": "application/json" }, signal: requests.signal,
      });
      void response.catch(() => {});
      return response;
    };
    assert.equal(original.protocol, 1);
    assert.match(original.build, /^[a-f0-9]{64}(?:-[a-f0-9]{64}){3}$/);
    assert.deepEqual(await (await send("before-crash")).json(), { key: "before-crash" });
    process.kill(original.pid, "SIGKILL");
    const recovered = await waitFor(async () => {
      const state = await gatewayRequest(socket, "/status");
      return state.pid !== original.pid && state.owner === INSTANCE_ID && state;
    }, "live service automatically recovers gateway");
    assert.equal(recovered.id, original.id);
    assert.equal(recovered.port, original.port);
    assert.deepEqual(await (await send("after-crash")).json(), { key: "after-crash" });
    assert.equal((await (await send("hook-after-crash", true)).json()).hookSpecificOutput.permissionDecision, "deny");

    await first.pause();
    process.kill(recovered.pid, "SIGKILL");
    await waitFor(async () => {
      const state = await gatewayRequest(socket, "/status");
      return state.pid !== recovered.pid && state.owner === INSTANCE_ID && state.paused;
    }, "recovery preserves a successful handoff seal");
    const waiting = send("paused-recovery");
    await waitFor(async () => (await gatewayRequest(socket, "/status")).queued === 1, "request queues after recovered seal");
    assert.equal(counts.get("paused-recovery"), undefined);
    await first.resume();
    assert.equal((await (await waiting).json()).key, "paused-recovery");
    assert.equal(counts.get("paused-recovery"), 1);

    first.close();
    await stopDaemon(await gatewayRequest(socket, "/status"));
    const offline = await start();
    assert.equal(offline.state.id, original.id);
    assert.equal(offline.state.port, original.port);
    assert.equal((await (await send("service-reopened")).json()).key, "service-reopened");
    console.log("✓ gateway id/port survive process death and service reopen; watchdog restores model/hooks and preserves the admission seal");

    const nextEntry = join(temporary, "next-gateway.mjs");
    writeFileSync(nextEntry, readFileSync(entry, "utf8") + "\n");
    for (let index = 0; index < 81; index++) insert.run(`stale-${index}`, "missing-task", null, null, null, null);
    insert.run("live-without-out", "done-task", null, process.pid, new Date(processProof(process.pid).startedAt).toISOString(), null);
    const reusedOut = join(temporary, "reused.out");
    writeFileSync(reusedOut + ".runtime-channels.json", JSON.stringify({ version: 2, stable: ["monitor"], gateway: original.id }));
    insert.run("pid-reused", "missing-task", null, process.pid, "2001-01-01T00:00:00.000Z", reusedOut);
    assert.equal(hasGatewayConsumers(consumerDbFile, original.id), false, "historical rows, missing snapshots and reused PIDs do not pin a gateway");
    const live = await child();
    consumer(live, original.id, "live-consumer", "2026-01-01");
    assert.equal(hasGatewayConsumers(consumerDbFile, original.id), true, "a live generation with stable channel evidence counts even after its row was ended");
    assert.equal(hasGatewayConsumers(consumerDbFile, "another-gateway"), false);
    const unknownOut = consumer(live, "unknown-generation", "unknown-generation");
    consumerDb.prepare("UPDATE sessions SET agent_started_at = NULL WHERE agent_out_path = ?").run(unknownOut);
    assert.equal(hasGatewayConsumers(consumerDbFile, "unknown-generation"), true, "relevant channel evidence with an unverifiable generation conservatively retains its entry");
    for (const stable of [null, "monitor", ["invalid-channel"]]) {
      writeFileSync(unknownOut + ".runtime-channels.json", JSON.stringify({ version: 2, stable, gateway: "unknown-generation" }));
      assert.equal(hasGatewayConsumers(consumerDbFile, "unknown-generation"), true, "invalid channel evidence cannot prove an entry unused");
    }
    assert.equal(hasGatewayConsumers(join(temporary, "unavailable.db"), original.id), true, "unreadable consumer database retains the entry");
    consumerDb.prepare("DELETE FROM sessions WHERE agent_out_path = ?").run(unknownOut);
    const realConsumers = { dbFile: consumerDbFile, hasConsumers: async (id) => hasGatewayConsumers(consumerDbFile, id) };
    offline.close();
    const retained = await start({ entry: nextEntry, ...realConsumers });
    assert.equal(retained.state.build, original.build, "compatible entry is retained while a session still uses it");
    assert.notEqual(retained.script, offline.script, "new artifacts are staged by both script and Node content hashes");
    assert.equal((await (await send("retained-session")).json()).key, "retained-session");
    const tracked = JSON.parse(readFileSync(join(home, "endpoint.json"), "utf8"));
    assert.equal(tracked.script, offline.script, JSON.stringify({ tracked, proof: processProof(retained.state.pid) }));
    retained.close();
    await live.dispose();
    assert.equal(hasGatewayConsumers(consumerDbFile, original.id), false, "exited generations do not block upgrades even when snapshots/rows remain");
    const upgraded = await start({ entry: nextEntry, ...realConsumers });
    assert.notEqual(upgraded.state.build, original.build);
    assert.equal(upgraded.state.id, original.id);
    assert.equal(upgraded.state.port, original.port);
    assert.equal((await (await send("upgraded")).json()).key, "upgraded");
    assert.equal(counts.get("upgraded"), 1);

    const delivered = await send("upgrade-stream", false, { hold: true });
    const reader = delivered.body.getReader();
    await reader.read();
    upgraded.close();
    const busy = new RuntimeGatewayController(options);
    controllers.push(busy);
    await busy.start();
    assert.equal(busy.state, undefined, "an in-flight stream disables the entry rather than the entire service");
    assert.match(busy.warning, /409/);
    busy.close();
    assert.equal((await gatewayRequest(socket, "/status")).build, upgraded.state.build);
    stream.end("last\n");
    while (!(await reader.read()).done) {}
    await waitFor(async () => (await gatewayRequest(socket, "/status")).active === 0, "upgrade stream drains");
    const rolledBack = await start();
    assert.equal(rolledBack.state.build, original.build);
    assert.equal(rolledBack.state.id, original.id);
    assert.equal(rolledBack.state.port, original.port);
    assert.equal(counts.get("upgrade-stream"), 1, "upgrade never replays a delivered request");
    console.log("✓ content-versioned entry upgrades/rolls back only at session-free startup; delivered streams are never interrupted or replayed");

    rolledBack.close();
    await stopDaemon(await gatewayRequest(socket, "/status"));
    const legacyEntry = join(temporary, "legacy-gateway.mjs");
    writeFileSync(legacyEntry, readFileSync(entry, "utf8").replace("protocol: 1, build, id,", "id,"));
    const legacy = await start({ entry: legacyEntry, hasConsumers: async () => true });
    assert.equal(legacy.state.protocol, undefined);
    legacy.close();
    unlinkSync(join(home, "endpoint.json"));
    const adopted = await start({ hasConsumers: async () => true });
    assert.equal(adopted.state.id, original.id);
    assert.equal(adopted.state.port, original.port);
    assert.equal(adopted.state.build, undefined);
    assert.equal(JSON.parse(readFileSync(join(home, "endpoint.json"), "utf8")).id, original.id);
    adopted.close();
    const modern = await start();
    assert.equal(modern.state.protocol, 1);
    assert.equal(modern.state.build, original.build);
    assert.equal((await (await send("legacy-upgraded")).json()).key, "legacy-upgraded");
    modern.close();
    await stopDaemon(await gatewayRequest(socket, "/status"));
    console.log("✓ unversioned legacy entry is adopted without moving live URLs, then upgraded after its consumers finish");

    const occupied = await listen(createServer(), original.port);
    const protectedEntry = await start({ hasConsumers: async () => true });
    assert.equal(protectedEntry.state, undefined);
    assert.match(protectedEntry.warning, /EADDRINUSE|ECONNREFUSED|ENOENT/);
    protectedEntry.close();
    assert.equal(JSON.parse(readFileSync(join(home, "endpoint.json"), "utf8")).port, original.port);
    const repairedEntry = await start();
    assert.ok(repairedEntry.state);
    assert.notEqual(repairedEntry.state.id, original.id);
    assert.notEqual(repairedEntry.state.port, original.port);
    assert.equal(occupied.listening, true, "port repair never stops an unrelated listener");
    repairedEntry.close();
    await new Promise((done) => occupied.close(done));

    const unknownSocket = join(temporary, "unknown.sock");
    const unknown = await listen(createServer((incoming, outgoing) => {
      outgoing.end(JSON.stringify({ ...original, protocol: 99 }));
    }), unknownSocket);
    const unknownHome = join(temporary, "unknown");
    const incompatible = await start({ home: unknownHome, socket: unknownSocket, hasConsumers: async () => true });
    assert.equal(incompatible.state, undefined);
    assert.match(incompatible.warning, /unsupported channel gateway protocol/);
    incompatible.close();
    const compatible = await start({ home: unknownHome, socket: unknownSocket });
    assert.equal(compatible.state, undefined, "an unverified live endpoint blocks replacement, not service startup");
    assert.match(compatible.warning, /unsupported channel gateway protocol/);
    assert.equal(unknown.listening, true, "unknown control service is never terminated or unlinked");
    compatible.close();
    await new Promise((done) => unknown.close(done));
    console.log("✓ occupied port and unknown protocol preserve live identities, but recover unused entries without blocking service startup");

    const discovered = await start({ socket: join(temporary, "different-tmp.sock"), hasConsumers: async () => true });
    assert.equal(discovered.socket, repairedEntry.socket);
    assert.equal(discovered.state.pid, repairedEntry.state.pid);
    assert.equal(discovered.state.id, repairedEntry.state.id);
    discovered.close();
    unlinkSync(discovered.socket);
    const rebound = await start({ hasConsumers: async () => true });
    assert.equal(rebound.state.pid, discovered.state.pid, "missing socket is rebound by the original daemon, not a duplicate");
    assert.equal(rebound.state.port, discovered.state.port);
    rebound.close();
    for (const damage of ["{", "{}", JSON.stringify({ id: "wrong-identity", port: original.port })]) {
      writeFileSync(join(home, "endpoint.json"), damage);
      const restored = await start({ hasConsumers: async () => true });
      assert.equal(restored.state.id, repairedEntry.state.id);
      assert.equal(restored.state.pid, repairedEntry.state.pid);
      restored.close();
    }
    const watching = await start();
    unlinkSync(join(home, "endpoint.json"));
    unlinkSync(join(home, "endpoint.json.backup"));
    await waitFor(() => existsSync(join(home, "endpoint.json")), "watchdog repairs missing identity metadata from the live control endpoint");
    assert.equal(watching.state.id, repairedEntry.state.id);
    watching.close();

    const mismatchHome = join(temporary, "mismatch");
    const mismatchSocket = join(temporary, "mismatch.sock");
    mkdirSync(mismatchHome);
    const mismatchEndpoint = join(mismatchHome, "endpoint.json");
    const wrongIdentity = { ...original, id: "stored-identity", pid: process.pid,
      startedAt: processProof(process.pid).startedAt, socket: mismatchSocket };
    writeFileSync(mismatchEndpoint, JSON.stringify(wrongIdentity));
    const mismatched = await listen(createServer((incoming, outgoing) => {
      outgoing.end(JSON.stringify({ ...original, pid: process.pid, id: "unrelated-identity" }));
    }), mismatchSocket);
    const blockedIdentity = await start({ home: mismatchHome, socket: mismatchSocket, hasConsumers: async () => true });
    assert.equal(blockedIdentity.state, undefined);
    assert.match(blockedIdentity.warning, /identity changed/);
    blockedIdentity.close();
    assert.equal(JSON.parse(readFileSync(mismatchEndpoint, "utf8")).id, wrongIdentity.id);
    const freshIdentity = await start({ home: mismatchHome, socket: mismatchSocket });
    assert.equal(freshIdentity.state, undefined);
    assert.equal(JSON.parse(readFileSync(mismatchEndpoint, "utf8")).id, wrongIdentity.id);
    assert.equal(mismatched.listening, true);
    freshIdentity.close();
    await new Promise((done) => mismatched.close(done));
    console.log("✓ persisted process generations discover moved sockets, rebind deleted sockets, recover corrupt/deleted identities and isolate unrelated endpoints");

    const faultHome = join(temporary, "faults");
    const faultSocket = join(temporary, "faults.sock");
    let statusPayload;
    const faultyControl = await listen(createServer((incoming, outgoing) => outgoing.end(statusPayload)), faultSocket);
    const faults = [
      ["malformed response", "{"],
      ["missing identity", JSON.stringify({ ...original, id: "" })],
      ["invalid port", JSON.stringify({ ...original, port: 0 })],
      ["invalid pid", JSON.stringify({ ...original, pid: null })],
      ["unsupported protocol", JSON.stringify({ ...original, protocol: 99 })],
    ];
    for (const [label, payload] of faults) {
      statusPayload = payload;
      const withUsers = await start({ home: faultHome, socket: faultSocket, hasConsumers: async () => true });
      assert.equal(withUsers.state, undefined, label + " must only disable channels with live consumers");
      assert.ok(withUsers.warning);
      withUsers.close();
      await assert.rejects(withUsers.pause(), undefined, label + " must also be rejected on control paths");
      const noUsers = await start({ home: faultHome, socket: faultSocket });
      assert.equal(noUsers.state, undefined, label + " must not spawn a second writer beside an unverified live endpoint");
      noUsers.close();
      assert.equal(existsSync(join(faultHome, "endpoint.json")), false);
    }
    assert.equal(faultyControl.listening, true);
    await new Promise((done) => faultyControl.close(done));
    console.log("✓ every invalid live control identity/protocol/response degrades without adding a second writer, including pause control paths");

    let unrelatedRetires = 0;
    const unrelatedSocket = join(temporary, "unrelated.sock");
    const unrelated = await listen(createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      if (incoming.url === "/retire") unrelatedRetires++;
      outgoing.end(JSON.stringify({ ...original, pid: process.pid, build: "different-build" }));
    }), unrelatedSocket);
    const ownership = await start({ home: faultHome, socket: unrelatedSocket });
    assert.equal(ownership.state, undefined);
    assert.equal(existsSync(join(faultHome, "endpoint.json")), false);
    assert.equal(unrelatedRetires, 0, "neither upgrades nor recovery may retire a process without data-root ownership proof");
    assert.equal(unrelated.listening, true);
    ownership.close();
    await new Promise((done) => unrelated.close(done));

    const writerHome = join(temporary, "writer");
    const writerEndpoint = join(writerHome, "endpoint.json");
    const writerOptions = { home: writerHome, socket: join(temporary, "writer.sock"), idleMs: 1500, ...realConsumers };
    const priorWriter = await start(writerOptions);
    priorWriter.close();
    const priorState = { ...priorWriter.state };
    const priorBackend = await child();
    await gatewayRequest(priorWriter.socket, "/activate", { owner: INSTANCE_ID, port: options.port, pid: priorBackend.pid });
    const damaged = { ...JSON.parse(readFileSync(writerEndpoint, "utf8")), id: "damaged-" + priorState.id };
    replaceRuntimeRecord(writerEndpoint, readRuntimeRecord(writerEndpoint), damaged);
    const recovering = await start(writerOptions);
    assert.equal(recovering.state, undefined, "corrupted identity with a live unverified entry must not create a replacement writer");
    assert.match(recovering.warning, /identity changed/);
    assert.equal((await gatewayRequest(priorWriter.socket, "/status")).pid, priorState.pid);
    assert.equal(JSON.parse(readFileSync(writerEndpoint, "utf8")).id, damaged.id);
    await priorBackend.dispose();
    await waitFor(() => processProof(priorState.pid) === null, "unowned old entry safely exits when truly idle");
    assert.equal(JSON.parse(readFileSync(writerEndpoint, "utf8")).id, damaged.id, "old idle exit cannot resurrect its identity");
    await waitFor(() => recovering.state && recovering.state.pid !== priorState.pid, "watchdog recovers only after old writer actually exits");
    sockets.set(recovering.socket, INSTANCE_ID);
    const surviving = { ...recovering.state };
    assert.equal(surviving.id, damaged.id);
    const survivingConsumer = await child();
    consumer(survivingConsumer, surviving.id, "surviving-consumer");
    await new Promise((done) => setTimeout(done, 2200));
    assert.equal(recovering.state.id, surviving.id);
    assert.equal(recovering.state.pid, surviving.pid);
    assert.equal(JSON.parse(readFileSync(writerEndpoint, "utf8")).id, surviving.id);
    recovering.close();

    const staleHome = join(temporary, "stale");
    const staleWriter = await start({ home: staleHome, socket: join(temporary, "stale.sock") });
    staleWriter.close();
    const staleEndpoint = join(staleHome, "endpoint.json");
    const successor = JSON.parse(readFileSync(writerEndpoint, "utf8"));
    replaceRuntimeRecord(staleEndpoint, readRuntimeRecord(staleEndpoint), successor);
    const successorBytes = readRuntimeRecord(staleEndpoint);
    await gatewayRequest(staleWriter.socket, "/retire", { owner: INSTANCE_ID });
    await waitFor(() => processProof(staleWriter.state.pid) === null, "superseded explicit retirement exits without rewriting identity");
    assert.deepEqual(readRuntimeRecord(staleEndpoint), successorBytes);
    assert.equal((await gatewayRequest(recovering.socket, "/status")).pid, surviving.pid);

    const spare = await listen(createServer(), 0);
    const sparePort = spare.address().port;
    await new Promise((done) => spare.close(done));
    replaceRuntimeRecord(staleEndpoint, successorBytes, { ...successor, port: sparePort });
    const beforeClaim = readRuntimeRecord(staleEndpoint);
    const startupSocket = join(temporary, "claim.sock");
    const claimant = spawnTestFixture(node, [entry, startupSocket, staleEndpoint], { stdio: "ignore" });
    children.push(claimant);
    const [claimCode] = await once(claimant, "exit");
    assert.equal(claimCode, 1, "startup cannot take an identity still owned by a live generation, even on an available port");
    assert.deepEqual(readRuntimeRecord(staleEndpoint), beforeClaim);
    assert.equal(existsSync(startupSocket), false);
    await survivingConsumer.dispose();
    console.log("✓ all daemon writes are fenced: corrupt-record recovery never forks a live unknown writer; idle/explicit exit and rejected startup cannot overwrite a successor");

    const idleEntry = await start({ home: join(temporary, "idle"), socket: join(temporary, "idle.sock"), idleMs: 200, ...realConsumers });
    const idleState = { ...idleEntry.state };
    idleEntry.close();
    const marker = await child();
    const idleConsumer = await child();
    consumer(idleConsumer, idleState.id, "idle-consumer");
    await gatewayRequest(idleEntry.socket, "/activate", { owner: INSTANCE_ID, port: options.port, pid: marker.pid });
    const idleSend = (key, body = {}, signal = requests.signal) => fetch(`http://127.0.0.1:${idleState.port}/api/llm-providers/p/convert/v1/responses`, {
      method: "POST", body: JSON.stringify({ key, ...body }), signal,
    });
    await marker.dispose();
    await new Promise((done) => setTimeout(done, 500));
    assert.equal((await gatewayRequest(idleEntry.socket, "/status")).pid, idleState.pid, "a real consumer retains the entry while backend is gone");
    const idleStream = await idleSend("idle-stream", { hold: true });
    const idleReader = idleStream.body.getReader();
    await idleReader.read();
    await gatewayRequest(idleEntry.socket, "/pause", { owner: INSTANCE_ID });
    const idleAbort = new AbortController();
    const idleQueued = idleSend("idle-queued", {}, idleAbort.signal).catch(() => undefined);
    await waitFor(async () => (await gatewayRequest(idleEntry.socket, "/status")).queued === 1, "idle fixture request queues");
    await idleConsumer.dispose();
    await new Promise((done) => setTimeout(done, 500));
    assert.equal((await gatewayRequest(idleEntry.socket, "/status")).active, 1, "delivered stream retains the orphan entry");
    stream.end("last\n");
    while (!(await idleReader.read()).done) {}
    await new Promise((done) => setTimeout(done, 500));
    assert.equal((await gatewayRequest(idleEntry.socket, "/status")).queued, 1, "unforwarded queued work independently retains the orphan entry");
    idleAbort.abort();
    await idleQueued;
    await waitFor(() => !existsSync(idleEntry.socket), "idle entry retires after backend, consumers and pending requests disappear");
    const retired = JSON.parse(readFileSync(join(temporary, "idle/endpoint.json"), "utf8"));
    assert.equal(retired.retired, true);
    assert.equal(retired.reason, "idle");
    const restartedIdle = await start({ home: join(temporary, "idle"), socket: idleEntry.socket, ...realConsumers });
    assert.equal(restartedIdle.state.id, idleState.id);
    assert.equal(restartedIdle.state.port, idleState.port);
    restartedIdle.close();
    assert.equal(counts.get("idle-queued"), undefined, "aborted queues are not replayed after idle restart");
    console.log("✓ autonomous idle retirement uses actual generations and shared channel evidence, retains streams/queues and reopens the same identity");

    const unavailable = await initializeRuntimeGateway({ ...options, node: join(temporary, "missing-node") });
    controllers.push(unavailable);
    assert.equal(unavailable.state, undefined, "missing installation artifacts do not prevent service startup");
    unavailable.close();
    const guard = await runTestProcess("/bin/sh", ["-c", runtimeMonitorFallback()]);
    assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision, "deny", "Monitor fallback works independently of damaged gateway artifacts");

    const global = await initializeRuntimeGateway(options);
    controllers.push(global);
    global.close();
    const current = await gatewayRequest(global.socket, "/status");
    await stopDaemon(current);
    sockets.delete(global.socket);
    let resumeFails = true;
    const brokenControl = await listen(createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      outgoing.writeHead(incoming.url === "/resume" && resumeFails ? 500 : 200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(current));
    }), global.socket);
    const api = new Hono();
    mountRuntimeHandoff(api);
    const app = new Hono();
    app.use("*", runtimeDrainGate());
    app.route("/api", api);
    app.post("/api/projects", (context) => context.json({ executed: true }));
    app.post("/api/llm-providers/p/convert/v1/responses", (context) => context.json({ executed: true }));
    const http = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    servers.push(http);
    if (!http.listening) await once(http, "listening");
    const service = `http://127.0.0.1:${http.address().port}`;
    beginRuntimeDrain();
    sealRuntimeChannels();
    holdRuntimeDrain();
    let released = false;
    onRuntimeDrainEnd(() => { released = true; });
    const blocked = await fetch(service + "/api/projects", { method: "POST" });
    assert.equal(blocked.status, 503);
    await blocked.text();
    const headers = { [NAVI_HEADERS.hostToken]: liveLockToken(), [NAVI_HEADERS.instance]: INSTANCE_ID };
    const cancelled = await fetch(service + "/api/runtime-handoff", { method: "DELETE", headers });
    assert.equal(cancelled.status, 503);
    assert.match((await cancelled.json()).error, /已解封.*通道恢复失败/);
    assert.equal(runtimeDraining(), false);
    assert.equal(released, true);
    for (const path of ["/api/projects", "/api/llm-providers/p/convert/v1/responses"]) {
      const response = await fetch(service + path, { method: "POST" });
      assert.equal(response.status, 200, "local admission recovers even while the entry is unavailable");
      await response.text();
    }
    resumeFails = false;
    const retried = await fetch(service + "/api/runtime-handoff", { method: "DELETE", headers });
    assert.equal(retried.status, 200);
    await retried.text();
    await endRuntimeDrain();
    brokenControl.closeAllConnections();
    await new Promise((done) => brokenControl.close(done));
    sockets.delete(global.socket);
    console.log("✓ authenticated DELETE always releases an infinite local seal and consumer checkpoints; entry failure is explicit and retryable");
  }, [
    () => { for (const controller of controllers) controller.close(); requests.abort(); },
    async () => {
      for (const [path, owner] of sockets) {
        if (!existsSync(path)) continue;
        await waitFor(async () => {
          try { await gatewayRequest(path, "/retire", { owner }); return true; } catch { return false; }
        }, "owned gateway drains before retirement");
        await waitFor(() => !existsSync(path), "owned gateway retires before cleanup");
      }
    },
    () => lock?.release(),
    async () => { for (const fixture of children) await fixture.dispose(); },
    () => consumerDb.close(),
    () => direct.destroy(),
    async () => { for (const server of servers) { server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done)); } },
    () => rmSync(temporary, { recursive: true, force: true }),
  ]);
}
