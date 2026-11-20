import { Agent, createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chmodSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

const deny = (reason: string) => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });
const fallback = "内置 Monitor 已拒绝。若未收到 Navi 已代办的明确回执，先用 list_monitors 核对，再决定是否用 start_monitor；不要重复创建同一条哨兵。";
if (process.argv[2] === "--deny-monitor") {
  process.stdout.write(JSON.stringify(deny(fallback)) + "\n");
  process.exit(0);
}

const socket = process.argv[2];
if (!socket) throw new Error("missing channel control socket");
const id = randomUUID();
let target: { port: number; owner: string; pid: number } | undefined;
let paused = true;
let active = 0;
let orphanedAt = 0;
const queued = new Set<() => void>();
const direct = new Agent();
const hookPath = "/api/hooks/claude-monitor";
const isChannel = (path: string) => path === hookPath || /^\/api\/llm-providers\/[^/]+\/(context-1m|convert)(?:\/|$)/.test(path);
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
function unavailable(response: ServerResponse, hook: boolean, delivered: boolean) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  if (hook) json(response, 200, deny(delivered
    ? `Monitor 请求已投递但未确认结果。${fallback}`
    : `服务切换中，Monitor 请求未执行。${fallback}`));
  else {
    if (!delivered) response.setHeader("x-navi-undelivered", "runtime-handoff-v1");
    json(response, 503, { error: delivered ? "模型请求投递后连接中断，未自动重放" : "模型请求等待服务恢复超时，未执行" });
  }
}
function forward(incoming: IncomingMessage, outgoing: ServerResponse, hook: boolean) {
  const backend = target;
  if (!backend) { unavailable(outgoing, hook, false); return; }
  active++;
  let finished = false;
  const upstream = request({ hostname: "127.0.0.1", port: backend.port, path: incoming.url,
    agent: direct,
    method: incoming.method, headers: { ...incoming.headers, host: `127.0.0.1:${backend.port}`,
      "x-navi-instance": backend.owner, connection: "close" },
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    active--;
    clearTimeout(timer);
  };
  const timer = hook ? setTimeout(() => {
    unavailable(outgoing, true, true);
    upstream.destroy();
    finish();
  }, 5_000) : undefined;
  upstream.on("response", (response) => {
    if (hook) {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 1_048_576) chunks.push(chunk); else upstream.destroy(new Error("hook response too large"));
      });
      response.on("end", () => {
        if (finished) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode !== 200 || body?.hookSpecificOutput?.permissionDecision !== "deny") throw new Error("missing deny");
          json(outgoing, 200, body);
        } catch { unavailable(outgoing, true, true); }
        finish();
      });
    } else {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on("end", finish);
    }
    response.on("error", () => { unavailable(outgoing, hook, true); finish(); });
    response.on("aborted", () => { unavailable(outgoing, hook, true); finish(); });
  });
  upstream.on("error", () => { unavailable(outgoing, hook, true); finish(); });
  incoming.on("aborted", () => { upstream.destroy(); finish(); });
  outgoing.on("close", () => { upstream.destroy(); finish(); });
  incoming.pipe(upstream);
}
const publicServer = createServer((incoming, outgoing) => {
  const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
  if (!isChannel(path)) { json(outgoing, 404, { error: "not an agent channel" }); return; }
  const hook = path === hookPath;
  if (!paused && target) { forward(incoming, outgoing, hook); return; }
  if (queued.size >= 64) { unavailable(outgoing, hook, false); return; }
  incoming.pause();
  const release = () => {
    if (!queued.delete(release)) return;
    clearTimeout(timer);
    if (!outgoing.destroyed) forward(incoming, outgoing, hook);
  };
  const timer = setTimeout(() => {
    queued.delete(release);
    unavailable(outgoing, hook, false);
  }, hook ? 3_000 : 120_000);
  queued.add(release);
  outgoing.on("close", () => { queued.delete(release); clearTimeout(timer); });
});
publicServer.requestTimeout = 0;
const flush = () => { if (!paused) for (const release of [...queued]) release(); };
const control = createServer(async (incoming, outgoing) => {
  const path = incoming.url;
  if (path === "/status") {
    json(outgoing, 200, { id, pid: process.pid, port: (publicServer.address() as { port: number }).port, active, paused, owner: target?.owner });
    return;
  }
  let body: { owner?: string; port?: number; pid?: number };
  try {
    let text = "";
    for await (const chunk of incoming) {
      text += chunk;
      if (text.length > 4096) throw new Error("control body too large");
    }
    body = JSON.parse(text);
  } catch { json(outgoing, 400, { error: "invalid control body" }); return; }
  if (path === "/activate") {
    if (!body.owner || !Number.isInteger(body.port) || body.port! < 1 || body.port! > 65535 || !Number.isInteger(body.pid)) {
      json(outgoing, 400, { error: "invalid backend" }); return;
    }
    if (active) { json(outgoing, 409, { error: "old backend still has delivered requests" }); return; }
    target = { owner: body.owner, port: body.port!, pid: body.pid! };
    paused = false;
    flush();
  } else {
    if (body.owner !== target?.owner) { json(outgoing, 409, { error: "backend ownership changed" }); return; }
    if (path === "/pause") {
      paused = true;
    } else if (path === "/resume") {
      paused = false;
      flush();
    } else if (path === "/retire") {
      if (active || queued.size) { json(outgoing, 409, { error: "channel requests still pending" }); return; }
      outgoing.on("finish", () => setImmediate(cleanup));
    } else { json(outgoing, 404, { error: "unknown channel control" }); return; }
  }
  json(outgoing, 200, { id, active, paused });
});
control.on("error", () => process.exit(1));
publicServer.on("error", () => process.exit(1));
publicServer.listen(0, "127.0.0.1", () => {
  control.listen(socket, () => chmodSync(socket, 0o600));
});
const cleanup = () => { try { unlinkSync(socket); } catch {} process.exit(0); };
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
setInterval(() => {
  let alive = false;
  try { if (target) { process.kill(target.pid, 0); alive = true; } } catch {}
  if (alive || active || queued.size) orphanedAt = 0;
  else if (!orphanedAt) orphanedAt = Date.now();
  else if (Date.now() - orphanedAt > 600_000) cleanup();
}, 30_000).unref();
