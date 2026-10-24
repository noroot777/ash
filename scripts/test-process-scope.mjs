import { spawn, spawnSync, execFile } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const windows = process.platform === "win32";
const registerPath = fileURLToPath(new URL("test-process-register.cjs", import.meta.url));
const cleanupPath = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
const scopes = new Set();
export const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function command(file, args) {
  return (await execute(file, args, { encoding: "utf8", timeout: 4_000, killSignal: "SIGKILL", windowsHide: true })).stdout;
}

async function processRows() {
  if (windows) {
    const script = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object {
      @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; born=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }
    }); [Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress))`;
    return JSON.parse(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]));
  }
  const output = await command("ps", ["-axo", "pid=,ppid=,pgid=,stat="]);
  return output.trim().split("\n").map((line) => {
    const [pid, ppid, group, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), group: Number(group), state };
  }).filter((row) => !row.state.startsWith("Z"));
}

export class TestProcessScope {
  constructor(directory = mkdtempSync(join(tmpdir(), "ash-test-scope-"))) {
    this.directory = directory;
    this.started = Number(readFileSyncSafe(join(directory, "started"))) || Date.now();
    writeFileSync(join(directory, "started"), String(this.started));
    this.children = [];
    scopes.add(this);
  }

  spawn(commandName, args, options = {}) {
    const environment = options.env ?? process.env;
    const child = spawn(commandName, args, {
      ...options, detached: !windows, windowsHide: true,
      env: { ...environment, ASH_TEST_PROCESS_SCOPE: this.directory,
        NODE_OPTIONS: `--require ${JSON.stringify(registerPath)} ${environment.NODE_OPTIONS ?? ""}`.trim() },
    });
    child.on("error", () => {});
    this.children.push(child);
    if (child.pid) {
      const pending = join(this.directory, `${child.pid}.pending`);
      writeFileSync(pending, JSON.stringify({ pid: child.pid, at: Date.now(), script: "" }));
      try { linkSync(pending, join(this.directory, `${child.pid}.json`)); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      finally { rmSync(pending, { force: true }); }
      writeFileSync(join(this.directory, `${child.pid}.root`), "");
    }
    return child;
  }

  records() {
    return readdirSync(this.directory).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(this.directory, name), "utf8")));
  }

  async active() {
    const rows = await processRows();
    const records = this.records();
    const owned = new Set();
    const groups = new Set(readdirSync(this.directory).filter((name) => name.endsWith(".root")).map(Number.parseFloat));
    for (const record of records) {
      const row = rows.find((entry) => entry.pid === record.pid);
      if (!row || (windows && (row.born > record.at || row.born < this.started - 1_000))) continue;
      if (!existsSync(join(this.directory, `${record.pid}.exited`))) owned.add(record.pid);
    }
    if (!windows) for (const row of rows) if (groups.has(row.group)) owned.add(row.pid);
    let changed = true;
    const ancestors = new Set([...owned, ...records.filter((record) => !rows.some((row) => row.pid === record.pid)).map((record) => record.pid)]);
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!ancestors.has(row.ppid) || ancestors.has(row.pid) || (windows && row.born < this.started)) continue;
        ancestors.add(row.pid); owned.add(row.pid); changed = true;
      }
    }
    return rows.filter((row) => owned.has(row.pid));
  }

  async stop() {
    writeFileSync(join(this.directory, "stopped"), "");
    for (const child of this.children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      if (windows) {
        try { await command("taskkill", ["/PID", String(child.pid), "/T", "/F"]); }
        catch (error) { if (!Number.isInteger(error.code)) throw error; }
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
      }
    }
    let active = await this.active();
    if (!windows) {
      const groups = readdirSync(this.directory).filter((name) => name.endsWith(".root")).map(Number.parseFloat);
      for (const group of groups) try { process.kill(-group, "SIGTERM"); } catch {}
      for (const row of active) try { process.kill(row.pid, "SIGTERM"); } catch {}
      await delay(100);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      active = await this.active();
      if (!active.length) return;
      if (windows) {
        for (const row of active) {
          try { await command("taskkill", ["/PID", String(row.pid), "/T", "/F"]); }
          catch (error) { if (!Number.isInteger(error.code)) throw error; }
        }
      } else {
        for (const row of active) try { process.kill(row.pid, "SIGKILL"); } catch {}
      }
      await delay(50);
    }
    active = await this.active();
    if (active.length) throw new Error(`测试进程未清场: ${active.map((row) => row.pid).join(",")}; 登记 ${this.directory}`);
  }

  remove() {
    rmSync(this.directory, { recursive: true, force: true });
    scopes.delete(this);
  }
}

function readFileSyncSafe(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function spawnTestFixture(commandName, args, options) {
  const scope = new TestProcessScope();
  const child = scope.spawn(commandName, args, options);
  child.dispose = async () => { await scope.stop(); scope.remove(); };
  return child;
}

export function preservedPids(scope, scripts, capturedStreams) {
  return new Set(scope.records().filter((record) =>
    scripts.some((script) => record.script && resolve(record.script) === resolve(script))
    && record.streams?.length === 2 && record.streams.every((stream) => stream && !capturedStreams.includes(stream))
  ).map((record) => record.pid));
}

process.once("exit", () => {
  if (process.argv[1] && resolve(process.argv[1]) === cleanupPath) return;
  if (!scopes.size) return;
  const result = spawnSync(process.execPath, [cleanupPath, ...[...scopes].map((scope) => scope.directory)], {
    stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL", windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) process.exitCode = 1;
});
