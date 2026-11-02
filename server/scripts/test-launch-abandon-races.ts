import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ash-abandon-races-")));
process.env.ASH_DB = join(temporary, "test.db");
const { terminalSessions } = await import("../src/terminal.js");
const { startCommand, stopCommand, restartCommand } = await import("../src/terminal-commands.js");
const { mountLaunchAbandonRoutes } = await import("../src/terminal-abandon.js");
const { withCommandLock } = await import("../src/terminal-management-lock.js");
const { dbClient } = await import("../src/db/index.js");
type Abandonment = import("../src/terminal.js").LaunchAbandonment;
const windows = process.platform === "win32";
const pids = new Set<number>();
const api = new Hono();
mountLaunchAbandonRoutes(api);

const record: Abandonment = {
  at: Date.now(), owedPids: [], taggedPids: [], ports: [], portState: "unavailable", notice: "test", left: "none",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(25);
  }
}

async function remainsPending<Value>(promise: Promise<Value>): Promise<void> {
  const outcome = await Promise.race([promise.then(() => "settled"), delay(100).then(() => "pending")]);
  assert.equal(outcome, "pending", "handover must not succeed while an earlier destructive action still owns the launch");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const quote = (value: string) => `'${value.replaceAll("'", windows ? "''" : "'\\''")}'`;
const node = (file: string, ...args: string[]) =>
  `${windows ? "& " : ""}${[process.execPath, file, ...args].map(quote).join(" ")}`;

const workerFile = join(temporary, "worker.cjs");
writeFileSync(workerFile, `
const fs = require("node:fs"), http = require("node:http");
const [state, term, port] = process.argv.slice(2);
process.on("SIGTERM", () => fs.appendFileSync(term, "TERM\\n"));
const server = http.createServer((_, response) => response.end("alive"));
server.listen(Number(port), "127.0.0.1", () => {
  fs.writeFileSync(state, JSON.stringify({ pid: process.pid, port: server.address().port }));
});
`);
const daemonFile = join(temporary, "daemon.cjs");
writeFileSync(daemonFile, `
const { spawn } = require("node:child_process");
const [worker, state, term, port] = process.argv.slice(2);
spawn(process.execPath, [worker, state, term, port], { detached: true, stdio: "ignore" }).unref();
console.log("http://127.0.0.1:" + port);
`);
const stopFile = join(temporary, "stop.cjs");
writeFileSync(stopFile, `
const fs = require("node:fs");
const [entered, release] = process.argv.slice(2);
fs.writeFileSync(entered, "entered");
setInterval(() => { if (fs.existsSync(release)) process.exit(1); }, 20);
`);

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function worker(label: string, detached = false) {
  const state = join(temporary, `${label}.json`);
  const term = join(temporary, `${label}.term`);
  const port = detached ? await freePort() : 0;
  const command = {
    id: "service", name: label, restartCommand: null, stopCommand: null,
    command: detached ? node(daemonFile, workerFile, state, term, String(port)) : node(workerFile, state, term, "0"),
  };
  assert.equal((await startCommand(label, temporary, command)).status, 201);
  const session = terminalSessions.listCommandSessions().find((info) => info.projectId === label)!;
  await waitFor(`${label} worker`, () => existsSync(state));
  const facts = JSON.parse(readFileSync(state, "utf8")) as { pid: number; port: number };
  pids.add(facts.pid);
  assert.ok(alive(facts.pid));
  if (detached) await waitFor("daemon launcher exit", () => terminalSessions.get(session.id, label)?.groupAlive === false);
  return { projectId: label, command, sessionId: session.id, term, ...facts };
}

type Worker = Awaited<ReturnType<typeof worker>>;
function abandon(target: Worker): Promise<Response> {
  return api.request(`/projects/${target.projectId}/commands/service/abandon`, {
    method: "POST", body: JSON.stringify({ sessionId: target.sessionId }),
    headers: { "content-type": "application/json" },
  });
}

async function serving(target: Worker): Promise<boolean> {
  return fetch(`http://127.0.0.1:${target.port}`, { signal: AbortSignal.timeout(1000) })
    .then(async (response) => await response.text() === "alive", () => false);
}

async function commandRace(kind: "stop" | "restart"): Promise<Worker> {
  const target = await worker(`${kind}-script`);
  const entered = join(temporary, `${kind}.entered`);
  const release = join(temporary, `${kind}.release`);
  const script = node(stopFile, entered, release);
  const action = kind === "stop"
    ? stopCommand(target.projectId, "service", { script, cwd: temporary, timeoutMs: 15_000 })
    : restartCommand(target.projectId, temporary, { ...target.command, stopCommand: script });
  await waitFor("stop script entered", () => existsSync(entered));
  const handover = abandon(target);
  try {
    await remainsPending(handover);
    assert.equal(await serving(target), true);
  } finally { writeFileSync(release, "release"); }
  assert.equal((await action).status, 502);
  assert.equal((await handover).status, 200);
  assert.equal(await serving(target), true, "failed stop leaves a live service for the user to adopt");
  const marker = join(temporary, `${kind}.unexpected`);
  const stopped = await stopCommand(target.projectId, "service", {
    script: node(stopFile, marker, release), cwd: temporary, timeoutMs: 1000,
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.stopped, false);
  assert.equal(existsSync(marker), false, "a queued stop cannot launch a script after handover");
  assert.equal((await terminalSessions.terminate(target.sessionId, target.projectId)).ok, true);
  assert.equal((await terminalSessions.destroy(target.sessionId, target.projectId)).ok, true);
  assert.equal(await serving(target), true, "terminate and deletion cannot kill an adopted service");
  console.log(`PASS: ${kind} script and handover serialize; later stop/terminate/delete leave the service alive`);
  return target;
}

try {
  const entered = deferred();
  const release = deferred();
  const owner = withCommandLock("lock", "service", async () => {
    await withCommandLock("lock", "service", async () => entered.resolve());
    await release.promise;
  });
  await entered.promise;
  const waiter = withCommandLock("lock", "service", async () => "waiter");
  await remainsPending(waiter);
  assert.equal(await withCommandLock("other", "service", async () => "independent"), "independent");
  release.resolve();
  await owner;
  assert.equal(await waiter, "waiter");
  await assert.rejects(withCommandLock("lock", "service", async () => { throw new Error("expected"); }), /expected/);
  assert.equal(await withCommandLock("lock", "service", async () => "recovered"), "recovered");

  const stale = deferred();
  let late!: Promise<string>;
  await withCommandLock("lock", "service", async () => {
    late = stale.promise.then(() => withCommandLock("lock", "service", async () => "late"));
  });
  const occupied = deferred();
  const blocked = withCommandLock("lock", "service", async () => { await occupied.promise; });
  stale.resolve();
  await remainsPending(late);
  occupied.resolve();
  await blocked;
  assert.equal(await late, "late");
  console.log("PASS: locks are reentrant, isolated, failure-safe, and reject expired inherited ownership");

  if (!windows) {
    const target = await worker("term-race");
    const stopping = terminalSessions.terminate(target.sessionId, target.projectId, { termMs: 600, killMs: 1000 });
    await waitFor("real TERM delivered", () => existsSync(target.term));
    const handover = terminalSessions.abandonLaunch(target.sessionId, target.projectId, async () => {
      assert.equal(await serving(target), false, "handover snapshot is taken after the active TERM/KILL action drains");
      return record;
    });
    await remainsPending(handover);
    assert.equal((await stopping).ok, true);
    assert.ok(await handover);
    assert.equal(await serving(target), false);
    console.log("PASS: handover cannot return success during the real TERM-to-KILL grace window");

    for (const action of ["stop", "delete"] as const) {
      const daemon = await worker(`port-${action}`, true);
      const stopping = action === "stop"
        ? stopCommand(daemon.projectId, "service", null, { portGraceMs: 600 })
        : terminalSessions.destroy(daemon.sessionId, daemon.projectId, { termMs: 100, killMs: 100 });
      await waitFor("real port cleanup TERM delivered", () => existsSync(daemon.term));
      const handover = abandon(daemon);
      await remainsPending(handover);
      await stopping;
      const response = await handover;
      assert.equal(response.status, action === "stop" ? 200 : 404);
      assert.equal(await serving(daemon), false, "port cleanup must finish before handover succeeds or the record disappears");
      console.log(`PASS: ${action} port cleanup drains before handover; HTTP ${response.status}`);
    }
  } else console.log("SKIP: POSIX TERM grace and detached port cleanup are not enabled on Windows");

  const inverse = await worker("handover-first");
  const snapshotEntered = deferred();
  const snapshotRelease = deferred();
  const handover = terminalSessions.abandonLaunch(inverse.sessionId, inverse.projectId, async () => {
    snapshotEntered.resolve();
    await snapshotRelease.promise;
    return record;
  });
  await snapshotEntered.promise;
  const stopping = terminalSessions.terminate(inverse.sessionId, inverse.projectId, { termMs: 50, killMs: 50 });
  const deleting = terminalSessions.destroy(inverse.sessionId, inverse.projectId, { termMs: 50, killMs: 50 });
  const commandStop = stopCommand(inverse.projectId, "service");
  try { await remainsPending(stopping); }
  finally { snapshotRelease.resolve(); }
  assert.ok(await handover);
  assert.equal((await stopping).ok, true);
  assert.equal((await deleting).ok, true);
  assert.equal((await commandStop).status, 200);
  assert.equal(await serving(inverse), true);
  assert.equal(existsSync(inverse.term), false, "no queued TERM, freeze, or KILL may run after handover");
  console.log("PASS: handover holds both permissions until commit; queued destructive actions cannot signal the adopted service");

  const staleTarget = await worker("stale-launch");
  const old = staleTarget.sessionId;
  await terminalSessions.abandonLaunch(old, staleTarget.projectId, record);
  const commandEntered = deferred();
  const commandRelease = deferred();
  const starting = withCommandLock(staleTarget.projectId, "service", async () => {
    commandEntered.resolve();
    await commandRelease.promise;
    return startCommand(staleTarget.projectId, temporary, staleTarget.command);
  });
  await commandEntered.promise;
  const stalePost = abandon(staleTarget);
  await remainsPending(stalePost);
  commandRelease.resolve();
  assert.equal((await starting).status, 201);
  assert.equal((await stalePost).status, 404, "queued confirmation cannot adopt a replacement launch");
  const replacement = terminalSessions.liveCommandSession(staleTarget.projectId, "service")!;
  assert.notEqual(replacement.id, old);
  assert.equal(replacement.abandoned, null);
  await waitFor("replacement worker", () => {
    const facts = JSON.parse(readFileSync(join(temporary, "stale-launch.json"), "utf8")) as { pid: number };
    if (facts.pid === staleTarget.pid) return false;
    pids.add(facts.pid);
    return true;
  });
  console.log("PASS: session identity is checked after waiting for start/restart serialization");

  const stopSurvivor = await commandRace("stop");
  const restartSurvivor = await commandRace("restart");
  const retained = await worker("shutdown-adopted");
  assert.equal((await abandon(retained)).status, 200);
  assert.ok(terminalSessions.get(retained.sessionId, retained.projectId)?.abandoned);
  terminalSessions.shutdown();
  assert.equal(await serving(stopSurvivor), true);
  assert.equal(await serving(restartSurvivor), true);
  assert.equal(await serving(inverse), true);
  assert.equal(await serving(staleTarget), true);
  assert.equal(await serving(retained), true, "shutdown cannot signal an adopted service whose record is still retained");
  console.log("PASS: shutdown still leaves all explicitly adopted services alive");
} finally {
  terminalSessions.shutdown();
  for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
  await delay(200);
  dbClient.close();
  rmSync(temporary, { recursive: true, force: true });
}

console.log("test-launch-abandon-races: all assertions passed");
