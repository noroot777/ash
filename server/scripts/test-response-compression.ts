import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { responseCompression } from "../src/response-compression.js";

// 整份读的大接口要压，边写边读的流、带 Range 语义的响应、LLM 中继不压（见 response-compression.ts）。
const big = JSON.stringify(Array.from({ length: 2000 }, (_, index) => ({ index, text: "会话正文".repeat(8) })));
const app = new Hono();
app.use("*", responseCompression());
app.get("/api/sessions/s/trace", (c) => c.body(big, 200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) }));
app.get("/api/sessions/s/output", (c) => c.text(big));
app.get("/api/small", (c) => c.body("{}", 200, { "content-type": "application/json", "content-length": "2" }));
app.get("/api/events", (c) => streamSSE(c, async (stream) => { await stream.writeSSE({ data: big }); }));
app.get("/api/file/raw", (c) => c.body(big, 206, { "content-type": "text/plain", "content-range": `bytes 0-9/${big.length}` }));
app.get("/api/file/full", (c) => c.body(big, 200, { "content-type": "text/plain", "accept-ranges": "bytes" }));
app.post("/api/llm-providers/p/convert/v1/chat/completions", (c) => c.body(big, 200, { "content-type": "application/json" }));
app.get("/assets/index.js", (c) => c.body(big, 200, { "content-type": "text/javascript; charset=utf-8" }));

const get = (path: string, encoding: string | null = "gzip, deflate, br", method = "GET") =>
  app.request(path, { method, headers: encoding ? { "accept-encoding": encoding } : {} });

for (const path of ["/api/sessions/s/trace", "/api/sessions/s/output", "/assets/index.js"]) {
  const response = await get(path);
  assert.equal(response.headers.get("content-encoding"), "gzip", path);
  assert.equal(response.headers.get("content-length"), null, path);
  assert.match(response.headers.get("vary") ?? "", /Accept-Encoding/, path);
  const body = Buffer.from(await response.arrayBuffer());
  assert.ok(body.length < Buffer.byteLength(big) / 4, `${path} 压缩后 ${body.length} 字节`);
  assert.equal(gunzipSync(body).toString("utf8"), big, path);
}
console.log("✓ 整份读的 JSON / 纯文本 / 页面脚本按 gzip 下发，解压后与原文一致");

for (const encoding of [null, "identity", "gzip;q=0"]) {
  const response = await get("/assets/index.js", encoding);
  assert.equal(response.headers.get("content-encoding"), null, String(encoding));
  // 原样那份也得声明随 Accept-Encoding 变，否则缓存会拿它应付之后会解 gzip 的请求。
  assert.match(response.headers.get("vary") ?? "", /Accept-Encoding/, String(encoding));
  assert.equal(await response.text(), big, String(encoding));
}
console.log("✓ 客户端没说接受 gzip 时原样下发，且同样声明 Vary: Accept-Encoding");

for (const [path, method] of [
  ["/api/small", "GET"],
  ["/api/events", "GET"],
  ["/api/file/raw", "GET"],
  ["/api/file/full", "GET"],
  ["/api/llm-providers/p/convert/v1/chat/completions", "POST"],
] as const) {
  const response = await get(path, "gzip", method);
  assert.equal(response.headers.get("content-encoding"), null, path);
  await response.arrayBuffer();
}
console.log("✓ 声明了长度的小响应、SSE、Range 响应、LLM 中继不压");
