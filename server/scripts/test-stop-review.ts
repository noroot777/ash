import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { startCommand, stopCommand } from "../src/terminal-commands.js";
import { PORT_TIER_AVAILABLE, stopByPorts, stopByPortsSync } from "../src/service-ports.js";
import { readLineage } from "../src/service-ports-probe.js";

const cwd = mkdtempSync(join(tmpdir(), "ash-stop-review-"));
const manager = new TerminalSessionManager();
let listener: ReturnType<typeof spawn> | undefined;
let listenerExited: Promise<unknown> | undefined;
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("stop review fixture timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

try {
  if (process.platform === "win32" || !PORT_TIER_AVAILABLE) {
    console.log("stop review POSIX probes unavailable");
  } else {
    const first = manager.create("target", cwd, { command: { id: "first", name: "first", script: "exit 0" } });
    await waitFor(() => manager.get(first.id)?.exitCode !== null);
    const second = manager.create("target", cwd, { command: { id: "second", name: "second", script: "exit 0" } });
    await waitFor(() => manager.get(second.id)?.exitCode !== null);
    manager.markCommandStopped(first.id, "target", { kind: "verified" });
    assert.equal(manager.get(first.id)?.stop.kind, "verified");
    assert.equal(manager.get(second.id)?.stop.kind, "none");
    manager.recordCommandPortState(second.id, "target", "unknown");
    assert.equal(manager.get(second.id)?.running, true);
    assert.equal(manager.get(second.id)?.portUncertain, true);
    assert.equal(manager.get(second.id)?.portsAlive, false);
    manager.recordCommandPortState(second.id, "target", "free");
    assert.equal(manager.get(second.id)?.running, false);

    const unknown = await stopByPorts([16384], { launchToken: "test" }, async () => ({ ok: false, pids: [], why: "injected lsof failure" }));
    assert.deepEqual(unknown.unknown, [16384]);
    assert.equal(unknown.membersIncomplete, true);

    const script = join(cwd, "listener.cjs");
    const portFile = join(cwd, "listener.port");
    writeFileSync(script, `require("node:http").createServer((request,response)=>response.end("fixture")).listen(0,"127.0.0.1",function(){require("node:fs").writeFileSync(process.argv[2],String(this.address().port))});`);
    listener = spawn(process.execPath, [script, portFile], { detached: true, stdio: "ignore", env: {} });
    listenerExited = once(listener, "exit");
    const pid = listener.pid!;
    await waitFor(() => { try { return Number(readFileSync(portFile, "utf8")) > 0; } catch { return false; } });
    const port = Number(readFileSync(portFile, "utf8"));
    const lineage = (await readLineage([pid], "test")).get(pid);
    const swept = stopByPortsSync([port], "test");
    assert.equal(swept.killed.length, 0);
    assert.ok(swept.spared.includes(pid));
    if (lineage === "unknown" || lineage === "unverified") {
      assert.ok(swept.leftovers.includes(pid));
      assert.equal(swept.membersIncomplete, true);
      const command = { id: "service", name: "service", command: `echo http://127.0.0.1:${port}`, restartCommand: null, stopCommand: null };
      const started = await startCommand("uncertain", cwd, command);
      assert.equal(started.status, 201);
      await waitFor(() => terminalSessions.listCommandSessions().find(item => item.projectId === "uncertain")?.exitCode !== null);
      assert.equal((await startCommand("uncertain", cwd, command)).status, 200);
      const open = terminalSessions.listCommandSessions().find(item => item.projectId === "uncertain")!;
      assert.equal(open.running, true);
      assert.equal(open.portUncertain, true);
      assert.equal((await stopCommand("uncertain", "service", { script: "true", cwd })).status, 502);
      const stopped = await stopCommand("uncertain", "service", { script: `kill -9 ${pid}`, cwd });
      assert.equal(stopped.status, 200);
      await listenerExited;
      assert.equal((await startCommand("uncertain", cwd, command)).status, 201);
      await waitFor(() => terminalSessions.listCommandSessions().filter(item => item.projectId === "uncertain").every(item => item.exitCode !== null));
      assert.equal((await terminalSessions.destroyProject("uncertain")).ok, true);
    } else {
      assert.equal(lineage, "stranger");
      assert.deepEqual(swept.leftovers, []);
      assert.equal(swept.membersIncomplete, false);
    }
    console.log("stop review passed: exact session, uncertain DTO, query handoff, sync ownership, real stop escape");
  }
} finally {
  listener?.kill("SIGKILL");
  if (listenerExited) await listenerExited;
  manager.shutdown();
  terminalSessions.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
