import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { closeRelayDispatchers, relayErrorResponse, relayFetch, RelayRequestError } from "../src/llm-relay.js";

const warnings: string[] = [];
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;
console.warn = (message: unknown) => { warnings.push(String(message)); };
const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "ASH_LLM_RELAY_HEADERS_TIMEOUT_MS", "ASH_LLM_RELAY_BODY_TIMEOUT_MS"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const sockets = new Set<Socket>();
const calls: { path: string; method: string; socket: Socket }[] = [];
let slowStarted: (() => void) | undefined;
let abortClosed: (() => void) | undefined;
const upstream = createServer(async (request, response) => {
  calls.push({ path: request.url ?? "", method: request.method ?? "", socket: request.socket });
  for await (const _chunk of request) { }
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
const tunnelSockets = new Set<Duplex>();
proxy.on("connect", (request, client, head) => {
  proxyAuthority = request.url ?? "";
  const target = connect(address.port, "127.0.0.1", () => {
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
