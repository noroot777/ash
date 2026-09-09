import { request as httpRequest, Agent, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { Hono } from "hono";
import { alive, readAnyPreview } from "./preview-store.js";
import { previewBase } from "./preview-public.js";
import { rewritePreviewText, rewritePreviewUrl } from "./preview-proxy-rewrite.js";
import { grantFor, canUsePreview } from "./preview-access.js";

const httpAgent = new Agent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: false });
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const LIMIT = 10 * 1024 * 1024;
const HOSTS = ["127.0.0.1", "::1"];

function targetOf(requestPath: string) {
  const match = /^\/preview\/([A-Za-z0-9_-]{1,80})\/([a-f0-9]{48})\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(requestPath);
  if (!match) return null;
  const grant = grantFor(match[2]);
  const stored = readAnyPreview(match[1]);
  if (!grant || grant.taskId !== match[1] || !stored?.proxyToken || stored.gen !== grant.gen) return null;
  const record = { ...stored, proxyToken: match[2] };
  const service = record.services?.find((s) => s.id === match[3]);
  if (!service?.url || !service.port || service.status !== "ready" || !alive(service.pid)) return null;
  let target: URL;
  try { target = new URL(service.url); } catch { return null; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  const startupBase = previewBase(stored, service.id);
  const suffix = match[4] ?? "/";
  const path = target.pathname.startsWith(startupBase) ? startupBase + suffix.slice(1) : suffix;
  return { record, grant, service, protocol: target.protocol, port: service.port, path, base: previewBase(record, service.id) };
}

/**
 * 浏览器**自己**会给请求盖上的那几种 `Authorization`：401 质询之后的 Basic/Digest，
 * 企业环境里的 Negotiate/NTLM，以及 `http://user:pass@host/` 这种 URL 带出来的。它们是
 * **用户对 ash 这个入口**的凭证，转给被预览的应用等于把用户的密码交给它。
 *
 * 除此之外的（`Bearer …` 之类）浏览器一律不会自动附加，只可能是页面自己 `fetch`/`XHR`
 * 设上去的——那是**应用自己的** token，必须原样转发。以前这里是「`authorization` 一律
 * 丢掉」，代价是被预览的应用**登得进去、登进去之后处处 401**（第 1 轮审查 P1：一个把
 * access token 存在 localStorage、由 Axios 加 `Bearer` 的 Java 后台，正是这个形状）。
 */
const BROWSER_ATTACHED_AUTH = /^(?:basic|digest|negotiate|ntlm)\b/i;

/**
 * 转发给被代理应用的请求头。除了摘掉逐跳头和 ash 自己的凭证，还有一件**必须**做的：
 * `Sec-Fetch-Site` 得跟着下面重写的 `Origin`/`Host` 一起改，不能原样转发。
 *
 * 预览页是 CSP `sandbox`（无 `allow-same-origin`）出来的 **opaque origin**，浏览器给它
 * 发出的每一个请求盖的章都是 `cross-site`。被代理的应用只要照通行做法拿这个头做 CSRF
 * 判据，预览里的**任何写操作**都会被它自己拒掉 —— 2026-09-09 真出过：预览的是 ash 前端
 * 那一档（`/api` 打回本机 ash），用户在预览里粘 key 登录，换来一句「跨站请求已被拒绝
 * （写操作只接受本站发起）」，而他明明就在自己这台 ash 上。Origin 早就重写成了应用自己
 * 的地址，却因为 `Sec-Fetch-Site` 的优先级更高（见 auth/middleware.ts 的
 * `crossSiteRejection`）而完全不起作用。
 *
 * 「是不是本人发的」这道判据在**外层**，不在这里：路径里 48 位随机 token + grant 校验
 * （`canUsePreview`）+ 外来 `Origin` 一律 403。能走到这一行的请求已经认定是本人从预览里
 * 发的，所以对内一律 `same-origin`；`none`（地址栏直接打开的顶层导航）保持原样 —— 它比
 * `same-origin` 宽松不了，改写反而会抹掉「这是用户自己敲进去的」这个事实。
 */
function forwardedHeaders(input: Headers | IncomingHttpHeaders, token: string): Record<string, string> {
  const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""]);
  const result: Record<string, string> = {};
  const connection = entries.find(([k]) => k.toLowerCase() === "connection")?.[1].toLowerCase().split(",").map((s) => s.trim()) ?? [];
  for (const [key, value] of entries) {
    const k = key.toLowerCase();
    if (HOP_HEADERS.has(k) || connection.includes(k) || ["host", "cookie", "authorization", "origin", "referer", "accept-encoding", "content-length", "sec-fetch-site"].includes(k) || k.startsWith("x-ash-") || k.startsWith("x-forwarded-") || k === "forwarded") continue;
    result[k] = value;
  }
  const auth = entries.find(([k]) => k.toLowerCase() === "authorization")?.[1].trim();
  if (auth && !BROWSER_ATTACHED_AUTH.test(auth)) result.authorization = auth;
  const site = entries.find(([k]) => k.toLowerCase() === "sec-fetch-site")?.[1].trim().toLowerCase();
  if (site) result["sec-fetch-site"] = site === "none" ? "none" : "same-origin";
  const cookies = entries.find(([k]) => k.toLowerCase() === "cookie")?.[1] ?? "";
  const prefix = `ashpv_${token}_`;
  const allowed = cookies.split(";").map((s) => s.trim()).filter((s) => s.startsWith(prefix)).map((s) => {
    const equals = s.indexOf("=");
    if (equals < 0) return "";
    try { return `${Buffer.from(s.slice(prefix.length, equals), "hex").toString("utf8")}=${s.slice(equals + 1)}`; } catch { return ""; }
  }).filter(Boolean);
  if (allowed.length) result.cookie = allowed.join("; ");
  result["accept-encoding"] = "identity";
  return result;
}

function scopedCookie(value: string, base: string, token: string): string | null {
  const [pair, ...attributes] = value.split(";");
  const equals = pair.indexOf("=");
  if (equals <= 0) return null;
  const name = pair.slice(0, equals).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
  const kept = attributes.filter((s) => !/^\s*(domain|path|samesite)\s*=/i.test(s));
  return `ashpv_${token}_${Buffer.from(name).toString("hex")}${pair.slice(equals)}; Path=${base}; SameSite=Lax;${kept.join(";")}`;
}

async function loopback(port: number): Promise<string> {
  for (const host of HOSTS) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.setTimeout(1000, () => done(false));
      socket.once("connect", () => done(true)); socket.once("error", () => done(false));
    });
    if (ok) return host;
  }
  throw new Error("预览服务无法连接");
}

function securityHeaders(origin: string, base: string): Record<string, string> {
  const group = base.split("/").slice(0, 4).join("/") + "/";
  return {
    "content-security-policy": `sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups; connect-src ${origin}${group} ${origin.replace(/^http/, "ws")}${group}; form-action ${origin}${group}; frame-src ${origin}${group}; worker-src 'none'`,
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cache-control": "no-store",
    "access-control-allow-origin": "null", "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS", "vary": "Origin",
  };
}

export function mountPreviewProxy(app: Hono): void {
  // 地址里的随机凭证只授予这一代预览；HTML 的 opaque origin 与受限 connect-src 隔离 ash 会话。
  app.all("/preview/*", async (c) => {
    const requested = new URL(c.req.url);
    const target = targetOf(requested.pathname);
    if (!target || !(await canUsePreview(target.grant))) return c.text("预览不存在、已过期或无权访问，请从任务重新打开。", 404);
    const origin = c.req.header("origin");
    if (origin && origin !== "null" && origin !== requested.origin) return c.text("预览不接受其它站点的请求", 403);
    if (!requested.pathname.endsWith("/") && requested.pathname === target.base.slice(0, -1)) return c.redirect(target.base + requested.search, 307);
    const externalOrigin = c.req.header("x-forwarded-proto") === "https" ? `https://${requested.host}` : requested.origin;
    const safety = securityHeaders(externalOrigin, target.base);
    if (c.req.method === "OPTIONS") {
      const headers = c.req.header("access-control-request-headers");
      if (headers) safety["access-control-allow-headers"] = headers;
      return new Response(null, { status: 204, headers: safety });
    }
    try {
      const hostname = await loopback(target.port);
      if (!targetOf(requested.pathname)) return c.text("预览已关闭", 404);
      const headers = forwardedHeaders(c.req.raw.headers, target.record.proxyToken!);
      headers.host = `localhost:${target.port}`;
      headers.origin = `${target.protocol}//localhost:${target.port}`;
      headers["x-forwarded-prefix"] = target.base.slice(0, -1);
      const secure = target.protocol === "https:";
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = (secure ? httpsRequest : httpRequest)({
          hostname, port: target.port, path: target.path + requested.search, method: c.req.method,
          headers, agent: secure ? httpsAgent : httpAgent,
        }, (res) => { req.setTimeout(0); resolve(res); });
        req.once("error", reject);
        req.setTimeout(30_000, () => req.destroy(new Error("预览服务响应超时")));
        const abort = () => req.destroy();
        c.req.raw.signal.addEventListener("abort", abort, { once: true });
        req.once("close", () => c.req.raw.signal.removeEventListener("abort", abort));
        if (c.req.raw.body) Readable.fromWeb(c.req.raw.body as never).on("error", (e) => req.destroy(e)).pipe(req);
        else req.end();
      });
      const result = new Headers();
      for (const [k, value] of Object.entries(response.headers)) {
        if (!value || HOP_HEADERS.has(k) || ["set-cookie", "content-security-policy", "content-security-policy-report-only", "content-length", "x-frame-options", "clear-site-data", "service-worker-allowed", "access-control-allow-origin", "access-control-allow-credentials"].includes(k)) continue;
        result.set(k, Array.isArray(value) ? value.join(", ") : value);
      }
      for (const cookie of response.headers["set-cookie"] ?? []) {
        const rewritten = scopedCookie(cookie, target.base, target.record.proxyToken!);
        if (rewritten) result.append("set-cookie", rewritten);
      }
      const location = result.get("location");
      if (location) result.set("location", rewritePreviewUrl(location, target.base, target.record));
      const type = result.get("content-type") ?? "";
      for (const [k, v] of Object.entries(safety)) result.set(k, v);
      const status = response.statusCode ?? 502;
      if (c.req.method === "HEAD" || [204, 205, 304].includes(status)) { response.resume(); return new Response(null, { status, headers: result }); }
      if (/text\/html|(?:javascript|ecmascript)|text\/css/.test(type)) {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > LIMIT) { response.destroy(); throw new Error("预览文本资源超过 10 MB"); }
          chunks.push(Buffer.from(chunk));
        }
        let data = Buffer.concat(chunks);
        const encoding = result.get("content-encoding");
        if (encoding === "gzip") data = gunzipSync(data, { maxOutputLength: LIMIT });
        else if (encoding === "br") data = brotliDecompressSync(data, { maxOutputLength: LIMIT });
        else if (encoding === "deflate") data = inflateSync(data, { maxOutputLength: LIMIT });
        else if (encoding && encoding !== "identity") throw new Error("预览资源使用了不支持的压缩格式");
        result.delete("content-encoding"); result.delete("etag");
        return new Response(rewritePreviewText(data.toString("utf8"), type, target.base, target.record, target.path), { status, headers: result });
      }
      return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: result });
    } catch {
      return c.text("预览服务无法连接或响应异常，请查看任务的预览日志。", 502);
    }
  });
}

export function attachPreviewUpgrades(server: Server): void {
  server.on("upgrade", async (incoming, socket, head) => {
    if (!incoming.url?.startsWith("/preview/")) {
      if (server.listenerCount("upgrade") === 1) socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const requested = new URL(incoming.url, `http://${incoming.headers.host ?? "localhost"}`);
      const target = targetOf(requested.pathname);
      const origin = incoming.headers.origin;
      let originMatches = !origin || origin === "null";
      try { if (origin && origin !== "null") originMatches = new URL(origin).host === incoming.headers.host; } catch { originMatches = false; }
      if (!target || !originMatches || !(await canUsePreview(target.grant))) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      const hostname = await loopback(target.port);
      if (!targetOf(requested.pathname)) { socket.destroy(); return; }
      const headers = forwardedHeaders(incoming.headers, target.record.proxyToken!);
      headers.host = `localhost:${target.port}`;
      headers.origin = `${target.protocol}//localhost:${target.port}`;
      headers.connection = "Upgrade"; headers.upgrade = "websocket";
      const secure = target.protocol === "https:";
      const upstream = (secure ? httpsRequest : httpRequest)({ hostname, port: target.port, path: target.path + requested.search, method: "GET", headers, agent: secure ? httpsAgent : httpAgent });
      upstream.once("upgrade", (response, remote, remoteHead) => {
        remote.setTimeout(0);
        const responseHeaders = Object.entries(response.headers).filter(([k]) => ["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"].includes(k));
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
        socket.on("error", () => remote.destroy()); remote.on("error", () => socket.destroy());
        socket.on("close", () => remote.destroy()); remote.on("close", () => socket.destroy());
      });
      upstream.on("error", () => socket.destroy());
      upstream.on("response", (res) => { res.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
      upstream.setTimeout(10_000, () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.end();
    } catch { socket.destroy(); }
  });
}
