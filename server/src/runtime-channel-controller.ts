import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join } from "node:path";

export type Gateway = { id: string; port: number; pid: number; active: number; paused: boolean; owner?: string;
  protocol?: number; build?: string; queued?: number };
export type GatewayOptions = { home: string; socket: string; entry: string; node: string; owner: string; port: number;
  hasConsumers: (id: string) => Promise<boolean> };
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
  node = "";
  script = "";
  private build = "";
  private paused = false;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private checking = false;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly endpoint: string;
  constructor(private readonly options: GatewayOptions) { this.endpoint = join(options.home, "endpoint.json"); }

  async start(): Promise<void> {
    const { home, entry, node } = this.options;
    this.build = `${await digest(entry)}-${await digest(node)}`;
    const directory = join(home, "builds", this.build);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.node = join(directory, "node");
    this.script = join(directory, "gateway.mjs");
    for (const [source, destination, mode] of [[node, this.node, 0o700], [entry, this.script, 0o600]] as const) {
      if (existsSync(destination) && await digest(source) === await digest(destination)) continue;
      const temporary = `${destination}.${process.pid}.tmp`;
      copyFileSync(source, temporary);
      chmodSync(temporary, mode);
      renameSync(temporary, destination);
    }
    await this.serial(async () => {
      let current = await this.statusOrSpawn();
      this.remember(current);
      if (current.build !== this.build && !await this.options.hasConsumers(current.id)) {
        try {
          await gatewayRequest(this.options.socket, "/retire", { owner: current.owner });
          await this.waitForExit();
          current = await this.statusOrSpawn();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("409")) throw error;
        }
      }
      if (current.build !== this.build) console.warn("[navi] channel update staged; retaining compatible entry until a session-free startup");
      await this.activate(current);
    });
    this.timer = setInterval(() => {
      if (this.checking || this.closed) return;
      this.checking = true;
      void this.serial(async () => {
        if (this.closed) return;
        const stored = JSON.parse(readFileSync(this.endpoint, "utf8"));
        if (stored.retired) { this.close(); return; }
        const current = await this.statusOrSpawn();
        if (current.owner && current.owner !== this.options.owner) { this.close(); return; }
        if (!current.owner) await this.activate(current);
        else this.remember(current);
      }).catch((error) => console.error("[navi] channel recovery failed", error)).finally(() => { this.checking = false; });
    }, 1_000);
    this.timer.unref();
  }

  close(): void { this.closed = true; clearInterval(this.timer); }
  pause(): Promise<Gateway> { this.paused = true; return this.control("/pause"); }
  resume(): Promise<Gateway> { this.paused = false; return this.control("/resume"); }
  async idle(): Promise<boolean> {
    const current = await this.control("/status");
    return current.id === this.state?.id && current.owner === this.options.owner && current.paused && current.active === 0;
  }
  private control(path: string): Promise<Gateway> {
    return this.serial(async () => {
      const current = await this.statusOrSpawn();
      if (!current.owner) await this.activate(current);
      const result = await gatewayRequest(this.options.socket, path, path === "/status" ? undefined : { owner: this.options.owner });
      if (path === "/status") this.remember(result);
      return result;
    });
  }
  private serial<Value>(operation: () => Promise<Value>): Promise<Value> {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => {});
    return next;
  }
  private remember(current: Gateway): void {
    if ((current.protocol !== undefined && current.protocol !== 1)
      || (current.protocol === 1 && typeof current.build !== "string")
      || (current.protocol === undefined && current.build !== undefined)) throw new Error("unsupported channel gateway protocol");
    if (existsSync(this.endpoint)) {
      const stored = JSON.parse(readFileSync(this.endpoint, "utf8"));
      if (stored.id !== current.id || stored.port !== current.port) throw new Error("channel gateway identity changed");
    } else {
      const temporary = `${this.endpoint}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ id: current.id, port: current.port }), { mode: 0o600 });
      renameSync(temporary, this.endpoint);
    }
    this.state = current;
  }
  private async activate(current: Gateway): Promise<void> {
    this.remember(current);
    await gatewayRequest(this.options.socket, "/activate", {
      port: this.options.port, owner: this.options.owner, pid: process.pid, paused: this.paused,
    });
    this.remember(await gatewayRequest(this.options.socket, "/status"));
  }
  private async statusOrSpawn(): Promise<Gateway> {
    try {
      const current = await gatewayRequest(this.options.socket, "/status");
      this.remember(current);
      return current;
    } catch (error) { if (!unreachable(error)) throw error; }
    try { unlinkSync(this.options.socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const logPath = join(this.options.home, "gateway.log");
    const log = openSync(logPath, "a", 0o600);
    let child;
    try {
      child = spawn(this.node, [this.script, this.options.socket, this.endpoint], {
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
      try { return await gatewayRequest(this.options.socket, "/status"); }
      catch (error) { if (!unreachable(error) || Date.now() > until) throw error; }
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  private async waitForExit(): Promise<void> {
    const until = Date.now() + 5_000;
    for (;;) {
      try { await gatewayRequest(this.options.socket, "/status"); }
      catch (error) {
        if (unreachable(error)) return;
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error;
      }
      if (Date.now() > until) throw new Error("channel gateway did not retire");
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}
