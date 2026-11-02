import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import native from "./test-process-native.cjs";
import { cleanupTestResourcesSync, reportTestResourceError } from "./test-process-resources.mjs";
import { scopes, cleanupFailures } from "./test-process-registry.mjs";
import { TestProcessScope as ObservableScope, publishRecord } from "./test-process-posix.mjs";
const observableRecords = ObservableScope.prototype.records;
import { TestDirectory, directoryOwnershipError } from "./test-process-directory.mjs";

const registerPath = fileURLToPath(new URL("test-process-register.cjs", import.meta.url));
const cleanupPath = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));

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
  #directory;

  constructor(directory, domain, directoryOwnership) {
    const owned = directory === undefined;
    this.children = [];
    const remembered = directory === undefined ? undefined : [...scopes].find((scope) => scope.directory === resolve(directory));
    this.#directory = new TestDirectory(directory, directoryOwnership ?? remembered?.directoryOwnership);
    Object.defineProperty(this, "directory", { value: this.#directory.path, enumerable: true });
    try {
      if (!owned) {
        try {
          if (!/^\d+$/.test(readFileSync(join(this.directory, "started"), "utf8"))) throw directoryOwnershipError(this.directory);
        }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        try {
          this.domain = JSON.parse(readFileSync(join(this.directory, "domain.json"), "utf8"));
          if (!this.domain || typeof this.domain.name !== "string" || !this.domain.name
            || typeof this.domain.executable !== "string" || !this.domain.executable) throw directoryOwnershipError(this.directory);
        }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (domain && !this.directoryOwnership) throw directoryOwnershipError(this.directory);
      this.domain = domain ?? this.domain ?? remembered?.domain;
      scopes.add(this);
    } catch (error) {
      if (owned) this.#directory.remove();
      throw error;
    }
  }

  get directoryIdentity() { return this.#directory.identity; }
  get directoryOwnership() { return this.#directory.ownership; }

  assertDirectoryOwnership() { this.#directory.assertOwnership(); }

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
    publishRecord(this.directory, child.pid, { pid: child.pid, at: Date.now(), script: "" });
    child.kill = () => { native.invoke(this.domain.executable, ["stop", this.domain.name]); return true; };
    return child;
  }

  records() {
    return observableRecords.call(this);
  }

  async inspect() { return { rows: await this.active(), escaped: [] }; }

  async survey() {
    try { return { ok: true, rows: await this.active() }; }
    catch (error) { return { ok: false, rows: [], error }; }
  }

  strikeBoundSync() {
    if (this.domain) native.invoke(this.domain.executable, ["stop", this.domain.name]);
  }

  async active() {
    return this.state().processes.map((row) => ({ ...row, created: row.born }));
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
    this.#directory.remove();
    for (const scope of scopes) if (scope.directory === this.directory) {
      scope.domain = undefined;
      scope.sealed = true;
      scopes.delete(scope);
    }
    cleanupFailures.delete(this.directory);
  }
}
