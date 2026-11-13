// 自用模式的身份判定回归。要钉住的只有一句话:
//
//   **连得上端口不算机主。** 机主 = 请求确实从 ash 所在的那台机器直接发出,或者拿得出
//   访问密钥(server/src/auth/remote-access.ts)。
//
// 这条原先不成立:自用模式下鉴权闸整条穿透,而服务监听所有网卡 —— 局域网里任何一台机器
// 都能派任务、读代码、开终端。所以这里**走真实的 TCP 连接**(起一个监听所有网卡的 server),
// 而不是只调 `app.fetch`:进程内派发没有 socket,恰好是判据里按本机算的那一档,测不出
// 「从网络上来的请求」这一半。
//
//   ① 判据本体(纯函数):回环 socket 之外还要看 Host 与转发头;地址读不到按不可信算。
//   ② 首启:还没人认领的实例,别的机器抢不走(`/auth/setup` 不对匿名开放)。
//   ③ 本机直连照旧零摩擦;别的来路(转发头 / Host 不是回环 / 真的从网卡地址连进来)
//      一律 401,只碰得到免登录名单和 SPA 壳。
//   ④ 访问密钥:Bearer 与网页登录(cookie)两条路都进得来;密钥只在本机读得到、换得了。
//   ⑤ 浏览器自动带上的身份(本机直连、cookie)写操作要过跨站判定;Bearer 不用。
//   ⑥ 换密钥:旧密钥和它换出来的会话当场失效。
//   ⑦ 免登录名单里「路由自己验凭证」的那条(/restart-impact):自用模式的匿名同样要验。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:remote-access
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { Agent, request as httpRequest, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-remote-access-"));
process.env.ASH_DB ||= join(stage, "remote-access.db");
requireTmpDb("test-remote-access");

const { ensureSchema } = await import("../src/db/index.js");
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const mode = await import("../src/auth/mode.js");
const { authGate } = await import("../src/auth/middleware.js");
const { mountAuthRoutes } = await import("../src/auth/routes.js");
const { isLocalDirectOrigin, isLoopbackHost } = await import("../src/auth/remote-access.js");

await ensureSchema();

// ── ① 判据本体 ─────────────────────────────────────────────────────────────
{
  const local = { remoteAddress: "127.0.0.1", host: "localhost:4317", forwarded: false };
  assert.equal(isLocalDirectOrigin(local), true);
  assert.equal(isLocalDirectOrigin({ ...local, remoteAddress: "::1", host: "[::1]:4317" }), true);
  assert.equal(isLocalDirectOrigin({ ...local, remoteAddress: "::ffff:127.0.0.1", host: "127.0.0.1:4317" }), true);
  assert.equal(isLocalDirectOrigin({ ...local, remoteAddress: "192.168.1.20" }), false, "别的机器连进来不是本机");
  assert.equal(isLocalDirectOrigin({ ...local, remoteAddress: "100.101.102.103" }), false, "tailnet 地址也不是本机");
  assert.equal(isLocalDirectOrigin({ ...local, forwarded: true }), false, "同机反代转进来的不算直连");
  assert.equal(isLocalDirectOrigin({ ...local, host: "evil.example:4317" }), false, "DNS 重绑定:Host 是攻击者的域名");
  assert.equal(isLocalDirectOrigin({ ...local, host: "my-mac.tailnet.ts.net" }), false, "保留对外 Host 的反代");
  assert.equal(isLocalDirectOrigin({ ...local, host: undefined }), false);
  // 发完就断开的连接读不到对端地址。按本机算的话,「断得够快」就成了一条绕过。
  assert.equal(isLocalDirectOrigin({ ...local, remoteAddress: undefined }), false, "地址读不到按不可信算");
  // 进程内派发(没有 socket)按本机算,但 Host / 转发头照样要过。
  assert.equal(isLocalDirectOrigin({ ...local, remoteAddress: null }), true);
  assert.equal(isLocalDirectOrigin({ ...local, remoteAddress: null, host: "evil.example" }), false);

  for (const host of ["localhost", "LOCALHOST:4317", "localhost.:80", "127.0.0.1", "127.8.9.1:1", "127.1:4317", "[::1]:4317"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["", "evil.example", "localhost.evil.example", "127.0.0.1.evil.example", "192.168.1.5:4317", "0.0.0.0", "[::]:4317", "[fe80::1]"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
}

// ── 真实连接的舞台 ──────────────────────────────────────────────────────────
const api = new Hono();
mountAuthRoutes(api);
// 闸下的普通数据端点替身(测的是闸,不是某条业务路由)。
api.get("/canary", (c) => c.json({ secret: "任务标题" }));
api.post("/canary", (c) => c.json({ wrote: true }));
// 免登录名单里的一条(接力的本机公开身份),替身。它得一直对匿名开着。
api.get("/handoff/identity", (c) => c.json({ fingerprint: "stub" }));
const app = new Hono();
app.use("*", authGate());
app.route("/api", api);
app.get("/review/*", (c) => c.text("video"));
app.get("/*", (c) => c.text("shell"));

const server = serve({ fetch: app.fetch, port: 0, hostname: "0.0.0.0" }) as Server;
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
const port = (server.address() as { port: number }).port;
// 这台机器的一个非回环 IPv4:从它连进来,服务端看到的对端地址就不是回环 —— 和另一台
// 机器连进来是同一条判据路径。没有网卡的环境(断网沙箱)跳过这一半,转发头那一半仍在。
const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? null;

// 必须是**自己的** agent:`NODE_USE_ENV_PROXY=1` 会把默认的 globalAgent 接到系统代理上,
// 打给本机的请求就绕出去了一圈(缘由同 src/preview-probe.ts)—— 那样测到的是代理,不是闸。
const direct = new Agent();

type Res = { status: number; body: Record<string, unknown>; text: string; cookie: string | null };
/** 用 node:http 而不是 fetch:fetch 不让改 Host 头,而 Host 正是判据的一部分。 */
function call(
  path: string,
  opts: { method?: string; address?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Res> {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: opts.address ?? "127.0.0.1", port, path, method: opts.method ?? "GET", agent: direct,
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
/** 「不是本机直连」的三种来路。每一种都得落到同一个结论上。 */
const REMOTE: { name: string; address?: string; headers: Record<string, string> }[] = [
  { name: "同机反代(带 X-Forwarded-For)", headers: { "x-forwarded-for": "203.0.113.9" } },
  { name: "Host 不是回环(DNS 重绑定 / 保留 Host 的反代)", headers: { host: `evil.example:${port}` } },
  ...(lan ? [{ name: `从网卡地址 ${lan} 连进来`, address: lan, headers: {} }] : []),
];
if (!lan) console.log("（这台机器没有非回环 IPv4，跳过「从网卡地址连进来」那一路）");

try {
  // ── ② 首启:还没人认领的实例,别的机器抢不走 ────────────────────────────────
  assert.equal((await mode.instanceConfig()).mode, "", "前提:模式还没定");
  for (const remote of REMOTE) {
    const state = await call("/api/auth/state", remote);
    assert.equal(state.status, 200);
    assert.equal(state.body.needsAccessKey, true, `${remote.name}:首启也得先认出机主`);
    const grab = await call("/api/auth/setup", {
      ...remote, method: "POST",
      body: { mode: "multi", adminName: "Hijacked", rootDir: join(stage, "root"), dirName: "hijacked" },
    });
    assert.equal(grab.status, 401, `${remote.name}:匿名不许认领实例 ${grab.text}`);
  }
  mode.invalidateInstanceConfig();
  assert.equal((await mode.instanceConfig()).mode, "", "被拒的 setup 不许把模式翻掉");
  // 本机照常走完首启。
  const setup = await call("/api/auth/setup", { method: "POST", body: { mode: "single" } });
  assert.equal(setup.status, 200, setup.text);
  assert.equal(setup.body.needsAccessKey, false);

  // ── ③ 本机直连零摩擦;别的来路只碰得到免登录名单和壳 ──────────────────────
  assert.equal((await call("/api/canary")).status, 200, "本机直连照旧打开就用");
  assert.equal((await call("/api/canary", { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await call("/api/canary", { method: "POST", body: {} })).status, 200);
  assert.equal((await app.request("/api/canary")).status, 200, "进程内派发(没有 socket)按本机算");
  for (const remote of REMOTE) {
    const read = await call("/api/canary", remote);
    assert.equal(read.status, 401, `${remote.name}:读 ${read.text}`);
    assert.equal(read.body.needsAuth, true);
    assert.equal(read.body.secret, undefined);
    assert.match(String(read.body.error), /访问密钥/, "401 要说清去哪拿、怎么带");
    assert.equal((await call("/api/canary", { ...remote, method: "POST", body: {} })).status, 401, `${remote.name}:写`);
    assert.equal((await call("/api/remote-access", remote)).status, 401, `${remote.name}:密钥端点不在免登录名单里`);
    assert.equal((await call("/review/current/a.mp4", remote)).status, 401, `${remote.name}:待审视频`);
    assert.equal((await call("/api/handoff/identity", remote)).status, 200, `${remote.name}:接力身份仍对匿名开着`);
    assert.equal((await call("/", remote)).text, "shell", `${remote.name}:壳要打得开(访问密钥页就渲染在它里面)`);
    const state = await call("/api/auth/state", remote);
    assert.deepEqual(
      { mode: state.body.mode, needsAccessKey: state.body.needsAccessKey, needsOnboarding: state.body.needsOnboarding },
      { mode: "single", needsAccessKey: true, needsOnboarding: false },
    );
  }

  // ── ④ 访问密钥 ──────────────────────────────────────────────────────────
  const shown = await call("/api/remote-access");
  assert.equal(shown.status, 200);
  assert.equal(shown.body.local, true);
  const key = String(shown.body.key);
  assert.match(key, /^ash_[\w-]{43}$/, "和个人 key 同一种形状,手机端那一栏照填");
  assert.equal((await call("/api/remote-access")).body.key, key, "再看一次还是这一把,不是每看一次换一把");
  const keyFile = `${process.env.ASH_DB}.remote-access.json`;
  assert.equal(existsSync(keyFile), true, "密钥落在库文件旁边,不进库");
  assert.equal((JSON.parse(readFileSync(keyFile, "utf8")) as { key: string }).key, key);
  if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600);

  for (const remote of REMOTE) {
    const bearer = { ...remote.headers, authorization: `Bearer ${key}` };
    assert.equal((await call("/api/canary", { ...remote, headers: bearer })).status, 200, `${remote.name}:Bearer`);
    assert.equal(
      (await call("/api/canary", { ...remote, headers: { ...remote.headers, authorization: `Bearer ${key}x` } })).status,
      401, `${remote.name}:错的密钥`,
    );
    assert.equal((await call("/api/auth/state", { ...remote, headers: bearer })).body.needsAccessKey, false);

    const wrong = await call("/api/auth/login", { ...remote, method: "POST", body: { key: "ash_nope" } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.cookie, null, "登录失败不许种 cookie");
    const login = await call("/api/auth/login", { ...remote, method: "POST", body: { key } });
    assert.equal(login.status, 200, login.text);
    assert.ok(login.cookie, "登录成功要种会话 cookie");
    assert.equal(login.cookie.includes(key), false, "cookie 里不许是密钥本身");
    const cookie = { ...remote.headers, cookie: login.cookie };
    assert.equal((await call("/api/canary", { ...remote, headers: cookie })).status, 200, `${remote.name}:cookie`);

    // 凭密钥进来的设备能用,但读不到密钥、也换不了它。
    const peek = await call("/api/remote-access", { ...remote, headers: cookie });
    assert.deepEqual(peek.body, { local: false });
    assert.equal((await call("/api/remote-access/rotate", { ...remote, method: "POST", headers: cookie })).status, 403);
    assert.equal((await call("/api/remote-access/rotate", { ...remote, method: "POST", headers: bearer })).status, 403);

    // ── ⑤ 跨站判定:浏览器自动带上的身份才查 ──────────────────────────────
    const crossSite = { "sec-fetch-site": "cross-site" };
    assert.equal(
      (await call("/api/canary", { ...remote, method: "POST", body: {}, headers: { ...cookie, ...crossSite } })).status,
      403, `${remote.name}:cookie + 跨站写`,
    );
    assert.equal(
      (await call("/api/canary", { ...remote, method: "POST", body: {}, headers: { ...bearer, ...crossSite } })).status,
      200, `${remote.name}:Bearer 不是浏览器自动带的,不查`,
    );
    assert.equal((await call("/api/canary", { ...remote, method: "POST", body: {}, headers: cookie })).status, 200);
  }
  // 本机直连同理:机主的浏览器替别的站点打进回环,和带着 cookie 是一回事。
  const driveBy = await call("/api/canary", { method: "POST", body: {}, headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(driveBy.status, 403, "别的站点驱动机主的浏览器写本机 ash");
  assert.match(String(driveBy.body.error), /跨站请求已被拒绝/);
  assert.equal(
    (await call("/api/canary", { method: "POST", body: {}, headers: { origin: "https://evil.example" } })).status,
    403, "老浏览器没有 Sec-Fetch-*,退到比对 Origin",
  );
  assert.equal(
    (await call("/api/canary", { method: "POST", body: {}, headers: { "sec-fetch-site": "same-origin" } })).status,
    200, "页面自己发的照常放行",
  );

  // ── ⑥ 换密钥:旧的和它换出来的会话当场失效 ──────────────────────────────
  const via = REMOTE[0]!;
  const oldLogin = await call("/api/auth/login", { ...via, method: "POST", body: { key } });
  const oldCookie = { ...via.headers, cookie: oldLogin.cookie! };
  assert.equal((await call("/api/canary", { ...via, headers: oldCookie })).status, 200);
  const rotated = await call("/api/remote-access/rotate", { method: "POST" });
  assert.equal(rotated.status, 200, rotated.text);
  const nextKey = String(rotated.body.key);
  assert.notEqual(nextKey, key);
  assert.equal((await call("/api/canary", { ...via, headers: { ...via.headers, authorization: `Bearer ${key}` } })).status, 401, "旧密钥");
  assert.equal((await call("/api/canary", { ...via, headers: oldCookie })).status, 401, "旧密钥换出来的会话");
  assert.equal((await call("/api/auth/login", { ...via, method: "POST", body: { key } })).status, 401);
  assert.equal((await call("/api/canary", { ...via, headers: { ...via.headers, authorization: `Bearer ${nextKey}` } })).status, 200);
  assert.equal((await call("/api/canary")).status, 200, "本机不受换密钥影响");

  // ── ⑦ 名单只放行路径形状,凭证在路由里验 —— 自用模式的匿名也不例外 ─────────
  // /restart-impact 住在 routes.ts 自己身上,所以挂真的那张 `api`。进程内派发 + 非回环
  // Host 就是匿名(判据见 ①),不必为它再起一个 server。
  const { api: realApi } = await import("../src/routes.js");
  const real = new Hono();
  real.use("*", authGate());
  real.route("/api", realApi);
  const peeked = await real.request("http://192.168.1.20:4317/api/restart-impact");
  assert.equal(peeked.status, 401, `别的机器不带凭证看不到「谁在跑」:${await peeked.text()}`);
  assert.equal((await real.request("http://localhost:4317/api/restart-impact")).status, 200, "本机的重启脚本照常问得到");
} finally {
  direct.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("test-remote-access ok");
