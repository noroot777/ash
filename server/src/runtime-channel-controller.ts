import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { Agent, request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processProof } from "./runtime-channel-consumers.js";
import { readRuntimeRecord, replaceRuntimeRecord } from "./runtime-channel-record.js";

export type Gateway = { id: string; port: number; pid: number; active: number; paused: boolean; owner?: string;
  protocol?: number; build?: string; queued?: number };
type Endpoint = { id: string; port: number; pid?: number; startedAt?: number; socket?: string; script?: string;
  retired?: boolean; reason?: string };
export type GatewayOptions = { home: string; socket: string; entry: string; node: string; owner: string; port: number;
  dbFile?: string; idleMs?: number; hasConsumers: (id?: string) => Promise<boolean> };
const direct = new Agent();
const unreachable = (error: unknown) => ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");

export function gatewayRequest(socket: string, path: string, body?: unknown): Promise<Gateway> {
  return new Promise((resolve, reject) => {
    const client = request({ socketPath: socket, path, method: body ? "POST" : "GET", agent: direct }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(`channel gateway ${response.statusCode}: ${text}`);
          resolve(JSON.parse(text));
        } catch (error) { reject(error); }
      });
    });
    client.setTimeout(2_000, () => client.destroy(new Error("channel gateway control timeout")));
    client.on("error", reject);
    client.end(body ? JSON.stringify(body) : undefined);
  });
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class RuntimeGatewayController {
  state?: Gateway;
  warning?: string;
  node = "";
  script = "";
  socket: string;
  private build = "";
  private paused = false;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private checking = false;
  private retryAt = 0;
  private failures = 0;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly endpoint: string;
  constructor(private readonly options: GatewayOptions) {
    this.endpoint = join(options.home, "endpoint.json");
    this.socket = options.socket;
  }

  async start(): Promise<void> {
    await this.serial(() => this.attempt(true));
    this.timer = setInterval(() => {
      if (this.checking || this.closed || Date.now() < this.retryAt) return;
      this.checking = true;
      void this.serial(async () => {
        if (this.closed) return;
        const stored = this.readEndpoint();
        if (stored?.retired && stored.reason !== "idle") { this.close(); return; }
        await this.attempt(false);
      }).catch((error) => this.disable(error)).finally(() => { this.checking = false; });
    }, 1_000);
    this.timer.unref();
  }

  close(): void { this.closed = true; clearInterval(this.timer); }
  pause(): Promise<Gateway> { this.paused = true; return this.control("/pause"); }
  resume(): Promise<Gateway> { this.paused = false; return this.control("/resume"); }
  async idle(): Promise<boolean> {
    if (!this.state) return false;
    const current = await this.control("/status");
    return current.id === this.state?.id && current.owner === this.options.owner && current.paused && current.active === 0;
  }
  private readEndpoint(path = this.endpoint, snapshot = readRuntimeRecord(this.endpoint)): Endpoint | undefined {
    try {
      const text = path === this.endpoint ? snapshot.current : snapshot.backup;
      const value = JSON.parse(text ?? "null");
      if (typeof value.id === "string" && value.id.length && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) {
        if (path === this.endpoint) {
          const backup = this.readEndpoint(this.endpoint + ".backup", snapshot);
          if (backup?.socket && backup.pid && backup.startedAt
            && (backup.id !== value.id || backup.port !== value.port || backup.socket !== value.socket || backup.pid !== value.pid)) {
            const proof = processProof(backup.pid);
            if ((!value.pid && !value.socket) || (proof && proof.startedAt === backup.startedAt
              && backup.script && proof.command.includes(backup.script))) return backup;
          }
        }
        return value;
      }
    } catch {}
    return path === this.endpoint ? this.readEndpoint(this.endpoint + ".backup", snapshot) : undefined;
  }
  private async prepare(): Promise<void> {
    if (this.build) return;
    const helper = fileURLToPath(new URL("./runtime-channel-consumers.js", import.meta.url));
    const record = fileURLToPath(new URL("./runtime-channel-record.js", import.meta.url));
    const sources = [this.options.entry, this.options.node, helper, record];
    const hashes = await Promise.all(sources.map(digest));
    const directory = join(this.options.home, "builds", createHash("sha256").update(hashes.join("-")).digest("hex"));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.node = join(directory, "node");
    this.script = join(directory, "gateway.mjs");
    const destinations = [this.script, this.node, join(directory, "runtime-channel-consumers.js"), join(directory, "runtime-channel-record.js")];
    for (const [index, source] of sources.entries()) {
      const destination = destinations[index];
      if (existsSync(destination) && hashes[index] === await digest(destination)) continue;
      const temporary = `${destination}.${process.pid}.tmp`;
      copyFileSync(source, temporary);
      chmodSync(temporary, index === 1 ? 0o700 : 0o600);
      renameSync(temporary, destination);
    }
    this.build = hashes.join("-");
  }
  private async attempt(upgrade: boolean): Promise<void> {
    try {
      await this.prepare();
      await this.reconcile(upgrade);
      this.warning = undefined;
      this.failures = 0;
    } catch (error) {
      try {
        if (!this.build || await this.options.hasConsumers()) throw error;
        if (!await this.resetUnused()) throw error;
        console.warn("[navi] rebuilding unused channel entry:", String(error));
        await this.reconcile(false);
        this.warning = undefined;
        this.failures = 0;
      } catch (failure) { this.disable(failure); }
    }
  }
  private disable(error: unknown): void {
    this.state = undefined;
    const message = `稳定通道暂不可用；服务继续运行，新任务使用直连：${String(error)}`;
    if (this.warning !== message) console.warn("[navi]", message);
    this.warning = message;
    this.retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(this.failures++, 6));
  }
  private async reconcile(upgrade: boolean): Promise<void> {
    let current = await this.statusOrSpawn();
    this.remember(current);
    if (!upgrade && current.owner && current.owner !== this.options.owner) { this.close(); return; }
    if (upgrade && current.build !== this.build && !await this.options.hasConsumers(current.id)) {
      if (!this.owned(current)) throw new Error("channel gateway replacement requires verified process ownership");
      try {
        await gatewayRequest(this.socket, "/retire", { owner: current.owner });
        await this.waitForExit();
        current = await this.statusOrSpawn();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("409")) throw error;
      }
    }
    if (upgrade && current.build !== this.build) console.warn("[navi] channel update staged; retaining compatible entry until a session-free startup");
    if (upgrade || !current.owner) await this.activate(current);
    else this.remember(current);
  }
  private async resetUnused(): Promise<boolean> {
    let snapshot = readRuntimeRecord(this.endpoint);
    const stored = this.readEndpoint(this.endpoint, snapshot);
    let current: Gateway | undefined;
    try { current = await gatewayRequest(this.socket, "/status"); }
    catch (error) { if (!unreachable(error)) return false; }
    if (current) {
      if (current.active !== 0 || (current.queued ?? 0) !== 0) return false;
      if (!this.owned(current)) return false;
      await gatewayRequest(this.socket, "/retire", { owner: current.owner });
      await this.waitForExit();
      snapshot = readRuntimeRecord(this.endpoint);
      const retired = this.readEndpoint(this.endpoint, snapshot);
      if (retired?.id !== current.id || retired.pid !== current.pid || retired.socket !== this.socket) return false;
    } else if (stored?.pid) {
      const proof = processProof(stored.pid);
      if (proof === undefined || (proof && (!stored.startedAt || proof.startedAt === stored.startedAt))) return false;
    } else if (snapshot.current !== undefined || snapshot.backup !== undefined) return false;
    replaceRuntimeRecord(this.endpoint, snapshot, null);
    const digest = createHash("sha256").update(this.options.home + randomUUID()).digest("hex").slice(0, 20);
    this.socket = join(dirname(this.options.socket), `nc-${digest.slice(0, 12)}.sock`);
    return true;
  }
  private control(path: string): Promise<Gateway> {
    return this.serial(async () => {
      try {
        await this.prepare();
        const current = await this.statusOrSpawn();
        this.remember(current);
        if (!current.owner) await this.activate(current);
        const result = await gatewayRequest(this.socket, path, path === "/status" ? undefined : { owner: this.options.owner });
        if (path === "/status") this.remember(result);
        return result;
      } catch (error) { this.disable(error); throw error; }
    });
  }
  private serial<Value>(operation: () => Promise<Value>): Promise<Value> {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => {});
    return next;
  }
  private processScript(command: string): string | undefined {
    const prefix = join(this.options.home, "builds") + "/";
    if (!command.includes(this.endpoint) || !command.includes(this.socket)) return undefined;
    for (const segment of command.split(prefix).slice(1)) {
      const suffix = segment.match(/^[a-f0-9]{64}(?:-[a-f0-9]{64}){0,2}\/gateway\.mjs(?=\s|$)/)?.[0];
      const script = suffix ? prefix + suffix : undefined;
      if (script && command.startsWith(join(dirname(script), "node") + " ") && existsSync(script)) return script;
    }
    return undefined;
  }
  private owned(current: Gateway): boolean {
    const stored = this.readEndpoint();
    const proof = processProof(current.pid);
    return !!(proof && stored?.pid === current.pid && stored.startedAt === proof.startedAt
      && stored.id === current.id && stored.port === current.port && stored.socket === this.socket
      && stored.script && this.processScript(proof.command) === stored.script);
  }
  private remember(current: Gateway): void {
    if (!current.id || !Number.isInteger(current.port) || current.port < 1 || current.port > 65535
      || !Number.isInteger(current.pid) || current.pid < 1) throw new Error("invalid channel gateway identity");
    if ((current.protocol !== undefined && current.protocol !== 1)
      || (current.protocol === 1 && typeof current.build !== "string")
      || (current.protocol === undefined && current.build !== undefined)) throw new Error("unsupported channel gateway protocol");
    const snapshot = readRuntimeRecord(this.endpoint);
    let stored = this.readEndpoint(this.endpoint, snapshot);
    const proof = processProof(current.pid);
    if (!stored && (!proof || !this.processScript(proof.command))) throw new Error("channel gateway process ownership cannot be verified");
    if (stored && (stored.id !== current.id || stored.port !== current.port)) {
      const backup = this.readEndpoint(this.endpoint + ".backup", snapshot);
      if (backup?.id !== current.id || backup.port !== current.port || backup.pid !== current.pid
        || !proof || backup.startedAt !== proof.startedAt) throw new Error("channel gateway identity changed");
      stored = backup;
    }
    replaceRuntimeRecord(this.endpoint, snapshot, { ...stored, id: current.id, port: current.port, pid: current.pid,
      startedAt: proof?.startedAt ?? stored?.startedAt, socket: this.socket, script: proof ? this.processScript(proof.command) : stored?.script,
      retired: false });
    this.state = current;
  }
  private async activate(current: Gateway): Promise<void> {
    this.remember(current);
    await gatewayRequest(this.socket, "/activate", {
      port: this.options.port, owner: this.options.owner, pid: process.pid, paused: this.paused,
    });
    this.remember(await gatewayRequest(this.socket, "/status"));
  }
  private async statusOrSpawn(): Promise<Gateway> {
    const snapshot = readRuntimeRecord(this.endpoint);
    const stored = this.readEndpoint(this.endpoint, snapshot);
    if (stored?.socket) this.socket = stored.socket;
    try { return await gatewayRequest(this.socket, "/status"); }
    catch (error) { if (!unreachable(error)) throw error; }
    if (!stored && (snapshot.current !== undefined || snapshot.backup !== undefined)) {
      throw new Error("channel identity record is damaged; process ownership cannot be verified");
    }
    if (!stored && await this.options.hasConsumers()) throw new Error("channel identity unavailable while consumers remain");
    if (stored && await this.options.hasConsumers() && !await this.options.hasConsumers(stored.id)) {
      throw new Error("persisted channel identity does not match live consumers");
    }
    if (stored?.pid) {
      const recordedAlive = () => {
        const proof = processProof(stored.pid!);
        return proof === undefined || (proof && (!stored.startedAt || proof.startedAt === stored.startedAt));
      };
      if (recordedAlive()) {
        const until = Date.now() + 2_500;
        do {
          await new Promise((done) => setTimeout(done, 100));
          try { return await gatewayRequest(this.socket, "/status"); } catch {}
        } while (recordedAlive() && Date.now() < until);
        if (recordedAlive()) throw new Error("recorded channel process is alive but control socket is unavailable");
      }
    }
    try { unlinkSync(this.socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (stored) {
      replaceRuntimeRecord(this.endpoint, snapshot, stored);
    }
    const logPath = join(this.options.home, "gateway.log");
    if (existsSync(logPath) && statSync(logPath).size > 1_048_576) renameSync(logPath, logPath + ".previous");
    const log = openSync(logPath, "a", 0o600);
    let child;
    try {
      child = spawn(this.node, [this.script, this.socket, this.endpoint,
        JSON.stringify({ dbFile: this.options.dbFile, idleMs: this.options.idleMs })], {
        detached: true, stdio: ["ignore", "ignore", log], cwd: this.options.home,
        env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: "/usr/bin:/bin" },
      });
    } finally { closeSync(log); }
    child.unref();
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    child.on("exit", (code, signal) => {
      let diagnostic = "";
      try { diagnostic = readFileSync(logPath, "utf8").slice(-4_096); } catch {}
      spawnError = new Error(`channel gateway exited (${code ?? signal}): ${diagnostic}`);
    });
    const until = Date.now() + 5_000;
    for (;;) {
      if (spawnError) throw spawnError;
      try { return await gatewayRequest(this.socket, "/status"); }
      catch (error) { if (!unreachable(error) || Date.now() > until) throw error; }
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  private async waitForExit(): Promise<void> {
    const until = Date.now() + 5_000;
    for (;;) {
      try { await gatewayRequest(this.socket, "/status"); }
      catch (error) {
        if (unreachable(error)) return;
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error;
      }
      if (Date.now() > until) throw new Error("channel gateway did not retire");
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}
