import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { startCommand, stopCommand, restartCommand } from "../src/terminal-commands.js";
import { TerminalCapacity } from "../src/terminal-capacity.js";
import { processAlive } from "../src/terminal-process-tree.js";

const cwd = mkdtempSync(join(tmpdir(), "ash-stop-verification-"));
const manager = new TerminalSessionManager();
const pids: number[] = [];
const quote = (value: string) => process.platform === "win32" ? `"${value.replaceAll('"', '`"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const runNode = (...args: string[]) => `${process.platform === "win32" ? "& " : ""}${[process.execPath, ...args].map(quote).join(" ")}`;
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("stop verification fixture timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const noop = process.platform === "win32" ? "exit 0" : "true";
const launcher = join(cwd, "launcher.cjs");
const broker = join(cwd, "broker.cjs");
const daemon = join(cwd, "daemon.cjs");
writeFileSync(launcher, `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(broker)},process.argv[2]],{detached:true,stdio:'ignore'});child.unref();`);
writeFileSync(broker, `const fs=require('node:fs'),prefix=process.argv[2];const timer=setInterval(()=>{if(!fs.existsSync(prefix+'.gate'))return;clearInterval(timer);const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(daemon)},prefix],{detached:true,stdio:'ignore'});child.unref();},20);`);
writeFileSync(daemon, `require('node:fs').writeFileSync(process.argv[2]+'.pid',String(process.pid));setInterval(()=>{},1000);`);

try {
  for (const action of ["stop", "restart"] as const) {
    const projectId = `no-port-${action}`;
    const prefix = join(cwd, action);
    const command = { id: "service", name: action, command: runNode(launcher, prefix), stopCommand: noop, restartCommand: null };
    assert.equal((await startCommand(projectId, cwd, command)).status, 201);
    await waitFor(() => terminalSessions.listForProject(projectId)[0]?.exitCode === 0);
    writeFileSync(prefix + ".gate", "go");
    await waitFor(() => existsSync(prefix + ".pid") && terminalSessions.listForProject(projectId)[0]?.groupAlive === false);
    const pid = Number(readFileSync(prefix + ".pid", "utf8"));
    pids.push(pid);
    const original = terminalSessions.listForProject(projectId)[0];
    assert.deepEqual(original.ports, []);
    const result = action === "stop"
      ? await stopCommand(projectId, "service", { script: noop, cwd })
      : await restartCommand(projectId, cwd, { ...command, restartCommand: "exit 0" });
    assert.equal(result.status, action === "stop" ? 200 : 201);
    assert.match(String(result.body.notice), /没法确认是否停净/);
    assert.equal(processAlive(pid), true);
    assert.equal(terminalSessions.get(original.id)?.stop.kind, "unresolved");
    const fact = terminalSessions.get(original.id)!.stop;
    assert.ok(fact.kind === "unresolved" && !fact.complete);
    terminalSessions.sweepIdleSessions(Date.now() + 31 * 60 * 1000);
    assert.ok(terminalSessions.get(original.id));
  }

  const history = await manager.createAsync("history", cwd, { command: { id: "job", name: "history", script: "exit 0" } });
  await waitFor(() => manager.get(history.id)?.exitCode === 0);
  manager.markCommandStopped(history.id, "history", { kind: "unresolved", pids: [], complete: false, why: "enumeration incomplete" });
  assert.equal(manager.close(history.id), false);
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  const replacement = await manager.createAsync("history", cwd, { command: { id: "job", name: "new", script: "exit 0" } });
  await waitFor(() => manager.get(replacement.id)?.exitCode === 0);
  assert.ok(manager.get(history.id));
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 1);
  assert.ok(manager.get(history.id));
  assert.equal((await manager.destroy(history.id)).ok, true);
  assert.equal(manager.get(history.id), null);

  const sessions = [{ id: "old", projectId: "capacity", commandId: "job", retained: false }];
  const capacity = new TerminalCapacity(1, () => sessions, () => false, session => session.retained);
  const reservation = capacity.reserve("capacity", "job", true);
  capacity.begin(reservation);
  capacity.validate(reservation);
  sessions[0].retained = true;
  assert.throws(() => capacity.validate(reservation), /数量已达上限/);
  capacity.release(reservation);
  assert.equal(capacity.hasSlot("capacity", "job", true), false);
  assert.throws(() => capacity.reserve("capacity", "job", true), /数量已达上限/);
  console.log("stop verification passed: no-port stop/restart uncertainty, retained history, capacity accounting");
} finally {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  manager.shutdown();
  terminalSessions.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
