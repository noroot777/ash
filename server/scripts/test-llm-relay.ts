import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { closeRelayDispatchers, relayErrorResponse, relayFetch, RelayRequestError } from "../src/llm-relay.js";
import { parseGnomeProxy, refreshSystemProxy, setSystemProxyReaderForTests, type SystemProxySettings } from "../src/system-proxy.js";

const warnings: string[] = [];
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
console.warn = (message: unknown) => { warnings.push(String(message)); };
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("[ash]")) warnings.push(line);
  else originalLog(...args);
};
// 本测试不读本机真实的系统代理：默认「系统没配」，用到时逐段换
let systemProxy: SystemProxySettings = { platform: "测试", http: null, https: null, bypass: [], unsupported: [] };
let systemProxyFailure: Error | null = null;
const systemProxyReader = async () => {
  if (systemProxyFailure) throw systemProxyFailure;
  return systemProxy;
};
setSystemProxyReaderForTests(systemProxyReader, 60_000);
const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "ASH_LLM_RELAY_HEADERS_TIMEOUT_MS", "ASH_LLM_RELAY_BODY_TIMEOUT_MS"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const sockets = new Set<Socket>();
const calls: { path: string; method: string; socket: Socket }[] = [];
let slowStarted: (() => void) | undefined;
const heldRedirects: import("node:http").ServerResponse[] = [];
let abortClosed: (() => void) | undefined;
const upstream = createServer(async (request, response) => {
  calls.push({ path: request.url ?? "", method: request.method ?? "", socket: request.socket });
  for await (const _chunk of request) { }
  if (request.url?.startsWith("/redirect?to=")) {
    response.writeHead(302, { location: decodeURIComponent(request.url.slice("/redirect?to=".length)) });
    response.end();
    return;
  }
  if (request.url === "/held-redirect") {
    heldRedirects.push(response);
    return;
  }
  if (request.url === "/hang") {
    slowStarted?.();
    return;
  }
  if (request.url === "/stream") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    setTimeout(() => response.end("data: last\n\n"), 120);
    return;
  }
  if (request.url === "/heartbeat") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    let chunks = 0;
    const timer = setInterval(() => {
      chunks += 1;
      if (chunks === 12) response.end("data: last\n\n");
      else response.write(": ping\n\n");
    }, 80);
    response.on("close", () => clearInterval(timer));
    return;
  }
  if (request.url === "/idle") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    return;
  }
  if (request.url === "/abort" || request.url === "/cancel") {
    response.on("close", () => abortClosed?.());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: waiting\n\n");
    return;
  }
  if (request.url === "/broken-stream") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    setTimeout(() => response.destroy(), 30);
    return;
  }
  if (request.url === "/unavailable") {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"upstream unavailable"}');
    return;
  }
  if (request.url === "/empty") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}');
});
upstream.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("upstream did not listen");
const origin = `http://127.0.0.1:${address.port}`;
const proxy = createServer();
let proxyAuthority = "";
let proxyAuthorization = "";
// 代理 CONNECT 隧道打到上游的那一端端口：上游看到的来源端口在这里面 = 这个请求确实经过了代理。
// 隧道会 keep-alive 复用，所以「有没有新的 CONNECT」不能代替这个判断
const proxyTunnelPorts = new Set<number>();
const lastCallViaProxy = () => proxyTunnelPorts.has(calls.at(-1)!.socket.remotePort ?? -1);
const tunnelSockets = new Set<Duplex>();
const proxyTunnels: { authorization: string; client: Duplex }[] = [];
proxy.on("connect", (request, client, head) => {
  proxyAuthority = request.url ?? "";
  proxyAuthorization = request.headers["proxy-authorization"] ?? "";
  proxyTunnels.push({ authorization: proxyAuthorization, client });
  const target = connect(address.port, "127.0.0.1", () => {
    if (target.localPort) proxyTunnelPorts.add(target.localPort);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) target.write(head);
    target.pipe(client);
    client.pipe(target);
  });
  for (const socket of [client, target]) {
    tunnelSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { tunnelSockets.delete(socket); client.destroy(); target.destroy(); });
  }
});

try {
  process.env.http_proxy = process.env.HTTP_PROXY = "http://127.0.0.1:1";
  process.env.https_proxy = process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  process.env.no_proxy = process.env.NO_PROXY = "only-remote-provider.test";
  delete process.env.ASH_LLM_RELAY_HEADERS_TIMEOUT_MS;
  delete process.env.ASH_LLM_RELAY_BODY_TIMEOUT_MS;

  const globalDispatcher = getGlobalDispatcher();
  const blocked = new MockAgent();
  blocked.disableNetConnect();
  setGlobalDispatcher(blocked);
  try {
    await assert.rejects(fetch(`${origin}/healthy`));
    const isolated = await relayFetch(`${origin}/healthy`, {});
    assert.equal(isolated.status, 200);
    assert.deepEqual(await isolated.json(), { ok: true });
    assert.match(isolated.headers.get("x-ash-relay-request-id") ?? "", /^[a-f0-9-]{36}$/);
  } finally {
    setGlobalDispatcher(globalDispatcher);
    await blocked.close();
  }
  console.log("  ✓ 转发独立于全局连接池，本地供应商不绕系统代理");

  const reusedSockets = new Set<Socket>();
  for (let index = 0; index < 8; index += 1) {
    const reused = await relayFetch(`${origin}/healthy`, { method: "POST", body: "inference-request" });
    assert.deepEqual(await reused.json(), { ok: true });
    reusedSockets.add(calls.at(-1)!.socket);
  }
  assert(reusedSockets.size <= 2, `连续请求应复用 keep-alive 连接，实际用了 ${reusedSockets.size} 条`);
  console.log("  ✓ 同一供应商的连续推理请求复用独立连接池，不重复建连");

  const started = new Promise<void>((resolve) => { slowStarted = resolve; });
  const headerTimeoutSurvivor = await relayFetch(`${origin}/heartbeat`, {});
  const headerTimeoutSurvivorText = headerTimeoutSurvivor.text();
  const hung = relayFetch(`${origin}/hang`, { method: "POST", body: "inference-request" }, { headersTimeoutMs: 150 });
  const hungFailure = assert.rejects(hung, (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.status, 504);
    assert.deepEqual(error.diagnostic.codes, ["ASH_RELAY_HEADERS_TIMEOUT"]);
    assert.match(error.message, /等待响应头超过 150ms/);
    assert.equal(relayErrorResponse(error).status, 504);
    return true;
  });
  await started;
  const healthy = await relayFetch(`${origin}/healthy`, {});
  assert.equal(await healthy.text(), '{"ok":true}');
  const hungCall = calls.find((entry) => entry.path === "/hang")!;
  assert.notEqual(hungCall.socket, calls.at(-1)!.socket);
  await hungFailure;
  assert.match(await headerTimeoutSurvivorText, /data: last/);
  assert.equal(calls.filter((entry) => entry.path === "/hang").length, 1);
  assert.equal(hungCall.method, "POST");
  const recovery = await relayFetch(`${origin}/healthy`, {});
  assert.equal(recovery.status, 200);
  await recovery.text();
  console.log("  ✓ 卡住的请求不拖住并行请求，超时返回 504，POST 不被自动重发");

  const stream = await relayFetch(`${origin}/stream`, {}, { headersTimeoutMs: 60 });
  assert.match(await stream.text(), /data: first[\s\S]*data: last/);
  const empty = await relayFetch(`${origin}/empty`, {});
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), "");
  console.log("  ✓ 响应头超时不截断已经开始的长流，空响应也正确释放连接");

  process.env.ASH_LLM_RELAY_BODY_TIMEOUT_MS = "200";
  const idle = await relayFetch(`${origin}/idle`, {});
  let idleGuard: ReturnType<typeof setTimeout> | undefined;
  const idleFailure = assert.rejects(Promise.race([
    idle.text(),
    new Promise<never>((_resolve, reject) => {
      idleGuard = setTimeout(() => reject(new Error("响应流没有触发空闲超时")), 3000);
    }),
  ]), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.phase, "stream");
    assert.equal(error.diagnostic.status, 504);
    assert(error.diagnostic.codes.includes("UND_ERR_BODY_TIMEOUT"));
    assert.match(error.message, /响应流空闲超过 200ms/);
    return true;
  }).finally(() => clearTimeout(idleGuard));
  const heartbeat = await relayFetch(`${origin}/heartbeat`, {}, { headersTimeoutMs: 60 });
  assert.match(await heartbeat.text(), /data: first[\s\S]*data: last/);
  await idleFailure;
  delete process.env.ASH_LLM_RELAY_BODY_TIMEOUT_MS;
  console.log("  ✓ 无数据的流触发空闲超时，持续有心跳的长流不被截断，并行流不受牵连");

  const cancelSurvivor = await relayFetch(`${origin}/heartbeat`, {});
  const cancelSurvivorText = cancelSurvivor.text();
  const controller = new AbortController();
  const disconnected = new Promise<void>((resolve) => { abortClosed = resolve; });
  const aborting = await relayFetch(`${origin}/abort`, { signal: controller.signal });
  const abortResult = assert.rejects(aborting.text(), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.status, 499);
    return true;
  });
  controller.abort();
  await abortResult;
  await disconnected;
  const canceled = new Promise<void>((resolve) => { abortClosed = resolve; });
  const canceling = await relayFetch(`${origin}/cancel`, {});
  const warningCount = warnings.length;
  await canceling.body!.cancel();
  await canceled;
  assert.equal(warnings.length, warningCount);
  assert.match(await cancelSurvivorText, /data: last/);
  console.log("  ✓ 客户端停止和响应取消都关闭上游连接，不制造伪网络报错");

  const broken = await relayFetch(`${origin}/broken-stream`, {});
  await assert.rejects(broken.text(), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.phase, "stream");
    assert(error.diagnostic.codes.includes("UND_ERR_SOCKET"));
    return true;
  });
  const unavailable = await relayFetch(`${origin}/unavailable`, {});
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), '{"error":"upstream unavailable"}');
  assert(warnings.some((entry) => entry.includes("HTTP_503")));
  console.log("  ✓ 流中途断开留下诊断，上游 HTTP 错误仍保持原样");

  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy did not listen");
  process.env.http_proxy = process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
  const proxied = await relayFetch(`http://provider.test:${address.port}/healthy`, {});
  assert.deepEqual(await proxied.json(), { ok: true });
  assert.equal(proxyAuthority, `provider.test:${address.port}`);
  console.log("  ✓ 远端供应商仍遵守 HTTP_PROXY 和 NO_PROXY 配置");

  const mappedUrl = `http://[::ffff:127.0.0.1]:${address.port}/healthy`;
  const mappedProxied = await relayFetch(mappedUrl, {});
  assert.deepEqual(await mappedProxied.json(), { ok: true });
  assert.equal(proxyAuthority, `[::ffff:7f00:1]:${address.port}`);
  process.env.no_proxy = process.env.NO_PROXY = "*";
  proxyAuthority = "";
  const wildcardBypass = await relayFetch(mappedUrl, {});
  assert.deepEqual(await wildcardBypass.json(), { ok: true });
  assert.equal(proxyAuthority, "", "NO_PROXY=* 应保持全局直连，而不是绕进 HTTP_PROXY");

  // ---- 系统代理：环境变量都没配时才生效，变化后刷新即切换 ----
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) delete process.env[key];
  const systemProxyUrl = `http://relay-user:system-proxy-secret@127.0.0.1:${proxyAddress.port}`;
  systemProxy = { platform: "测试", http: systemProxyUrl, https: systemProxyUrl, bypass: ["*.bypass.test"], unsupported: [] };
  await refreshSystemProxy();
  proxyAuthority = "";
  const viaSystem = await relayFetch(`http://provider.test:${address.port}/healthy`, {});
  assert.deepEqual(await viaSystem.json(), { ok: true });
  assert.equal(proxyAuthority, `provider.test:${address.port}`, "没配环境变量时走系统代理");
  assert.equal(proxyAuthorization, `Basic ${Buffer.from("relay-user:system-proxy-secret").toString("base64")}`);
  proxyAuthority = "";
  const localViaSystem = await relayFetch(`${origin}/healthy`, {});
  assert.deepEqual(await localViaSystem.json(), { ok: true });
  assert.equal(proxyAuthority, "", "系统代理开着时本机供应商仍直连");
  const mappedViaSystem = await relayFetch(mappedUrl, {});
  assert.deepEqual(await mappedViaSystem.json(), { ok: true });
  assert.equal(proxyAuthority, `[::ffff:7f00:1]:${address.port}`);

  systemProxy = { platform: "测试", http: null, https: null, bypass: [], unsupported: [] };
  await refreshSystemProxy();
  proxyAuthority = "";
  const afterDisable = await relayFetch(mappedUrl, {});
  assert.deepEqual(await afterDisable.json(), { ok: true });
  assert.equal(proxyAuthority, "", "系统代理关掉并刷新后，同一供应商改为直连");
  assert(!lastCallViaProxy());
  assert(warnings.some((line) => line.includes("代理来源：系统代理（测试）") && line.includes("http://***@127.0.0.1")));
  assert(warnings.some((line) => line.includes("代理来源：未配置代理")));
  console.log("  ✓ 未配置环境变量时走系统代理（带凭据），系统代理变化刷新后立即切换，本机供应商始终直连");

  // ---- 凭据原文送到代理（含 `%`、空字段）；换了凭据后旧 ProxyAgent 等在途请求结束再关 ----
  const remoteProviderOrigin = `http://provider.test:${address.port}`;
  const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const gnomeProxy = (user: string, password: string) => parseGnomeProxy([
    "org.gnome.system.proxy mode 'manual'", "org.gnome.system.proxy.http host '127.0.0.1'", `org.gnome.system.proxy.http port ${proxyAddress.port}`,
    "org.gnome.system.proxy.http use-authentication true",
    `org.gnome.system.proxy.http authentication-user '${user}'`, `org.gnome.system.proxy.http authentication-password '${password}'`,
  ].join("\n"));
  const useCredentials = async (user: string, password: string) => {
    systemProxy = gnomeProxy(user, password);
    await refreshSystemProxy();
  };
  const tunnelsClosed = async (authorization: string) => {
    for (let waited = 0; waited < 2_000; waited += 20) {
      if (proxyTunnels.filter((entry) => entry.authorization === authorization).every((entry) => entry.client.destroyed)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  for (const [user, password] of [["relay%user", "p%40ss"], ["me", ""], ["", ""], ["", "only-password"]]) {
    await useCredentials(user, password);
    const viaCredentials = await relayFetch(`${remoteProviderOrigin}/healthy`, {});
    assert.deepEqual(await viaCredentials.json(), { ok: true });
    assert.equal(proxyAuthorization, basic(user, password), `代理收到的凭据与系统里的原文一致（${JSON.stringify([user, password])}）`);
  }
  assert(await tunnelsClosed(basic("relay%user", "p%40ss")), "换掉的凭据对应的 ProxyAgent 没人用了就关");
  assert(await tunnelsClosed(basic("me", "")));
  assert(await tunnelsClosed(basic("", "")));
  // 在途请求还在用旧凭据的 agent：换凭据不关它，重定向下一跳照常经它发出，结束后才关
  const oldTunnels = () => proxyTunnels.filter((entry) => entry.authorization === basic("", "only-password")).length;
  const heldOnOldCredentials = relayFetch(`${remoteProviderOrigin}/held-redirect`, {});
  while (heldRedirects.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await useCredentials("next-user", "next-password");
  const withNewCredentials = await relayFetch(`${remoteProviderOrigin}/healthy`, {});
  assert.deepEqual(await withNewCredentials.json(), { ok: true });
  assert.equal(proxyAuthorization, basic("next-user", "next-password"));
  const tunnelsBeforeRedirect = oldTunnels();
  const heldResponse = heldRedirects.splice(0)[0];
  heldResponse.writeHead(302, { location: `${remoteProviderOrigin}/healthy` });
  heldResponse.end();
  const redirectedOnOld = await heldOnOldCredentials;
  assert.equal(redirectedOnOld.status, 200, "换凭据时在途请求的下一跳仍能经旧 agent 发出");
  assert.deepEqual(await redirectedOnOld.json(), { ok: true });
  assert.equal(oldTunnels(), tunnelsBeforeRedirect, "下一跳用的是原来那个 agent（复用它的隧道），没有被关掉再重建");
  assert(await tunnelsClosed(basic("", "only-password")), "在途请求结束后旧凭据的 agent 才关");
  process.env.HTTP_PROXY = `http://env-user@127.0.0.1:${proxyAddress.port}`;
  const envUserOnly = await relayFetch(`${remoteProviderOrigin}/healthy`, {});
  assert.deepEqual(await envUserOnly.json(), { ok: true });
  assert.equal(proxyAuthorization, basic("env-user", ""), "环境变量里只写了用户名的代理也照带认证");
  delete process.env.HTTP_PROXY;
  console.log("  ✓ 代理凭据原样送达（含百分号、空用户名/空密码/两项都空），换掉的代理实例等在途请求结束后关闭");

  // ---- 端口写法：GNOME 的 `主机:80` 只配显式写了 :80 的地址（首跳看请求原文，重定向那跳看 Location 原文） ----
  // 判成直连的那一跳直接连 provider.test:80（解析不了，失败）；走代理的那一跳由测试代理接到本机上游
  systemProxy = { ...gnomeProxy("u", "p"), bypass: ["provider.test:80"], bypassSyntax: "gnome" };
  await refreshSystemProxy();
  const expectDirectFailure = (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.deepEqual([error.diagnostic.proxy, error.diagnostic.bypass], ["direct", "system"], "显式 :80 命中 GNOME 的端口规则，直连");
    return true;
  };
  await assert.rejects(relayFetch("http://provider.test:80/healthy", {}), expectDirectFailure);
  await assert.rejects(relayFetch(`${remoteProviderOrigin}/redirect?to=${encodeURIComponent("http://provider.test:80/healthy")}`, {}), expectDirectFailure);
  const implicitPort = await relayFetch(`${remoteProviderOrigin}/redirect?to=${encodeURIComponent("http://provider.test/healthy")}`, {});
  assert.deepEqual(await implicitPort.json(), { ok: true }, "Location 没写端口：不命中 `主机:80`，照常经代理");
  assert(lastCallViaProxy());
  console.log("  ✓ GNOME 端口规则区分显式默认端口与没写端口，首跳与重定向那跳都按原文判");

  // ---- 读不到系统代理：不能把「没读到」当成「没配」去直连 ----
  systemProxy = { platform: "测试", http: systemProxyUrl, https: systemProxyUrl, bypass: [], unsupported: [] };
  await refreshSystemProxy();
  systemProxyFailure = Object.assign(new Error("denied"), { code: "EACCES" });
  await refreshSystemProxy();
  proxyAuthority = "";
  const keptProxy = await relayFetch(mappedUrl, {});
  assert.deepEqual(await keptProxy.json(), { ok: true });
  assert(lastCallViaProxy(), "刷新失败后仍经上次读到的系统代理，而不是直连");
  setSystemProxyReaderForTests(systemProxyReader, 60_000);
  const callsBeforeBlocked = calls.length;
  await assert.rejects(relayFetch(mappedUrl, { method: "POST", body: "inference-request" }), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.status, 502);
    assert.deepEqual(error.diagnostic.codes, ["ASH_SYSTEM_PROXY_UNAVAILABLE"]);
    assert.equal(error.diagnostic.proxy, "blocked", "没发出去的请求诊断里不写成直连");
    assert.match(error.message, /系统代理不可用，未转发（读取系统代理失败（EACCES）/);
    return true;
  });
  await assert.rejects(relayFetch(`${origin}/redirect?to=${encodeURIComponent(mappedUrl)}`, {}), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert(error.diagnostic.codes.includes("ASH_SYSTEM_PROXY_UNAVAILABLE"), "重定向到远端的那一跳同样拒绝");
    return true;
  });
  assert.deepEqual(calls.slice(callsBeforeBlocked).map((entry) => entry.path), [`/redirect?to=${encodeURIComponent(mappedUrl)}`], "首次读取失败时远端请求一个都没直连出去");
  const localWhileBlocked = await relayFetch(`${origin}/healthy`, {});
  assert.deepEqual(await localWhileBlocked.json(), { ok: true }, "本机供应商不受影响");
  systemProxyFailure = null;
  await refreshSystemProxy();
  console.log("  ✓ 系统代理读取失败：沿用上次有效配置；第一次就失败则拒绝远端请求（含重定向那一跳），不偷偷直连");

  // ---- 只有一个协议的地址写坏：另一个协议和绕过列表照常 ----
  systemProxy = { platform: "测试", http: systemProxyUrl, https: null, bypass: ["[::ffff:7f00:1]"], unsupported: [], invalid: { https: "系统 HTTPS 代理地址无法解析（bad host 端口 1）" } };
  await refreshSystemProxy();
  proxyAuthority = "";
  const httpStillProxied = await relayFetch(`http://provider.test:${address.port}/healthy`, {});
  assert.deepEqual(await httpStillProxied.json(), { ok: true });
  assert(lastCallViaProxy(), "HTTP 代理照常可用");
  proxyAuthority = "";
  const bypassStillDirect = await relayFetch(mappedUrl, {});
  assert.deepEqual(await bypassStillDirect.json(), { ok: true });
  assert(!lastCallViaProxy(), "系统绕过列表照常直连");
  await assert.rejects(relayFetch(`https://provider.test:${address.port}/healthy`, {}), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.deepEqual(error.diagnostic.codes, ["ASH_SYSTEM_PROXY_UNAVAILABLE"]);
    assert.match(error.message, /未转发（系统 HTTPS 代理地址无法解析/);
    return true;
  });
  console.log("  ✓ 某个协议的系统代理地址写坏只拒绝那个协议的请求，另一协议与绕过列表照常");

  // ---- 刷新配置、换连接池都不能打断在途请求的重定向链 ----
  systemProxy = { platform: "测试", http: systemProxyUrl, https: systemProxyUrl, bypass: [], unsupported: [] };
  await refreshSystemProxy();
  // 两条在途请求：一条重定向回本机供应商（下一跳走直连 agent），一条经系统代理、重定向回同一远端（下一跳走代理 agent）。
  // 两个池里的这两个 agent 在换池前就已存在 —— 换池时提前关掉，下一跳就是 UND_ERR_CLOSED
  const remoteOrigin = `http://provider.test:${address.port}`;
  const warmRemote = await relayFetch(`${remoteOrigin}/healthy`, {});
  assert.deepEqual(await warmRemote.json(), { ok: true });
  const inFlight = [relayFetch(`${origin}/held-redirect`, {}), relayFetch(`${remoteOrigin}/held-redirect`, {})];
  while (heldRedirects.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  systemProxy = { ...systemProxy, bypass: ["unrelated.test"] };
  await refreshSystemProxy();
  for (const target of [origin, remoteOrigin]) {
    const afterRefresh = await relayFetch(`${target}/healthy`, {});
    assert.deepEqual(await afterRefresh.json(), { ok: true });
    const otherTimeouts = await relayFetch(`${target}/healthy`, {}, { connectTimeoutMs: 9_999 });
    assert.deepEqual(await otherTimeouts.json(), { ok: true }, "连接参数不同的请求换了新池");
  }
  for (const [response, target] of heldRedirects.splice(0).map((entry, index) => [entry, index === 0 ? origin : remoteOrigin] as const)) {
    response.writeHead(302, { location: `${target}/healthy` });
    response.end();
  }
  const [localRedirected, remoteRedirected] = await Promise.all(inFlight);
  assert.equal(localRedirected.status, 200, "旧池被顶替后，在途请求的重定向下一跳（直连）仍能发出");
  assert.deepEqual(await localRedirected.json(), { ok: true });
  assert.equal(remoteRedirected.status, 200, "旧池被顶替后，在途请求的重定向下一跳（经代理）仍能发出");
  assert.deepEqual(await remoteRedirected.json(), { ok: true });
  assert(lastCallViaProxy(), "远端那条的重定向一跳照常经系统代理");
  const backToDefault = await relayFetch(`${origin}/healthy`, {});
  assert.deepEqual(await backToDefault.json(), { ok: true });
  console.log("  ✓ 系统配置刷新、连接池更替都等在途请求（含重定向链）结束，旧请求不被打断");

  // ---- 代理连不上：报清楚走的哪条路，不偷偷改直连 ----
  const deadSystemProxy = "http://relay-user:system-proxy-secret@127.0.0.1:1";
  systemProxy = { platform: "测试", http: deadSystemProxy, https: deadSystemProxy, bypass: [], unsupported: [] };
  await refreshSystemProxy();
  const callsBefore = calls.length;
  await assert.rejects(relayFetch(mappedUrl, { method: "POST", body: "inference-request" }), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.status, 502);
    assert.equal(error.diagnostic.proxy, "http://***@127.0.0.1:1");
    assert.equal(error.diagnostic.proxySource, "系统代理（测试）");
    assert.match(error.message, /经代理 http:\/\/\*\*\*@127\.0\.0\.1:1（系统代理（测试））/);
    return true;
  });
  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  await assert.rejects(relayFetch(mappedUrl, {}), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.proxySource, "环境变量 HTTP_PROXY");
    assert.match(error.message, /经代理 http:\/\/127\.0\.0\.1:1（环境变量 HTTP_PROXY）/);
    return true;
  });
  assert.equal(calls.length, callsBefore, "代理失败后不能绕过代理直连上游");
  delete process.env.HTTP_PROXY;
  await assert.rejects(relayFetch(`${origin}/redirect?to=${encodeURIComponent(mappedUrl)}`, {}), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.equal(error.diagnostic.proxy, "http://***@127.0.0.1:1", "诊断报的是重定向后实际走的代理，不是初始那跳的直连");
    assert.equal(error.diagnostic.bypass, undefined);
    assert.match(error.message, /经代理 http:\/\/\*\*\*@127\.0\.0\.1:1/);
    return true;
  });
  delete process.env.HTTP_PROXY;
  systemProxy = { platform: "测试", http: null, https: null, bypass: [], unsupported: ["PAC 自动配置（http://pac.test/proxy.pac）"] };
  await refreshSystemProxy();
  const pacDirect = await relayFetch(mappedUrl, {});
  assert.deepEqual(await pacDirect.json(), { ok: true });
  assert(warnings.some((line) => line.includes("PAC 自动配置（http://pac.test/proxy.pac）ash 不支持、未生效，当前直连")));
  assert.doesNotMatch(warnings.join("\n"), /system-proxy-secret/);
  console.log("  ✓ 代理连不上时报出代理地址与来源（凭据打码）且不降级直连，PAC 明说未生效");

  const secret = "relay-secret-must-not-leak";
  globalThis.fetch = (async () => {
    throw new TypeError(`fetch failed with ${secret}`, {
      cause: new AggregateError([
        Object.assign(new Error(secret), { code: "ETIMEDOUT" }),
        Object.assign(new Error(secret), { code: "EADDRNOTAVAIL" }),
      ], secret),
    });
  }) as typeof fetch;
  await assert.rejects(relayFetch(`https://user:${secret}@provider.test/v1/messages?key=${secret}`, {
    headers: { authorization: `Bearer ${secret}` },
  }), (error: unknown) => {
    assert(error instanceof RelayRequestError);
    assert.deepEqual(error.diagnostic.codes, ["ETIMEDOUT", "EADDRNOTAVAIL"]);
    assert.equal(error.diagnostic.upstream, "https://provider.test");
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /诊断号/);
    assert.equal(relayErrorResponse(error).status, 504);
    return true;
  });
  assert.doesNotMatch(warnings.join("\n"), new RegExp(secret));
  console.log("  ✓ 底层 cause/聚合错误码可诊断，密钥、凭据、查询参数不进入报错或日志");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.log = originalLog;
  setSystemProxyReaderForTests();
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const socket of [...sockets, ...tunnelSockets]) socket.destroy();
  await closeRelayDispatchers();
  upstream.close();
  if (proxy.listening) proxy.close();
}

console.log("llm relay tests passed");
