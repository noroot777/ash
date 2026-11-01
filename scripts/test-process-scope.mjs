import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import native from "./test-process-native.cjs";

const registerPath = fileURLToPath(new URL("test-process-register.cjs", import.meta.url));
const cleanupPath = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
const scopes = new Set();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function waitFile(path, failurePath) {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (failurePath && existsSync(failurePath)) throw new Error(readFileSync(failurePath, "utf8"));
    if (Date.now() >= deadline) throw Object.assign(new Error(`原生测试执行域握手超时: ${path}`), { code: "EOWNERSHIP" });
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

export class TestProcessScope {
  constructor(directory) {
    const owned = directory === undefined;
    this.children = [];
    this.directory = directory ?? mkdtempSync(join(tmpdir(), "ash-test-scope-"));
    try {
      if (owned) writeFileSync(join(this.directory, "started"), String(Date.now()), { flag: "wx" });
      else {
        readFileSync(join(this.directory, "started"), "utf8");
        if (existsSync(join(this.directory, "domain.json"))) this.domain = JSON.parse(readFileSync(join(this.directory, "domain.json"), "utf8"));
      }
      scopes.add(this);
    } catch (error) {
      if (owned) rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }

  initialize() {
    if (this.domain) return;
    const executable = native.executable();
    const name = `Local\\ash-test-${randomUUID()}`;
    const owner = native.invoke(executable, ["identity", String(process.pid)]);
    const domain = { name, executable };
    writeFileSync(join(this.directory, "domain.json"), JSON.stringify(domain), { flag: "wx" });
    const holder = spawn(executable, ["hold", name, this.directory, String(process.pid), owner], {
      stdio: "ignore", windowsHide: true,
    });
    holder.on("error", () => {});
    if (!holder.pid) throw Object.assign(new Error("原生测试监督进程未启动"), { code: "EOWNERSHIP" });
    this.domain = domain;
    this.holder = holder;
    holder.unref();
    try { waitFile(join(this.directory, "ready"), join(this.directory, "failed")); }
    catch (error) {
      writeFileSync(join(this.directory, "release"), "");
      if (existsSync(join(this.directory, "failed"))) this.domain = undefined;
      throw error;
    }
  }

  spawn(commandName, args, options = {}) {
    if (this.sealed || existsSync(join(this.directory, "stopped"))) throw new Error("测试执行域已停止");
    if (/[\\/]/.test(commandName) && !existsSync(commandName)) {
      throw Object.assign(new Error(`spawn ${commandName} ENOENT`), { code: "ENOENT" });
    }
    this.initialize();
    const environment = options.env ?? process.env;
    const { shell, windowsVerbatimArguments, ...spawnOptions } = options;
    const launch = join(this.directory, `launch-${randomUUID()}.json`);
    const child = spawn(this.domain.executable, ["run", this.domain.name, launch,
      ...(shell ? ["--shell", typeof shell === "string" ? shell : process.env.ComSpec ?? "cmd.exe", [commandName, ...args].join(" ")]
        : [commandName, ...args])], {
      ...spawnOptions, detached: false, windowsHide: true,
      env: { ...environment, ASH_TEST_PROCESS_SCOPE: this.directory,
        NODE_OPTIONS: `--require ${JSON.stringify(registerPath)} ${environment.NODE_OPTIONS ?? ""}`.trim() },
    });
    child.on("error", () => {});
    const closed = new Promise((resolveClosed) => {
      child.once("close", resolveClosed);
      child.once("error", resolveClosed);
    });
    this.children.push({ child, closed });
    waitFile(launch, launch + ".error");
    child.pid = JSON.parse(readFileSync(launch, "utf8")).pid;
    child.kill = () => { native.invoke(this.domain.executable, ["stop", this.domain.name]); return true; };
    return child;
  }

  records() {
    return readdirSync(this.directory).filter((name) => name !== "domain.json" && name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(this.directory, name), "utf8")))
      .filter((record) => record.kind === "process" && record.domain === this.domain?.name
        && Number.isInteger(record.pid) && typeof record.born === "string" && /^\d+$/.test(record.born) && typeof record.script === "string"
        && Array.isArray(record.streams) && record.streams.length === 2);
  }

  async active() {
    if (!this.domain || existsSync(join(this.directory, "closed"))) return [];
    return JSON.parse(native.invoke(this.domain.executable, ["list", this.domain.name]));
  }

  async stop() {
    this.sealed = true;
    const errors = [];
    try { writeFileSync(join(this.directory, "stopped"), ""); } catch (error) { errors.push(error); }
    if (this.domain && !existsSync(join(this.directory, "closed"))) {
      try { native.invoke(this.domain.executable, ["stop", this.domain.name]); } catch (error) { errors.push(error); }
    }
    if (!errors.length || this.children.length) {
      let timer;
      try {
        await Promise.race([Promise.all(this.children.map((entry) => entry.closed)), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("测试根进程未退出")), 20_000);
        })]);
      } catch (error) { errors.push(error); }
      finally { clearTimeout(timer); }
    }
    try { if ((await this.active()).length) errors.push(new Error("测试执行域尚有活动进程")); }
    catch (error) { errors.push(error); }
    if (errors.length) throw Object.assign(new AggregateError(errors, `测试执行域清理失败: ${this.directory}`), { directory: this.directory });
  }

  remove() {
    if (this.domain && !existsSync(join(this.directory, "closed"))) {
      const active = JSON.parse(native.invoke(this.domain.executable, ["list", this.domain.name]));
      if (active.length) throw new Error("不能回收尚有活动进程的执行域");
      writeFileSync(join(this.directory, "release"), "");
      waitFile(join(this.directory, "closed"));
    }
    rmSync(this.directory, { recursive: true, force: true });
    for (const scope of scopes) if (scope.directory === this.directory) scopes.delete(scope);
  }
}

export function spawnTestFixture(commandName, args, options) {
  const scope = new TestProcessScope();
  try {
    const child = scope.spawn(commandName, args, options);
    child.dispose = async () => { await scope.stop(); scope.remove(); };
    return child;
  } catch (error) {
    if (!scope.domain) scope.remove();
    throw error;
  }
}

export function preservedPids(scope, scripts, capturedStreams, active) {
  return new Set(scope.records().filter((record) =>
    active.some((row) => row.pid === record.pid && row.born === record.born)
    && scripts.some((script) => record.script && resolve(record.script) === resolve(script))
    && record.streams.every((stream) => stream && !capturedStreams.includes(stream))
  ).map((record) => record.pid));
}

export function disposeTestScopesSync() {
  if (!scopes.size) return;
  const result = spawnSync(process.execPath, [cleanupPath, ...[...scopes].map((scope) => scope.directory)], {
    stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL", windowsHide: true,
    env: { ...process.env, ASH_TEST_PROCESS_SCOPE: "" },
  });
  if (result.error || result.signal || result.status !== 0) throw new Error("测试执行域退出清理失败");
  scopes.clear();
}

process.once("exit", () => {
  if (process.argv[1] && resolve(process.argv[1]) === cleanupPath) return;
  try { disposeTestScopesSync(); } catch (error) { console.error(error); process.exitCode = 1; }
  try { native.dispose(); } catch (error) { console.error(error); process.exitCode = 1; }
});
