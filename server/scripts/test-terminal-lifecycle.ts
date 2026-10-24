import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ash-terminal-lifecycle-")));
const previousDb = process.env.ASH_DB;
process.env.ASH_DB = join(temporary, "test.db");
const { TerminalSessionManager, terminalSessions } = await import("../src/terminal.js");
const { spawnWindowsPty } = await import("../src/terminal-pty.js");
const { startCommand, restartCommand } = await import("../src/terminal-commands.js");
const { dbClient } = await import("../src/db/index.js");
const windows = process.platform === "win32";
const keepAlive = windows ? "Start-Sleep -Seconds 120" : "sleep 120";
const managers: InstanceType<typeof TerminalSessionManager>[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  return Promise.race([
    promise,
    delay(15_000, undefined, { ref: false }).then(() => { throw new Error(label + " timed out"); }),
  ]);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, "worker did not start");
    await delay(25);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function restartAcrossLifecycle(scenario: "closing" | "deleted" | "rollback" | "shutdown"): Promise<void> {
  const projectId = "restart-" + scenario;
  const marker = join(temporary, projectId + ".txt");
  const escaped = marker.replaceAll("'", "''");
  const command = {
    id: "service", name: "service", command: keepAlive,
    restartCommand: windows ? `[IO.File]::WriteAllText('${escaped}', 'INVALID')` : `printf INVALID > '${escaped}'`,
  };
  const stopped = deferred();
  const resume = deferred();
  const terminate = terminalSessions.terminate.bind(terminalSessions);
  let restarting: ReturnType<typeof restartCommand> | undefined;
  let intercepted = false;
  try {
    assert.equal((await startCommand(projectId, temporary, command)).status, 201);
    const previous = terminalSessions.liveCommandSession(projectId, command.id)!;
    terminalSessions.terminate = async (...args: Parameters<typeof terminate>) => {
      const result = await terminate(...args);
      if (args[0] === previous.id && !intercepted) {
        intercepted = true;
        stopped.resolve();
        await resume.promise;
      }
      return result;
    };
    restarting = restartCommand(projectId, temporary, command);
    await within(stopped.promise, "restart termination");
    if (scenario === "shutdown") terminalSessions.shutdown();
    else {
      terminalSessions.beginProjectShutdown(projectId);
      assert.deepEqual(await terminalSessions.destroyProject(projectId), { ok: true });
      if (scenario !== "closing") terminalSessions.endProjectShutdown(projectId, scenario === "deleted");
    }
    resume.resolve();
    await delay(0);
    if (windows) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
    const result = await within(restarting, "late restart");
    assert.equal(result.status, 500);
    assert.equal(existsSync(marker), false, "invalidated restart executed after " + scenario);
    assert.equal(terminalSessions.listForProject(projectId).length, 0);
    if (scenario === "rollback") assert.equal((await startCommand(projectId, temporary, command)).status, 201);
    console.log("terminal lifecycle restart passed: " + scenario);
  } finally {
    resume.resolve();
    if (restarting) await restarting;
    terminalSessions.terminate = terminate;
    await terminalSessions.destroyProject(projectId);
    terminalSessions.endProjectShutdown(projectId, scenario === "deleted");
  }
}

async function unconsumedReservation(): Promise<void> {
  let launches = 0;
  const manager = new TerminalSessionManager({
    windowsPty: async () => { launches++; throw new Error("unexpected worker startup"); },
  });
  managers.push(manager);
  const reservations = Array.from({ length: 16 }, (_, index) => manager.reserveCommand("cancelled", String(index)));
  manager.beginProjectShutdown("cancelled");
  manager.endProjectShutdown("cancelled");
  for (const reservation of reservations) {
    await assert.rejects(reservation.create(temporary, { name: "cancelled", script: keepAlive }), /删除|失效|取消/);
  }
  const replacements = Array.from({ length: 16 }, (_, index) => manager.reserveCommand("available", String(index)));
  for (const reservation of replacements) reservation.release();
  assert.equal(launches, 0);
  manager.shutdown();
}

async function pendingWorker(scenario: "delete" | "shutdown"): Promise<void> {
  const marker = join(temporary, "pending-" + scenario + ".txt");
  const identity = join(temporary, "pending-" + scenario + ".json");
  const worker = join(temporary, "pending-" + scenario + ".mjs");
  const childScript = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'INVALID'),1500);setInterval(()=>{},1000);`;
  writeFileSync(worker, `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';
process.on('message',()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{windowsHide:true,stdio:'ignore'});writeFileSync(${JSON.stringify(identity)},JSON.stringify({worker:process.pid,child:child.pid}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(spawnWindowsPty("unused", [], { cwd: temporary }, {
    worker: pathToFileURL(worker), signal: cancelled.signal,
  }), /取消/);
  assert.equal(existsSync(identity), false, "already-cancelled startup spawned a worker");
  const manager = new TerminalSessionManager({
    windowsPty: (file, args, options, startup) => spawnWindowsPty(file, args, options, { ...startup, worker: pathToFileURL(worker) }),
  });
  managers.push(manager);
  const projectId = "pending-" + scenario;
  const creating = manager.createAsync(projectId, temporary, scenario === "delete" ? {} : {
    command: { id: "service", name: "service", script: keepAlive },
  });
  const rejected = assert.rejects(creating, /取消|删除/);
  await waitForFile(identity);
  const pids = JSON.parse(readFileSync(identity, "utf8")) as { worker: number; child: number };
  assert.ok(alive(pids.worker));
  assert.ok(alive(pids.child));
  if (scenario === "delete") {
    manager.beginProjectShutdown(projectId);
    assert.deepEqual(await within(manager.destroyProject(projectId), "pending worker deletion"), { ok: true });
    manager.endProjectShutdown(projectId, true);
  } else manager.shutdown();
  assert.equal(alive(pids.worker), false, "shutdown returned before the pending worker stopped");
  assert.equal(alive(pids.child), false, "pending worker descendant survived cancellation");
  await within(rejected, "pending cancellation");
  await delay(1700);
  assert.equal(existsSync(marker), false);
  assert.equal(manager.listForProject(projectId).length, 0);
  manager.shutdown();
  console.log("terminal lifecycle pending worker passed: " + scenario);
}

async function readyWorker(scenario: "delete" | "shutdown"): Promise<void> {
  const ready = deferred();
  const resume = deferred();
  let terminalPid = 0;
  const manager = new TerminalSessionManager({
    windowsPty: async (...args) => {
      const handle = await spawnWindowsPty(...args);
      terminalPid = handle.pid;
      ready.resolve();
      await resume.promise;
      return handle;
    },
  });
  managers.push(manager);
  const projectId = "ready-" + scenario;
  const creating = manager.createAsync(projectId, temporary, scenario === "shutdown" ? {} : {
    command: { id: "service", name: "service", script: keepAlive },
  });
  const rejected = assert.rejects(creating, /取消|删除/);
  try {
    await within(ready.promise, "native PTY readiness");
    assert.ok(alive(terminalPid));
    let deleted = false;
    let deletion: ReturnType<typeof manager.destroyProject> | undefined;
    if (scenario === "delete") {
      manager.beginProjectShutdown(projectId);
      deletion = manager.destroyProject(projectId).then((result) => { deleted = true; return result; });
      await delay(25);
      assert.equal(deleted, false, "project deletion must drain the in-flight creation");
    } else manager.shutdown();
    assert.equal(alive(terminalPid), false, "unregistered native PTY survived lifecycle invalidation");
    resume.resolve();
    if (deletion) {
      assert.deepEqual(await within(deletion, "ready worker deletion"), { ok: true });
      manager.endProjectShutdown(projectId, true);
    }
    await within(rejected, "ready cancellation");
    assert.equal(manager.listForProject(projectId).length, 0);
    console.log("terminal lifecycle ready native worker passed: " + scenario);
  } finally {
    resume.resolve();
    await rejected;
    manager.shutdown();
  }
}

try {
  await restartAcrossLifecycle("deleted");
  await restartAcrossLifecycle("closing");
  await restartAcrossLifecycle("rollback");
  await unconsumedReservation();
  if (windows) {
    await pendingWorker("delete");
    await pendingWorker("shutdown");
    await readyWorker("delete");
    await readyWorker("shutdown");
  }
  await restartAcrossLifecycle("shutdown");
  console.log("terminal lifecycle passed: invalidated reservations, rollback, pending cancellation and shutdown");
} finally {
  for (const manager of managers) manager.shutdown();
  terminalSessions.shutdown();
  dbClient.close();
  if (previousDb === undefined) delete process.env.ASH_DB;
  else process.env.ASH_DB = previousDb;
  await delay(250);
  const location = relative(realpathSync(tmpdir()), temporary);
  assert.ok(location && !location.startsWith("..") && !isAbsolute(location));
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
