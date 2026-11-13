// 自用模式:预览凭证活不过签发它的那件凭证,连接活不过预览凭证;经预览绕回来的不是本机。
// (判据在 server/src/auth/remote-access.ts「凭证作废…」一节与 preview-access.ts 顶部「活不过」一节。)
//
// 审查实测过的两条(第 1 轮 F1 / F2),连同它们的同类:
//   ① 别的设备经预览调 ash 的 `/api`,拿到的是**它自己那台设备**的权限,不是本机直连的:读不到
//      访问密钥;被预览的服务收到的请求如实带着 `X-Forwarded-For`。机主在本机开预览照旧。
//   ② 借来的预览地址(本机开的、被复制到别的设备上)换不来机主身份。
//   ③ 设备登出:它开过的预览当场不作数(地址、内容两条道都是),别人的预览不受牵连。
//   ④ 移除设备:它开着的预览 WebSocket、还在流的应答一起断,上游那一头也断。
//   ⑤ 换访问密钥:凭旧密钥开的预览和连接一起作废;本机开的不受牵连。
//   ⑥ 没有事件可等的失效(预览换了一代)由定时那一遍核出来,连接同样掐断。
//
// 走真实的 TCP:判据看的是 socket 与转发头,进程内派发测不到「从别处来」这一半。
// 跑法:npm -w server run test:preview-revocation
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-preview-revocation-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-preview-revocation");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const { authGate, SESSION_COOKIE } = await import("../src/auth/middleware.js");
const { ensureRemoteAccessKey, listDevices } = await import("../src/auth/remote-access.js");
const pairing = await import("../src/auth/remote-pairing.js");
const { recordListeningPort } = await import("../src/listening-port.js");
const { REPO_DIR } = await import("../src/paths.js");
const { mountPreviewOpenRoutes, sweepChannels } = await import("../src/preview-access.js");
const { attachPreviewUpgrades, mountPreviewProxy } = await import("../src/preview-proxy.js");
const { api } = await import("../src/routes.js");

await ensureSchema();
mountPreviewOpenRoutes(api);
const app = new Hono();
mountPreviewProxy(app);
app.use("*", authGate());
app.route("/api", api);
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
attachPreviewUpgrades(server);
const port = (server.address() as { port: number }).port;
recordListeningPort(port);

// 自己的 agent:`NODE_USE_ENV_PROXY=1` 会把默认的那个接到系统代理上(同 test-remote-access.ts)。
const direct = new Agent();
/** 别的设备:经同机的一跳转进来的,带着转发头 —— 和从网卡地址连进来走同一条判据。 */
const REMOTE = { "x-forwarded-for": "192.0.2.25" };

// ── 被预览的服务(替身)。`/api` 学 vite 的样子原样转回这台 ash;其余几条各管一件事 ──
const upstreamSockets = new Set<Socket>();
/** 上游还在往外流的应答。 */
const streams = new Set<unknown>();
const upstream = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    const relay = httpRequest({
      host: "127.0.0.1", port, path: req.url, method: req.method, agent: direct,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    }, (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
    relay.on("error", () => res.destroy());
    req.pipe(relay);
    return;
  }
  if (req.url === "/headers") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.headers)); return; }
  if (req.url === "/stream") {
    streams.add(res);
    res.once("close", () => streams.delete(res));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end('<!doctype html><html><body><a href="/api/projects">projects</a></body></html>');
});
upstream.on("connection", (socket) => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
// 升级之后原样回声(不必是真的 WebSocket 帧:代理只管两头对接)。
const echoes = new Set<Socket>();
upstream.on("upgrade", (_req, socket: Socket) => {
  echoes.add(socket);
  socket.once("close", () => echoes.delete(socket));
  socket.on("error", () => {});
  socket.on("end", () => socket.destroy());
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", (chunk) => socket.write(chunk));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as { port: number }).port;

type Res = { status: number; body: Record<string, unknown>; text: string; location: string | null; cookie: string | null };
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: opts.method ?? "GET", agent: direct,
      headers: { ...(payload === null ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }), ...opts.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 纯文本应答 */ }
        const setCookie = res.headers["set-cookie"]?.[0];
        resolve({ status: res.statusCode ?? 0, body, text, location: res.headers.location ?? null, cookie: setCookie ? setCookie.split(";")[0]! : null });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}
/** 开一条流式应答;`closed` 在它被掐断(或结束)时兑现。 */
function openStream(path: string, headers: Record<string, string>): Promise<{ status: number; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, agent: direct, headers }, (res: IncomingMessage) => {
      res.resume();
      res.on("error", () => {});
      resolve({ status: res.statusCode ?? 0, closed: new Promise<void>((done) => res.once("close", () => done())) });
    });
    req.on("error", reject);
    req.end();
  });
}
/** 升级成一条双向通道;`echo` 发一段、等它原样回来。 */
function openSocket(path: string, headers: Record<string, string>) {
  return new Promise<{ echo: (text: string) => Promise<string>; closed: Promise<void> }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, agent: false, headers: { ...headers, connection: "Upgrade", upgrade: "websocket" } });
    req.on("response", (res) => reject(new Error(`升级被拒:${res.statusCode}`)));
    req.on("error", reject);
    req.on("upgrade", (_res, socket) => {
      socket.on("error", () => {});
      const closed = new Promise<void>((done) => socket.once("close", () => done()));
      resolve({
        closed,
        echo: (text) => new Promise<string>((got, lost) => {
          const timer = setTimeout(() => lost(new Error("没有回声")), 1_500);
          socket.once("data", (chunk: Buffer) => { clearTimeout(timer); got(chunk.toString("utf8")); });
          socket.write(text);
        }),
      });
    });
    req.end();
  });
}
const within = (what: Promise<void>, why: string, ms = 3_000) => Promise.race([
  what, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(why)), ms)),
]);
const quiet = async (check: () => boolean, why: string) => {
  for (let i = 0; i < 60 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), why);
};

try {
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p1", name: "这台 ash 自己", repoPath: REPO_DIR, apiKeys: null, createdAt: at } as never);
  await db.insert(tasks).values({ id: "t1", projectId: "p1", title: "预览", body: "", status: "done", createdAt: at, updatedAt: at } as never);
  const writePreview = (gen: string) => {
    mkdirSync(join(stage, "runs", "t1"), { recursive: true });
    const url = `http://127.0.0.1:${upstreamPort}/`;
    writeFileSync(join(stage, "runs", "t1", "preview.json"), JSON.stringify({
      taskId: "t1", cmd: "替身", pid: process.pid, port: upstreamPort, url, proxyToken: "fixture", gen, state: "ready", hostApi: port,
      startedAt: at, log: "", life: "task",
      services: [{ id: "web", name: "web", cmd: "替身", pid: process.pid, port: upstreamPort, url, status: "ready" }],
    }));
  };
  writePreview("gen-1");

  /** 放一台设备进来(申请 → 允许 → 领),回它带的头。 */
  const pair = (name: string) => {
    const ticket = pairing.openPairRequest({ name, address: "192.0.2.25" })!;
    pairing.decidePairRequest(ticket.id, true);
    const claim = pairing.claimPairRequest(ticket.id, ticket.secret, "192.0.2.25");
    assert.equal(claim.status, "approved");
    return { ...REMOTE, cookie: `${SESSION_COOKIE}=${claim.status === "approved" ? claim.token : ""}` };
  };
  /** 开预览、以页面导航认领,回地址栏那条道和页面内容里那条道。 */
  const openPreview = async (headers: Record<string, string>) => {
    const opened = await call("/api/tasks/t1/preview/open/web", { headers });
    assert.equal(opened.status, 302, opened.text);
    const nav = opened.location!;
    const page = await call(nav, { headers: { ...REMOTE_ONLY(headers), accept: "text/html", "sec-fetch-dest": "document" } });
    assert.equal(page.status, 200, page.text);
    const content = [...page.text.matchAll(/\/preview\/[^/]+\/[a-f0-9]{48}\/web\//g)].map((m) => m[0]).find((path) => path !== nav);
    assert.ok(content, "页面内容改写到了内容那条道上");
    return { nav, content: content!, client: page.cookie };
  };
  /** 预览那一侧一个 ash 的凭证都不带(代理本来也不转):只留「从哪来」。 */
  const REMOTE_ONLY = (headers: Record<string, string>) => ("x-forwarded-for" in headers ? REMOTE : {});

  // ── ① 经预览绕回来的不是本机 ────────────────────────────────────────────
  const phone = pair("手机");
  const phonePreview = await openPreview(phone);
  {
    const viaPreview = await call(`${phonePreview.content}api/remote-access`, { headers: REMOTE });
    assert.equal(viaPreview.status, 200, viaPreview.text);
    assert.equal(viaPreview.body.local, false, "别的设备经预览调 /api:是它那台设备,不是本机直连");
    assert.equal("key" in viaPreview.body, false, "读不到访问密钥");
    assert.equal((viaPreview.body.devices as { current: boolean }[]).filter((d) => d.current).length, 1, "认出来的就是它自己");
    assert.equal((await call(`${phonePreview.content}api/remote-access/rotate`, { method: "POST", headers: REMOTE })).status, 403, "也换不了密钥");
    const seen = await call(`${phonePreview.content}headers`, { headers: REMOTE });
    // 值是代理自己看到的对端(这里的「别的设备」是经同机一跳转进来的,所以是回环);客户端自己报的不往下传。
    assert.equal(seen.body["x-forwarded-for"], "127.0.0.1", "被预览的服务收到的请求如实带着「这是替别人转的」");
    assert.equal(listDevices()[0]!.address, "192.0.2.25", "经预览那一跳(回环)不盖掉设备原来的地址");

    // 机主在本机开预览:照旧。没有转发头,`/api` 由被预览的服务转回来,还是本机直连。
    const mine = await openPreview({});
    const localHeaders = await call(`${mine.content}headers`);
    assert.equal("x-forwarded-for" in localHeaders.body, false, "本机直连的不盖");
    const localApi = await call(`${mine.content}api/remote-access`);
    assert.equal(localApi.status, 200, localApi.text);
    assert.equal(localApi.body.local, true);

    // ── ② 借来的预览地址换不来机主身份 ────────────────────────────────────
    assert.equal((await call(`${mine.nav}headers`, { headers: REMOTE })).status, 200, "地址本身照旧能看这个预览");
    assert.equal((await call(`${mine.nav}api/remote-access`, { headers: REMOTE })).status, 401, "但它的 /api 不再是本机直连");
    assert.equal((await call(`${mine.content}api/projects`, { headers: REMOTE })).status, 401);

    // ── ③ 设备登出 ────────────────────────────────────────────────────────
    assert.equal((await call(`${phonePreview.content}api/projects`, { headers: REMOTE })).status, 200);
    assert.equal((await call("/api/auth/logout", { method: "POST", headers: phone })).status, 200);
    assert.equal((await call("/api/projects", { headers: phone })).status, 401);
    assert.equal((await call(`${phonePreview.content}api/projects`, { headers: REMOTE })).status, 404, "登出之后,它开过的预览不作数");
    assert.equal((await call(`${phonePreview.nav}headers`, { headers: REMOTE })).status, 404, "地址栏那条道也是");
    assert.equal((await call(`${mine.content}api/remote-access`)).status, 200, "本机开的那张不受牵连");
  }

  // ── ④ 移除设备:开着的连接一起断 ────────────────────────────────────────
  {
    const tablet = pair("平板");
    const preview = await openPreview(tablet);
    const socket = await openSocket(`${preview.content}socket`, REMOTE);
    assert.equal(await socket.echo("before"), "before");
    const stream = await openStream(`${preview.content}stream`, REMOTE);
    assert.equal(stream.status, 200);
    const events = await openStream(`${preview.content}api/events`, REMOTE);
    assert.equal(events.status, 200, "ash 自己的事件流,经预览 /api 那一跳");
    assert.equal(echoes.size, 1);
    assert.equal(streams.size, 1);

    const id = listDevices().find((d) => d.name === "平板")!.id;
    assert.equal((await call(`/api/remote-access/devices/${id}`, { method: "DELETE" })).status, 200);
    await within(socket.closed, "被移除的设备开着的预览 WebSocket 没有被掐断");
    await within(stream.closed, "被移除的设备还在流的预览应答没有被掐断");
    await within(events.closed, "被移除的设备经预览开着的事件流没有被掐断");
    await quiet(() => echoes.size === 0, "上游那一头的 WebSocket 也要断");
    await quiet(() => streams.size === 0, "上游那一头还在流的应答也要断");
    assert.equal((await call(`${preview.content}headers`, { headers: REMOTE })).status, 404);
    await assert.rejects(openSocket(`${preview.content}socket`, REMOTE), /升级被拒/, "旧地址再连不上");
  }

  // ── ⑤ 换访问密钥 ────────────────────────────────────────────────────────
  {
    const script = { ...REMOTE, authorization: `Bearer ${ensureRemoteAccessKey()}` };
    const opened = await call("/api/tasks/t1/preview/open/web", { headers: script });
    assert.equal(opened.status, 302, opened.text);
    const keyNav = opened.location!;
    const keyStream = await openStream(`${keyNav}stream`, REMOTE);
    assert.equal(keyStream.status, 200);
    const mine = await openPreview({});
    const mineStream = await openStream(`${mine.content}stream`, {});
    assert.equal((await call("/api/remote-access/rotate", { method: "POST" })).status, 200);
    await within(keyStream.closed, "凭旧密钥开的预览连接没有被掐断");
    assert.equal((await call(`${keyNav}headers`, { headers: REMOTE })).status, 404, "凭旧密钥开的预览作废");
    assert.equal((await call(`${mine.content}headers`)).status, 200, "本机开的不受换密钥牵连");

    // ── ⑥ 没有事件可等的失效:定时那一遍核出来 ─────────────────────────────
    let closed = false;
    void mineStream.closed.then(() => { closed = true; });
    await sweepChannels();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, false, "还作数的连接,复核不动它");
    writePreview("gen-2");
    await sweepChannels();
    await within(mineStream.closed, "预览换了一代,借着旧凭证的连接没有被掐断");
  }

  console.log("test-preview-revocation ok");
} finally {
  direct.destroy();
  for (const socket of [...upstreamSockets, ...echoes]) socket.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
