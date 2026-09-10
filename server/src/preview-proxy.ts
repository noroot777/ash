import { request as httpRequest, Agent, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { alive, readAnyPreview } from "./preview-store.js";
import { previewBase } from "./preview-public.js";
import { rewritePreviewText, rewritePreviewUrl } from "./preview-proxy-rewrite.js";
import { grantFor, canUsePreview, claimGrant, forkGrant } from "./preview-access.js";
import { attributeName, cookieAttribute, cookieHeaderFor, defaultPath, rememberCookie, type PreviewCookieJar } from "./preview-cookies.js";

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

function forwardedHeaders(input: Headers | IncomingHttpHeaders, jar: PreviewCookieJar, upstreamPath: string): Record<string, string> {
  const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""]);
  const result: Record<string, string> = {};
  const connection = entries.find(([k]) => k.toLowerCase() === "connection")?.[1].toLowerCase().split(",").map((s) => s.trim()) ?? [];
  for (const [key, value] of entries) {
    const k = key.toLowerCase();
    if (HOP_HEADERS.has(k) || connection.includes(k) || ["host", "cookie", "authorization", "origin", "referer", "accept-encoding", "content-length"].includes(k) || k.startsWith("x-ash-") || k.startsWith("x-forwarded-") || k === "forwarded") continue;
    result[k] = value;
  }
  // 往上游发什么 cookie，**只认罐子**，浏览器带回来的一概不作数。两条理由：
  // ① 在沙箱 opaque origin 下它本来就是空的（见 preview-cookies.ts 开头）；
  // ② 发回浏览器的那份被重挂在预览前缀上，Path 信息已经不在了 —— 拿它当来源，
  //    `Path=/private` 的凭证又会从 `/public` 溜出去，正是罐子要防的事。
  // 发回浏览器仍然照发（见 scopedCookie），那是给页面里的 `document.cookie` 看的。
  const cookie = cookieHeaderFor(jar, upstreamPath);
  if (cookie) result.cookie = cookie;
  result["accept-encoding"] = "identity";
  return result;
}

const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * 发回浏览器的那一份。它**不是**会话赖以存活的那份（那是罐子），只是让页面里的
 * `document.cookie` 还能读到自己设的东西；浏览器收不下也不影响预览可用。
 *
 * Path 按原样映射到预览前缀底下（`/private` → `<base>private`），而不是一律挂成
 * `<base>`：挂成 `<base>` 就等于把应用自己的 Path 作用域抹平了。
 */
function scopedCookie(value: string, base: string, token: string, upstreamPath: string): string | null {
  const [pair, ...attributes] = value.split(";");
  const equals = pair.indexOf("=");
  if (equals <= 0) return null;
  const name = pair.slice(0, equals).trim();
  if (!COOKIE_NAME_RE.test(name)) return null;
  const declared = cookieAttribute(attributes, "path");
  const path = declared?.startsWith("/") ? declared : defaultPath(upstreamPath);
  const kept = attributes.filter((s) => !["domain", "path", "samesite"].includes(attributeName(s)));
  return `ashpv_${token}_${Buffer.from(name).toString("hex")}${pair.slice(equals)}; Path=${base}${path.slice(1)}; SameSite=Lax;${kept.join(";")}`;
}

/** 预览前缀里「一张凭证」那一层：`/preview/<task>/<token>/`。 */
const previewGroup = (base: string) => base.split("/").slice(0, 4).join("/") + "/";

/** 认领暗号种在浏览器里的名字。`ashpv_client_` 撞不上改写应用 cookie 的 `ashpv_<48 位十六进制>_`。 */
const clientCookieName = (token: string) => `ashpv_client_${token}`;

/**
 * 这个请求是不是「浏览器在开一个页面」。只有这种请求才会把我们种的 Lax cookie 带回来：
 * 沙箱文档发出的子资源（脚本、样式、图片、XHR、iframe…）一律按跨站处理，一个 cookie 都不
 * 带（2026-09-10 在明文 http + 局域网 IP 上逐类实测过）。所以认领和分叉只在这种请求上判，
 * 子资源一概照旧用本凭证的罐子 —— 反过来做的话，页面自己的 XHR 会先被判成「另一个客户端」。
 *
 * `Sec-Fetch-*` 只发给可信来源（明文 + 局域网 IP 收不到），于是只能「有就用，没有就退回
 * Accept + 没有 Origin」。代价是明文下同源 iframe 跟顶层导航长得一模一样，会被当成另一个
 * 客户端分走一张自己的凭证（它本来也带不回 cookie，会话本来就保不住）；换来的是复制链接
 * 的人拿不到你的应用会话。
 */
function looksLikeNavigation(method: string, header: (name: string) => string | undefined): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const dest = header("sec-fetch-dest");
  if (dest) return dest === "document";
  return !header("origin") && (header("accept") ?? "").includes("text/html");
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
  const group = previewGroup(base);
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
    // 地址里的 token 是 bearer 凭证（谁拿到谁能看这个预览，有意为之），但罐子里的**应用
    // 会话**不能跟着地址走：复制一份链接出去，对方不该连登录都不用就坐进你的会话。所以第
    // 一个开页面的客户端认领这张凭证，之后拿同一个地址开页面的客户端分叉走一张自己的。
    const token = target.record.proxyToken!;
    let claim: string | null = null;
    if (looksLikeNavigation(c.req.method, (name) => c.req.header(name))) {
      if (target.grant.client === null) {
        const life = Math.max(1, Math.round((target.grant.expires - Date.now()) / 1000));
        claim = `${clientCookieName(token)}=${claimGrant(target.grant)}; Path=${previewGroup(target.base)}; Max-Age=${life}; HttpOnly; SameSite=Lax`;
      } else if (getCookie(c, clientCookieName(token)) !== target.grant.client) {
        const forked = forkGrant(token);
        if (!forked) return c.text("预览不存在、已过期或无权访问，请从任务重新打开。", 404);
        c.header("cache-control", "no-store");
        return c.redirect(requested.pathname.replace(`/${token}/`, `/${forked}/`) + requested.search, 302);
      }
    }
    try {
      const hostname = await loopback(target.port);
      if (!targetOf(requested.pathname)) return c.text("预览已关闭", 404);
      const headers = forwardedHeaders(c.req.raw.headers, target.grant.jar, target.path);
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
        // 先记进罐子（这是会话能不能活下来的那一份），再改写一份发给浏览器（能收下就收）。
        rememberCookie(target.grant.jar, cookie, target.path);
        const rewritten = scopedCookie(cookie, target.base, token, target.path);
        if (rewritten) result.append("set-cookie", rewritten);
      }
      const location = result.get("location");
      if (location) result.set("location", rewritePreviewUrl(location, target.base, target.record));
      const type = result.get("content-type") ?? "";
      for (const [k, v] of Object.entries(safety)) result.set(k, v);
      if (claim) result.append("set-cookie", claim);
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
      // 这一趟没把暗号送出去，就别把凭证钉在一个收不到暗号的客户端上 —— 否则它下次导航
      // 会被当成「另一个客户端」分叉走。
      if (claim) target.grant.client = null;
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
      const headers = forwardedHeaders(incoming.headers, target.grant.jar, target.path);
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
