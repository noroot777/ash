import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { Agent, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_DIR, DATA_DIR } from "./paths.js";
import { INSTANCE_ID } from "./instance-binding.js";

type Gateway = { id: string; port: number; active: number; paused: boolean; owner: string };
let gateway: Gateway | undefined;
let controlSocket: string | undefined;
let fallbackCommand: string | undefined;
let operations: Promise<unknown> = Promise.resolve();
const direct = new Agent();

export const runtimeGateway = () => gateway;
export const runtimeGatewayOrigin = () => gateway ? `http://127.0.0.1:${gateway.port}` : undefined;
export const runtimeMonitorFallback = () => fallbackCommand;

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

export async function startRuntimeGateway(port: number): Promise<void> {
  if (process.platform !== "darwin" || !existsSync(join(CODE_DIR, "runtime-manifest.json"))) return;
  const home = join(DATA_DIR, ".agent-channel-v1");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 24);
  const socket = join(tmpdir(), `navi-channel-${process.getuid?.() ?? 0}-${digest}.sock`);
  const node = join(home, "node");
  const script = join(home, "gateway.mjs");
  const install = (source: string, destination: string, mode: number) => {
    if (existsSync(destination)) return;
    const temporary = destination + `.${process.pid}.tmp`;
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, destination);
  };
  install(process.execPath, node, 0o700);
  install(fileURLToPath(new URL("./runtime-channel-daemon.js", import.meta.url)), script, 0o600);
  try { await gatewayRequest(socket, "/status"); }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    try { unlinkSync(socket); } catch {}
    const child = spawn(node, [script, socket], { detached: true, stdio: "ignore", cwd: home,
      env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: "/usr/bin:/bin" } });
    child.unref();
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    const until = Date.now() + 5_000;
    for (;;) {
      if (spawnError) throw spawnError;
      try { await gatewayRequest(socket, "/status"); break; }
      catch (error) { if (Date.now() > until) throw error; }
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  await gatewayRequest(socket, "/activate", { port, owner: INSTANCE_ID, pid: process.pid });
  gateway = await gatewayRequest(socket, "/status");
  controlSocket = socket;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  fallbackCommand = `${quote(node)} ${quote(script)} --deny-monitor`;
}

export async function pauseRuntimeGateway(): Promise<void> {
  if (controlSocket) await control("/pause", { owner: INSTANCE_ID });
}
export async function resumeRuntimeGateway(): Promise<void> {
  if (controlSocket) await control("/resume", { owner: INSTANCE_ID });
}
export async function runtimeGatewayIdle(): Promise<boolean> {
  if (!controlSocket) return true;
  const current = await control("/status");
  return current.id === gateway?.id && current.owner === INSTANCE_ID && current.paused && current.active === 0;
}
function control(path: string, body?: unknown): Promise<Gateway> {
  const operation = operations.then(() => gatewayRequest(controlSocket!, path, body));
  operations = operation.catch(() => {});
  return operation;
}
