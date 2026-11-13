// 本机自用模式（`ASH_LOCAL_ONLY=1`）的身份判定：**只认本机直连**。
//
// 只封配对入口不够（第 1 轮审查实测）：从普通模式换到本机模式的同一份数据里，旧访问密钥、
// 旧设备凭证都还在，经同机反代 / 隧道转进来的请求（带 X-Forwarded-For）拿着它们照样被认成
// 机主，还能用密钥登录再签一台设备出来。这里按那次的复现步骤钉住：
//   ① 本机直连照旧零摩擦；
//   ② 转进来的请求不带凭证 401，带旧密钥（Bearer）、旧设备 cookie / Bearer 也都 401；
//   ③ 密钥登录 403、不签发任何凭证；配对与远程访问端点 403；转多人 403；
//   ④ `auth/state` 报 localOnly。
//
// 走真实 TCP 连接：判据里「回环 socket + Host + 转发头」那一半只有真连接测得出来。
//
// 跑法: npm -w server run test:local-only-auth
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-local-only-auth-"));
process.env.ASH_DB ||= join(stage, "local-only.db");
// local-only.js 在模块加载时读开关，所以得在 import 任何 server 模块之前设好。
process.env.ASH_LOCAL_ONLY = "1";
requireTmpDb("test-local-only-auth");

const { ensureSchema } = await import("../src/db/index.js");
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const mode = await import("../src/auth/mode.js");
const { authGate } = await import("../src/auth/middleware.js");
const { mountAuthRoutes } = await import("../src/auth/routes.js");
const { enrollDevice, ensureRemoteAccessKey } = await import("../src/auth/remote-access.js");
const { LOCAL_ONLY } = await import("../src/local-only.js");

await ensureSchema();
assert.equal(LOCAL_ONLY, true, "前提:开关读到了");
await mode.setInstanceMode("single", "");
// 「换到本机模式之前」留下来的旧凭证:一把访问密钥、一台放进来过的设备。
const key = ensureRemoteAccessKey();
const { token: deviceToken } = enrollDevice({ name: "旧设备", via: "approval", address: "192.168.1.20" });

const api = new Hono();
mountAuthRoutes(api);
api.get("/canary", (c) => c.json({ secret: "任务标题" }));
const app = new Hono();
app.use("*", authGate());
app.route("/api", api);

const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
const port = (server.address() as { port: number }).port;
const direct = new Agent();

type Res = { status: number; body: Record<string, unknown>; text: string; cookie: string | null };
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: opts.method ?? "GET", agent: direct,
      headers: {
        ...(payload === null ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 纯文本应答 */ }
        const setCookie = res.headers["set-cookie"]?.[0];
        resolve({ status: res.statusCode ?? 0, body, text, cookie: setCookie ? setCookie.split(";")[0]! : null });
      });
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

try {
  // ① 本机直连
  assert.equal((await call("/api/canary")).status, 200, "本机直连照旧打开就用");
  const local = await call("/api/auth/state");
  assert.equal(local.body.localOnly, true);
  assert.equal(local.body.needsAccessKey, false);

  // ② 同机反代转进来的请求:什么凭证都不认
  const relayed = { "x-forwarded-for": "203.0.113.27" };
  const none = await call("/api/canary", { headers: relayed });
  assert.equal(none.status, 401);
  assert.equal(none.body.secret, undefined);
  assert.match(String(none.body.error), /只接受本机直连/, "401 要说清这是本机模式,别再教人去拿访问密钥");
  assert.equal((await call("/api/canary", { headers: { ...relayed, authorization: `Bearer ${key}` } })).status, 401, "旧访问密钥");
  assert.equal((await call("/api/canary", { headers: { ...relayed, authorization: `Bearer ${deviceToken}` } })).status, 401, "旧设备 Bearer");
  assert.equal((await call("/api/canary", { headers: { ...relayed, cookie: `ash_session=${deviceToken}` } })).status, 401, "旧设备 cookie");
  const state = await call("/api/auth/state", { headers: { ...relayed, authorization: `Bearer ${key}` } });
  assert.equal(state.body.needsAccessKey, true, "带着旧密钥也认不成机主");
  assert.equal(state.body.localOnly, true);

  // ③ 签发凭证的入口一律关着
  const login = await call("/api/auth/login", { method: "POST", headers: relayed, body: { key } });
  assert.equal(login.status, 403, `密钥登录:${login.text}`);
  assert.equal(login.cookie, null, "不许签出新的设备 cookie");
  const loginLocal = await call("/api/auth/login", { method: "POST", body: { key } });
  assert.equal(loginLocal.status, 403, "本机发起的密钥登录同样不登记设备");
  assert.equal(loginLocal.cookie, null);
  for (const path of ["/api/auth/pair", "/api/auth/pair/claim", "/api/auth/pair/redeem"]) {
    assert.equal((await call(path, { method: "POST", headers: relayed, body: {} })).status, 403, path);
  }
  assert.equal((await call("/api/remote-access")).status, 403, "本机看远程访问也是 403(这个模式下没有它)");
  const multi = await call("/api/auth/setup", { method: "POST", body: { mode: "multi", adminName: "x", rootDir: join(stage, "root") } });
  assert.equal(multi.status, 403, `转多人:${multi.text}`);
  mode.invalidateInstanceConfig();
  assert.equal((await mode.instanceConfig()).mode, "single", "被拒的转换不许落任何东西");
} finally {
  direct.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("test-local-only-auth ok");
