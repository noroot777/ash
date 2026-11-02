import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import native from "./test-process-native.cjs";
import { cleanupTestResourcesSync, reportTestResourceError } from "./test-process-resources.mjs";

const registerPath = fileURLToPath(new URL("test-process-register.cjs", import.meta.url));
const cleanupPath = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
const scopes = new Set();
const cleanupFailures = new Map();
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

function directoryOwnershipError(directory) {
  return Object.assign(new Error(`拒绝清理无法确认归属的测试执行域目录: ${directory}`), { code: "EOWNERSHIP", directory });
}

function directoryIdentity(directory) {
  try {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw directoryOwnershipError(directory);
    return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function sameDirectory(expected, actual) {
  return expected && actual && expected.dev === actual.dev && expected.ino === actual.ino;
}

export class TestProcessScope {
  #directoryIdentity;

  constructor(directory, domain, expectedDirectoryIdentity) {
    const owned = directory === undefined;
    this.children = [];
    Object.defineProperty(this, "directory", { value: resolve(directory ?? mkdtempSync(join(tmpdir(), "ash-test-scope-"))), enumerable: true });
    try {
      const identity = directoryIdentity(this.directory);
      if (identity && expectedDirectoryIdentity !== undefined && !sameDirectory(expectedDirectoryIdentity, identity)) throw directoryOwnershipError(this.directory);
      let marked = owned;
      if (owned) writeFileSync(join(this.directory, "started"), String(Date.now()), { flag: "wx" });
      else {
        try {
          if (!/^\d+$/.test(readFileSync(join(this.directory, "started"), "utf8"))) throw directoryOwnershipError(this.directory);
          marked = true;
        }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        try {
          this.domain = JSON.parse(readFileSync(join(this.directory, "domain.json"), "utf8"));
          if (!this.domain || typeof this.domain.name !== "string" || !this.domain.name
            || typeof this.domain.executable !== "string" || !this.domain.executable) throw directoryOwnershipError(this.directory);
          marked = true;
        }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const temporaryScope = dirname(this.directory) === resolve(tmpdir()) && /^ash-test-scope-[a-zA-Z0-9]{6}$/.test(basename(this.directory));
      if (identity && !marked && !temporaryScope && !sameDirectory(expectedDirectoryIdentity, identity)) throw directoryOwnershipError(this.directory);
      this.#directoryIdentity = identity ?? (expectedDirectoryIdentity ? Object.freeze({ ...expectedDirectoryIdentity }) : null);
      this.domain = domain ?? this.domain;
      scopes.add(this);
    } catch (error) {
      if (owned) rmSync(this.directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
      throw error;
    }
  }

  get directoryIdentity() { return this.#directoryIdentity; }

  assertDirectoryOwnership() {
    const identity = directoryIdentity(this.directory);
    if (identity && !sameDirectory(this.#directoryIdentity, identity)) throw directoryOwnershipError(this.directory);
  }

  initialize() {
    if (this.initializationError) throw this.initializationError;
    if (this.domain) return;
    try { this.initializeDomain(); }
    catch (error) { this.initializationError = error; throw error; }
  }

  initializeDomain() {
    const executable = native.executable();
    const name = `Local\\ash-test-${randomUUID()}`;
    const owner = native.invoke(executable, ["identity", String(process.pid)]);
    const domain = { name, executable };
    this.domain = domain;
    try {
      const holder = spawn(executable, ["hold", name, this.directory, String(process.pid), owner], {
        stdio: "ignore", windowsHide: true,
      });
      this.holder = holder;
      holder.on("error", () => {});
      if (!holder.pid) throw Object.assign(new Error("原生测试监督进程未启动"), { code: "EOWNERSHIP" });
      holder.unref();
      waitFile(join(this.directory, "ready"), join(this.directory, "failed"));
      writeFileSync(join(this.directory, "domain.json"), JSON.stringify(domain), { flag: "wx" });
    }
    catch (error) {
      try {
        if (!existsSync(join(this.directory, "failed")) && this.holder?.pid
          && this.holder.exitCode === null && this.holder.signalCode === null && !this.holder.kill()
          && !existsSync(join(this.directory, "failed"))) {
          throw Object.assign(new Error("无法终止未就绪的原生监督进程"), { code: "EOWNERSHIP" });
        }
        native.invoke(executable, ["stop", name]);
        this.waitRetired();
        rmSync(join(this.directory, "domain.json"), { force: true });
        this.domain = undefined;
      } catch (cleanupError) {
        throw Object.assign(new AggregateError([error, cleanupError], "测试执行域初始化与回滚失败", { cause: error }), { code: error.code });
      }
      throw error;
    }
  }

  state() {
    if (!this.domain) return { exists: false, processes: [] };
    const state = JSON.parse(native.invoke(this.domain.executable, ["state", this.domain.name]));
    if (typeof state.exists !== "boolean" || !Array.isArray(state.processes) || (!state.exists && state.processes.length)) {
      throw Object.assign(new Error("原生测试执行域状态无效"), { code: "EOWNERSHIP" });
    }
    return state;
  }

  waitRetired() {
    const deadline = Date.now() + 20_000;
    while (this.state().exists) {
      if (Date.now() >= deadline) throw Object.assign(new Error("原生测试执行域未退役"), { code: "EOWNERSHIP" });
      Atomics.wait(sleeper, 0, 0, 10);
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
    return this.state().processes;
  }

  async stop() {
    this.sealed = true;
    const errors = [];
    try {
      this.assertDirectoryOwnership();
      if (existsSync(this.directory)) writeFileSync(join(this.directory, "stopped"), "");
    } catch (error) { if (error.code !== "ENOENT" || existsSync(this.directory)) errors.push(error); }
    if (this.domain) {
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
    this.assertDirectoryOwnership();
    const state = this.state();
    if (state.exists) {
      if (state.processes.length) throw new Error("不能回收尚有活动进程的执行域");
      native.invoke(this.domain.executable, ["stop", this.domain.name]);
      this.waitRetired();
    }
    rmSync(this.directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
    for (const scope of scopes) if (scope.directory === this.directory) {
      scope.domain = undefined;
      scope.sealed = true;
      scopes.delete(scope);
    }
    cleanupFailures.delete(this.directory);
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
  const domains = new Map();
  for (const scope of scopes) if (!domains.has(scope.directory) || scope.domain) domains.set(scope.directory, {
    directory: scope.directory, domain: scope.domain, directoryIdentity: scope.directoryIdentity,
  });
  const pending = [...domains.values()]
    .filter(({ directory }) => !cleanupFailures.has(directory));
  let processError;
  if (pending.length) {
    const result = spawnSync(process.execPath, [cleanupPath], {
      input: JSON.stringify(pending),
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", windowsHide: true,
      env: { ...process.env, ASH_TEST_PROCESS_SCOPE: "" },
    });
    if (result.error || result.signal || result.status !== 0) {
      processError = Object.assign(new Error(`测试执行域退出清理失败\n${result.stdout ?? ""}${result.stderr ?? ""}`, { cause: result.error }), {
        code: result.error?.code ?? "ETESTCLEANUP", result,
      });
    }
    const report = result.stdout?.split(/\r?\n/).find((line) => line.startsWith("ASH_TEST_SCOPE_CLEANUP="));
    let retired = new Set();
    try {
      const directories = JSON.parse(report?.slice("ASH_TEST_SCOPE_CLEANUP=".length));
      if (!Array.isArray(directories) || directories.some((directory) => typeof directory !== "string")) throw new Error("清理退役清单无效");
      retired = new Set(directories);
    } catch (error) { processError ??= new Error("测试执行域退出清理缺少有效退役清单", { cause: error }); }
    for (const { directory } of pending) {
      if (!retired.has(directory) || existsSync(directory)) cleanupFailures.set(directory, processError ?? new Error(`测试执行域未退役: ${directory}`));
      else for (const scope of scopes) if (scope.directory === directory) {
        scope.domain = undefined;
        scope.sealed = true;
        scopes.delete(scope);
      }
    }
  }
  const errors = [...new Set([processError, ...cleanupFailures.values()].filter(Boolean))];
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "测试执行域退出清理失败", { cause: errors[0] });
}

export function disposeTestProcessResourcesSync() {
  cleanupTestResourcesSync([disposeTestScopesSync, () => { if (!scopes.size) native.dispose(); }]);
}

process.once("exit", () => {
  if (process.argv[1] && resolve(process.argv[1]) === cleanupPath) return;
  try { disposeTestProcessResourcesSync(); } catch (error) { reportTestResourceError(error); process.exitCode = 1; }
});
