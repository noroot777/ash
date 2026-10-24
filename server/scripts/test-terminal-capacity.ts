import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalCapacity } from "../src/terminal-capacity.js";

const records = new Map([
  ["old", { id: "old", projectId: "allocator", commandId: "keep", alive: true }],
  ["other", { id: "other", projectId: "allocator", commandId: "other", alive: true }],
]);
const capacity = new TerminalCapacity(2, () => records.values(), (session) => session.alive);
assert.equal(capacity.hasSlot("allocator", "keep"), false);
assert.equal(capacity.hasSlot("allocator", "keep", true), true);
assert.equal(capacity.hasSlot("another-project", "keep", true), false);
const replacement = capacity.reserve("allocator", "keep", true);
assert.throws(() => capacity.reserve("allocator", "keep", true), /终端会话数量已达上限/);
assert.throws(() => capacity.reserve("allocator", "new"), /终端会话数量已达上限/);
records.delete("old");
assert.equal(capacity.hasSlot("allocator", "new"), false);
capacity.begin(replacement);
capacity.validate(replacement);
assert.throws(() => capacity.begin(replacement), /预留已失效/);
assert.equal(capacity.hasSlot("allocator", "new"), false);
capacity.release(replacement);
assert.throws(() => capacity.validate(replacement), /预留已失效/);
assert.equal(capacity.hasSlot("allocator", "new"), true);
const unused = capacity.reserve("allocator", "unused");
capacity.release(unused);
assert.throws(() => capacity.begin(unused), /预留已失效/);
records.set("old", { id: "old", projectId: "allocator", commandId: "keep", alive: false });
assert.equal(capacity.hasSlot("allocator", "keep"), true);
const staleReplacement = capacity.reserve("allocator", "keep");
assert.equal(capacity.hasSlot("allocator", "new"), false);
capacity.release(staleReplacement);
console.log("terminal capacity allocator passed: shared counts, unique replacement credit, reservations, cancellation");

const duplicateRecords = new Map([
  ["old-a", { id: "old-a", projectId: "duplicates", commandId: "same", alive: false }],
  ["old-b", { id: "old-b", projectId: "duplicates", commandId: "same", alive: false }],
  ["other", { id: "other", projectId: "duplicates", commandId: "other", alive: true }],
]);
const duplicateCapacity = new TerminalCapacity(3, () => duplicateRecords.values(), (session) => session.alive);
for (const started of [false, true]) {
  const reserved = duplicateCapacity.reserve("duplicates", "same");
  assert.equal(reserved.replacedSessionIds.size, 2);
  assert.equal(duplicateCapacity.hasSlot("duplicates", "unrelated"), false,
    "pending replacement must not release extra old records before it commits");
  assert.throws(() => duplicateCapacity.reserve("duplicates", "unrelated"), /终端会话数量已达上限/);
  if (started) duplicateCapacity.begin(reserved);
  duplicateCapacity.release(reserved);
  assert.equal(duplicateRecords.size, 3);
  assert.equal(duplicateCapacity.hasSlot("duplicates", "unrelated"), false);
}
const committed = duplicateCapacity.reserve("duplicates", "same");
duplicateCapacity.begin(committed);
duplicateCapacity.validate(committed);
duplicateRecords.delete("old-a");
duplicateRecords.delete("old-b");
duplicateRecords.set("replacement", { id: "replacement", projectId: "duplicates", commandId: "same", alive: true });
duplicateCapacity.release(committed);
assert.equal(duplicateCapacity.hasSlot("duplicates", "unrelated"), true,
  "extra old records become available only after replacement commits");
console.log("terminal duplicate-record capacity passed: cancellation, startup failure, committed reclamation");

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ash-terminal-capacity-")));
const previousDb = process.env.ASH_DB;
process.env.ASH_DB = join(temporary, "test.db");
const { terminalSessions: manager } = await import("../src/terminal.js");
const { startCommand, restartCommand, stopCommand } = await import("../src/terminal-commands.js");
const { dbClient } = await import("../src/db/index.js");
const projectId = "terminal-capacity";
const windows = process.platform === "win32";
const keepAlive = windows ? "Start-Sleep -Seconds 120" : "sleep 120";
const command = { id: "keep", name: "keep", command: keepAlive, restartCommand: null };

async function waitExit(sessionId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (manager.get(sessionId, projectId)?.exitCode === null) {
    assert.ok(Date.now() < deadline, "short command did not exit");
    await delay(25);
  }
  assert.equal(manager.get(sessionId, projectId)?.exitCode, 0);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

try {
  for (let index = 0; index < 15; index++) {
    const marker = "CAPACITY_" + index;
    const session = await manager.createAsync(projectId, temporary, {
      command: { id: "done-" + index, name: marker, script: windows ? "Write-Output " + marker : "printf " + marker },
    });
    await waitExit(session.id);
    const output = manager.eventsAfter(session.id, projectId, 0)
      ?.map((event) => event.type === "data" ? event.data : "").join("") ?? "";
    assert.ok(output.includes(marker));
  }
  assert.equal((await startCommand(projectId, temporary, command)).status, 201);
  assert.equal(manager.listForProject(projectId).length, 16);
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = manager.liveCommandSession(projectId, command.id)!;
    assert.ok(manager.subscribe(previous.id, projectId, () => {}));
    assert.equal((await restartCommand(projectId, temporary, command)).status, 201,
      "restart must replace its own record even when all sixteen slots are occupied");
    assert.notEqual(manager.liveCommandSession(projectId, command.id)?.id, previous.id);
    assert.equal(manager.listForProject(projectId).length, 16);
    assert.deepEqual((await stopCommand(projectId, command.id)).body, { stopped: true });
    assert.equal((await startCommand(projectId, temporary, command)).status, 201,
      "start must reclaim its own stopped record at capacity");
    assert.equal(manager.listForProject(projectId).length, 16);
  }

  const terminate = manager.terminate.bind(manager);
  const beforeFailure = manager.liveCommandSession(projectId, command.id)!;
  manager.terminate = async () => ({ ok: false, reason: "injected stop failure" });
  try {
    assert.equal((await restartCommand(projectId, temporary, command)).status, 502);
    assert.equal(manager.liveCommandSession(projectId, command.id)?.id, beforeFailure.id);
    assert.equal(manager.hasSlotForCommand(projectId, command.id), true,
      "failed termination must release the replacement reservation without stopping the service");
  } finally { manager.terminate = terminate; }

  const oldSession = manager.liveCommandSession(projectId, command.id)!;
  const oldStopped = deferred();
  const resumeRestart = deferred();
  manager.terminate = async (...args: Parameters<typeof manager.terminate>) => {
    const result = await terminate(...args);
    if (args[0] === oldSession.id) {
      oldStopped.resolve();
      await resumeRestart.promise;
    }
    return result;
  };
  const restarting = restartCommand(projectId, temporary, command);
  try {
    await Promise.race([
      oldStopped.promise,
      delay(15_000, undefined, { ref: false }).then(() => { throw new Error("restart did not stop its old session"); }),
    ]);
    assert.equal(manager.liveCommandSession(projectId, command.id), null);
    assert.equal(manager.hasSlotForCommand(projectId, "unrelated"), false);
    assert.equal((await startCommand(projectId, temporary, { ...command, id: "unrelated" })).status, 500,
      "another command must not steal a reserved replacement slot");
    await assert.rejects(manager.createAsync(projectId, temporary), /终端会话数量已达上限/);
    resumeRestart.resolve();
    assert.equal((await restarting).status, 201);
    assert.equal(manager.listForProject(projectId).length, 16);
  } finally {
    resumeRestart.resolve();
    await restarting;
    manager.terminate = terminate;
  }

  const firstRecord = manager.listForProject(projectId).find((session) => session.commandId === "done-0")!;
  assert.deepEqual(await manager.destroy(firstRecord.id, projectId), { ok: true });
  const cancelled = manager.reserveCommand(projectId, "cancelled");
  assert.equal(manager.hasSlotForCommand(projectId, "extra"), false);
  cancelled.release();
  assert.equal(manager.hasSlotForCommand(projectId, "extra"), true);
  await assert.rejects(cancelled.create(temporary, { name: "cancelled", script: keepAlive }), /预留已失效/);
  const pending = manager.createAsync(projectId, temporary, {
    command: { id: "pending", name: "pending", script: keepAlive },
  });
  if (windows) {
    assert.equal(manager.listForProject(projectId).length, 15);
    assert.equal(manager.hasSlotForCommand(projectId, "extra"), false,
      "in-flight Windows startup must occupy the remaining slot before registration");
    assert.equal((await startCommand(projectId, temporary, { ...command, id: "extra" })).status, 500);
    assert.equal((await restartCommand(projectId, temporary, { ...command, id: "extra" })).status, 500);
    await assert.rejects(manager.createAsync(projectId, temporary), /终端会话数量已达上限/);
  }
  await pending;
  assert.equal(manager.listForProject(projectId).length, 16);
  assert.deepEqual((await stopCommand(projectId, "pending")).body, { stopped: true });
  assert.equal((await startCommand(projectId, temporary, { ...command, id: "pending" })).status, 201);
  assert.equal(manager.listForProject(projectId).length, 16);
  const surviving = manager.liveCommandSession(projectId, command.id)!;
  assert.equal((await restartCommand(projectId, temporary, { ...command, id: "extra" })).status, 500);
  assert.equal(manager.liveCommandSession(projectId, command.id)?.id, surviving.id);

  const secondRecord = manager.listForProject(projectId).find((session) => session.commandId === "done-1")!;
  assert.deepEqual(await manager.destroy(secondRecord.id, projectId), { ok: true });
  await assert.rejects(manager.createAsync(projectId, temporary, { shell: join(temporary, "missing-shell.exe") }));
  assert.equal(manager.hasSlotForCommand(projectId, "after-failure"), true,
    "failed startup must release its reserved slot");
  assert.equal((await startCommand(projectId, temporary, { ...command, id: "after-failure" })).status, 201);
  assert.equal(manager.listForProject(projectId).length, 16);

  for (const commandId of ["done-2", "done-3"]) {
    const record = manager.listForProject(projectId).find((session) => session.commandId === commandId)!;
    assert.deepEqual(await manager.destroy(record.id, projectId), { ok: true });
  }
  const duplicateCommand = { ...command, id: "duplicates" };
  const duplicateSessions = [];
  for (let index = 0; index < 2; index++) {
    duplicateSessions.push(await manager.createAsync(projectId, temporary, {
      command: { id: duplicateCommand.id, name: duplicateCommand.name, script: keepAlive },
    }));
  }
  for (const session of duplicateSessions) assert.deepEqual(await manager.terminate(session.id, projectId), { ok: true });
  assert.equal(manager.listForProject(projectId).length, 16);
  const duplicateReservation = manager.reserveCommand(projectId, duplicateCommand.id);
  try {
    assert.equal((await startCommand(projectId, temporary, { ...command, id: "unrelated-duplicate" })).status, 500);
    await assert.rejects(manager.createAsync(projectId, temporary), /终端会话数量已达上限/);
  } finally { duplicateReservation.release(); }
  assert.equal(manager.listForProject(projectId).length, 16);
  assert.equal(manager.hasSlotForCommand(projectId, "unrelated-duplicate"), false);
  if (windows) {
    await assert.rejects(manager.createAsync(projectId, join(temporary, "missing-directory"), {
      command: { id: duplicateCommand.id, name: duplicateCommand.name, script: keepAlive },
    }));
    assert.equal(manager.listForProject(projectId).length, 16);
    assert.equal(manager.hasSlotForCommand(projectId, "unrelated-duplicate"), false);
  }
  assert.equal((await startCommand(projectId, temporary, duplicateCommand)).status, 201);
  assert.equal(manager.listForProject(projectId).length, 15);
  assert.equal((await startCommand(projectId, temporary, { ...command, id: "unrelated-duplicate" })).status, 201);
  assert.equal(manager.listForProject(projectId).length, 16);
  console.log("terminal duplicate-record capacity passed with real processes: no early credits, safe cancel/failure, committed reclamation");
  console.log("terminal capacity passed: full start/restart, reserved replacement, pending startup, full rejection, failed-start release");
} finally {
  await manager.destroyProject(projectId);
  manager.shutdown();
  dbClient.close();
  if (previousDb === undefined) delete process.env.ASH_DB;
  else process.env.ASH_DB = previousDb;
  await delay(250);
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
