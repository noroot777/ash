// 自用模式的身份判定回归。要钉住的只有一句话:
//
//   **连得上端口不算机主。** 机主 = 请求确实从 ash 所在的那台机器直接发出,或者是机主
//   放进来的设备,或者拿得出访问密钥(server/src/auth/remote-access.ts)。
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
//   ⑥ 配对:申请要机主点了「允许」才领得到凭证;一次性码只兑一次;放不放谁、名册里有谁
//      匿名一概碰不到;移除一台设备,它的凭证和开着的长连接一起断。
//   ⑦ 换密钥:旧密钥和凭它进来的设备当场失效,机主亲手放进来的不受牵连。
//   ⑧ 免登录名单里「路由自己验凭证」的那条(/restart-impact):自用模式的匿名同样要验。
//   ⑨ 多人模式没有设备配对。
//
// 跑法(不设 ASH_DB 时自己开一个临时库):
//   npm -w server run test:remote-access
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { Agent, request as httpRequest, type IncomingMessage, type Server } from "node:http";
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
const pairing = await import("../src/auth/remote-pairing.js");

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
// 一条开着不关的长连接(事件流的替身)。
api.get("/stream", () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": open\n\n")) }), {
  headers: { "content-type": "text/event-stream" },
}));
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
/** 开一条长连接,回「应答头到了」之后的那个响应;`closed` 在连接被掐断时兑现。 */
function openStream(path: string, opts: { address?: string; headers?: Record<string, string> }): Promise<{ res: IncomingMessage; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: opts.address ?? "127.0.0.1", port, path, agent: direct, headers: opts.headers }, (res) => {
      res.resume();
      resolve({ res, closed: new Promise<void>((done) => res.once("close", () => done())) });
    });
    req.on("error", reject);
    req.end();
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
    assert.equal((await call("/", remote)).text, "shell", `${remote.name}:壳要打得开(配对页就渲染在它里面)`);
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

    // 凭密钥进来的设备能用,但读不到密钥、也换不了它。它在名册里,认得出哪台是自己。
    const peek = await call("/api/remote-access", { ...remote, headers: cookie });
    assert.equal(peek.body.local, false);
    assert.equal(peek.body.key, undefined);
    const mine = (peek.body.devices as { via: string; current: boolean }[]).filter((d) => d.current);
    assert.deepEqual(mine.map((d) => d.via), ["key"], `${remote.name}:粘密钥进来的浏览器登记成一台设备`);
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

  // ── ⑥ 配对 ──────────────────────────────────────────────────────────────
  const outsider = REMOTE[0]!;
  const phone = {
    ...outsider,
    headers: {
      ...outsider.headers,
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
  };
  type Device = { id: string; name: string; via: string; current: boolean };
  const roster = async (headers?: Record<string, string>) =>
    (await call("/api/remote-access", headers ? { ...outsider, headers } : {})).body.devices as Device[];

  // 申请 → 允许 → 领凭证。
  const ticket = await call("/api/auth/pair", { ...phone, method: "POST", body: {} });
  assert.equal(ticket.status, 200, ticket.text);
  assert.match(String(ticket.body.code), /^\d{4}$/, "两边核对用的四位数");
  const asked = (await call("/api/remote-access/requests")).body.requests as { id: string; name: string; code: string }[];
  assert.deepEqual(
    asked.map((r) => [r.id, r.name, r.code]), [[ticket.body.id, "iPhone · Safari", ticket.body.code]],
    "机主看到的是认得出的名字和同一个数",
  );
  const ticketOf = { id: ticket.body.id, secret: ticket.body.secret };
  const approvePath = `/api/remote-access/requests/${String(ticket.body.id)}/approve`;
  // 申请的人自己批不了,也看不到别人的申请和名册。
  assert.equal((await call(approvePath, { ...phone, method: "POST" })).status, 401, "匿名批不了自己");
  assert.equal((await call("/api/remote-access/requests", phone)).status, 401);
  assert.equal((await call("/api/remote-access/pair-code", { ...phone, method: "POST" })).status, 401, "匿名出不了码");
  const early = await call("/api/auth/pair/claim", { ...phone, method: "POST", body: ticketOf });
  assert.equal(early.body.status, "pending");
  assert.equal(early.cookie, null, "机主没点头之前什么都领不到");
  assert.equal((await call("/api/canary", phone)).status, 401);

  assert.equal((await call(approvePath, { method: "POST" })).status, 200);
  assert.equal((await call(approvePath, { method: "POST" })).status, 404, "一张申请只决定一次");
  const thief = await call("/api/auth/pair/claim", { ...phone, method: "POST", body: { ...ticketOf, secret: "guess" } });
  assert.equal(thief.body.status, "gone", "只知道申请号、没有 secret 的领不走别人的批准");
  assert.equal(thief.cookie, null);
  const claimed = await call("/api/auth/pair/claim", { ...phone, method: "POST", body: ticketOf });
  assert.equal(claimed.body.status, "approved", claimed.text);
  assert.ok(claimed.cookie);
  const paired = { ...outsider.headers, cookie: claimed.cookie };
  assert.equal((await call("/api/canary", { ...outsider, headers: paired })).status, 200, "配对后凭 cookie 进");
  assert.equal(
    (await call("/api/canary", { ...outsider, headers: { ...outsider.headers, authorization: `Bearer ${String(claimed.body.token)}` } })).status,
    200, "手机 app 带不了 cookie,同一把凭证当 Bearer 用",
  );
  assert.equal(
    (await call("/api/auth/pair/claim", { ...phone, method: "POST", body: ticketOf })).body.status, "gone",
    "批准只兑一次凭证",
  );
  assert.deepEqual(
    (await roster(paired)).filter((d) => d.current).map((d) => [d.name, d.via]), [["iPhone · Safari", "approval"]],
  );
  assert.equal((await call("/api/auth/pair", { method: "POST", body: {} })).status, 409, "本机不用配对");
  assert.equal((await call("/api/auth/pair", { ...outsider, method: "POST", body: {}, headers: paired })).status, 409, "已经进来的不重复配对");
  // 落盘的只有凭证的哈希。
  assert.equal(readFileSync(keyFile, "utf8").includes(String(claimed.body.token)), false, "设备凭证不落明文");

  // 递申请不要凭证,所以只收从认得的地址打开的页面递来的:DNS 重绑定能让机主自己的
  // 浏览器替攻击页递一张「来自本机」的申请,等机主顺手点允许。
  const rebound = { headers: { ...phone.headers, host: `rebind.example:${port}` } };
  const reboundAsk = await call("/api/auth/pair", { ...rebound, method: "POST", body: {} });
  assert.equal(reboundAsk.status, 403, `不认得的域名递不了申请 ${reboundAsk.text}`);
  assert.equal(((await call("/api/remote-access/requests")).body.requests as unknown[]).length, 0, "机主那边不该多出一张");
  // 这样的名字不是进不来:扫码(要机主手里的码)照样行,用过一次之后就认得了。
  const viaName = { headers: { ...phone.headers, host: `my-ash.example:${port}` } };
  assert.equal((await call("/api/auth/pair", { ...viaName, method: "POST", body: {} })).status, 403);
  const nameCode = await call("/api/remote-access/pair-code", { method: "POST" });
  const nameScan = await call("/api/auth/pair/redeem", { ...viaName, method: "POST", body: { code: nameCode.body.code } });
  assert.equal(nameScan.status, 200, nameScan.text);
  const nameHeaders = { ...viaName.headers, cookie: nameScan.cookie! };
  assert.equal((await call("/api/canary", { headers: nameHeaders })).status, 200);
  const nameAsk = await call("/api/auth/pair", { ...viaName, method: "POST", body: {} });
  assert.equal(nameAsk.status, 200, "机主带着凭证用过的名字就认得了");
  assert.equal((await call(`/api/remote-access/requests/${String(nameAsk.body.id)}/deny`, { method: "POST" })).status, 200);
  assert.equal((await call("/api/auth/pair", { ...rebound, method: "POST", body: {} })).status, 403, "别的域名照旧不认");
  const nameId = (await call("/api/remote-access", { headers: nameHeaders })).body.devices as Device[];
  assert.equal((await call(`/api/remote-access/devices/${nameId.find((d) => d.current)!.id}`, { method: "DELETE" })).status, 200);

  // 拒绝。
  const refusedTicket = await call("/api/auth/pair", { ...phone, method: "POST", body: { name: "阿明的平板" } });
  const refusedOf = { id: refusedTicket.body.id, secret: refusedTicket.body.secret };
  // 已经进来的设备也能替机主处理申请(进得来的本来就开得了终端)。
  const viaPaired = await call(`/api/remote-access/requests/${String(refusedTicket.body.id)}/deny`, { ...outsider, method: "POST", headers: paired });
  assert.equal(viaPaired.status, 200, viaPaired.text);
  assert.equal(viaPaired.body.name, "阿明的平板", "手机 app 自己报的名字");
  const refused = await call("/api/auth/pair/claim", { ...phone, method: "POST", body: refusedOf });
  assert.equal(refused.body.status, "denied");
  assert.equal(refused.cookie, null);

  // 扫码:机主出示的一次性码。
  const shownCode = await call("/api/remote-access/pair-code", { method: "POST" });
  assert.equal(shownCode.status, 200, shownCode.text);
  assert.ok(Array.isArray(shownCode.body.hosts));
  assert.equal((await call("/api/auth/pair/redeem", { ...phone, method: "POST", body: { code: "not-the-code" } })).status, 410);
  const scanned = await call("/api/auth/pair/redeem", { ...phone, method: "POST", body: { code: shownCode.body.code } });
  assert.equal(scanned.status, 200, scanned.text);
  assert.ok(scanned.cookie);
  const scannedHeaders = { ...outsider.headers, cookie: scanned.cookie };
  assert.equal((await call("/api/canary", { ...outsider, headers: scannedHeaders })).status, 200);
  assert.equal(
    (await call("/api/auth/pair/redeem", { ...phone, method: "POST", body: { code: shownCode.body.code } })).status, 410,
    "码只兑一次:被人拍走也没用",
  );
  assert.deepEqual((await roster(scannedHeaders)).filter((d) => d.current).map((d) => d.via), ["code"]);

  // 过期与上限(直接拨时钟)。
  {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const stale = pairing.openPairRequest({ name: "x", address: "10.0.0.1" }, t0)!;
    assert.equal(pairing.claimPairRequest(stale.id, stale.secret, "10.0.0.1", t0 + 10 * 60_000).status, "gone", "申请十分钟后作废");
    const staleCode = pairing.mintPairCode(t0);
    assert.equal(pairing.redeemPairCode(staleCode.code, { name: "x", address: "10.0.0.1" }, t0 + 5 * 60_000), null, "码五分钟后作废");
    const t1 = t0 + 60 * 60_000;
    for (let i = 0; i < 3; i++) assert.ok(pairing.openPairRequest({ name: "x", address: "10.0.0.2" }, t1));
    assert.equal(pairing.openPairRequest({ name: "x", address: "10.0.0.2" }, t1), null, "同一个地址刷不满机主的待办");
    for (let i = 0; i < 5; i++) assert.ok(pairing.openPairRequest({ name: "x", address: `10.0.1.${i}` }, t1));
    assert.equal(pairing.openPairRequest({ name: "x", address: "10.0.2.1" }, t1), null, "总数也有上限");
    assert.equal(pairing.pendingPairRequests(t1 + 10 * 60_000).length, 0);
  }

  // 移除一台设备:凭证作废,它开着的长连接一并掐断。
  const stream = await openStream("/api/stream", { ...outsider, headers: scannedHeaders });
  assert.equal(stream.res.statusCode, 200);
  const scannedId = (await roster(scannedHeaders)).find((d) => d.current)!.id;
  assert.equal((await call(`/api/remote-access/devices/${scannedId}`, { ...phone, method: "DELETE" })).status, 401, "匿名请不走别人");
  const removed = await call(`/api/remote-access/devices/${scannedId}`, { method: "DELETE" });
  assert.equal(removed.status, 200, removed.text);
  assert.equal((removed.body.devices as Device[]).some((d) => d.id === scannedId), false);
  await Promise.race([
    stream.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("被移除的设备还开着的长连接没有被掐断")), 3_000)),
  ]);
  assert.equal((await call("/api/canary", { ...outsider, headers: scannedHeaders })).status, 401, "被移除的设备当场进不来");
  assert.equal((await call(`/api/remote-access/devices/${scannedId}`, { method: "DELETE" })).status, 404);

  // ── ⑦ 换密钥:旧密钥和凭它进来的设备当场失效 ──────────────────────────────
  const via = REMOTE[0]!;
  const oldLogin = await call("/api/auth/login", { ...via, method: "POST", body: { key } });
  const oldCookie = { ...via.headers, cookie: oldLogin.cookie! };
  assert.equal((await call("/api/canary", { ...via, headers: oldCookie })).status, 200);
  const rotated = await call("/api/remote-access/rotate", { method: "POST" });
  assert.equal(rotated.status, 200, rotated.text);
  const nextKey = String(rotated.body.key);
  assert.notEqual(nextKey, key);
  assert.equal((await call("/api/canary", { ...via, headers: { ...via.headers, authorization: `Bearer ${key}` } })).status, 401, "旧密钥");
  assert.equal((await call("/api/canary", { ...via, headers: oldCookie })).status, 401, "粘旧密钥进来的浏览器");
  assert.equal((await call("/api/auth/login", { ...via, method: "POST", body: { key } })).status, 401);
  assert.equal((await call("/api/canary", { ...via, headers: { ...via.headers, authorization: `Bearer ${nextKey}` } })).status, 200);
  assert.equal((await call("/api/canary")).status, 200, "本机不受换密钥影响");
  assert.equal((await call("/api/canary", { ...outsider, headers: paired })).status, 200, "机主点过「允许」的设备不靠密钥,不受牵连");
  assert.deepEqual((rotated.body.devices as Device[]).map((d) => d.via), ["approval"]);

  // 登出 = 这台设备自己退出名册。
  assert.equal((await call("/api/auth/logout", { ...outsider, method: "POST", headers: paired })).status, 200);
  assert.equal((await call("/api/canary", { ...outsider, headers: paired })).status, 401);
  assert.deepEqual(await roster(), []);

  // ── ⑧ 名单只放行路径形状,凭证在路由里验 —— 自用模式的匿名也不例外 ─────────
  // /restart-impact 住在 routes.ts 自己身上,所以挂真的那张 `api`。进程内派发 + 非回环
  // Host 就是匿名(判据见 ①),不必为它再起一个 server。
  const { api: realApi } = await import("../src/routes.js");
  const real = new Hono();
  real.use("*", authGate());
  real.route("/api", realApi);
  const peeked = await real.request("http://192.168.1.20:4317/api/restart-impact");
  assert.equal(peeked.status, 401, `别的机器不带凭证看不到「谁在跑」:${await peeked.text()}`);
  assert.equal((await real.request("http://localhost:4317/api/restart-impact")).status, 200, "本机的重启脚本照常问得到");

  // ── ⑨ 多人模式没有设备配对:那边每个人凭自己的 key 登录 ─────────────────────
  await mode.setInstanceMode("multi", join(stage, "root"));
  for (const path of ["/api/auth/pair", "/api/auth/pair/claim", "/api/auth/pair/redeem"]) {
    assert.equal((await call(path, { ...outsider, method: "POST", body: {} })).status, 409, `多人模式 ${path}`);
  }
  assert.equal((await call("/api/remote-access/requests", outsider)).status, 401);
} finally {
  direct.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("test-remote-access ok");
