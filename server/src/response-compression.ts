import type { MiddlewareHandler } from "hono";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX, compress } from "hono/compress";

// 响应体按 gzip 下发。会话正文和执行过程是整份读的：一个跑了几天的任务，trace 五 MB、
// 正文一 MB 很常见，JSON 与纯文本压下来只剩六分之一左右。没压缩时手机（飞书内嵌页、
// Tailscale 外网）打开任务详情要先把这几 MB 原样拖完才出正文，本机回环上感觉不到。
//
// 哪些不压：
// - SSE / ndjson 这类边写边读的流：hono 的内容类型表本来就排除了 text/event-stream，
//   ndjson 不在表里。压缩流要攒够一块才吐，压了实时性就没了。
// - 带 Range 语义的响应：Content-Range 指的是原始字节区间，压过之后对不上；声明了
//   Accept-Ranges 的整份也不压，免得同一个资源的整份和分段是两种表示。
// - LLM 中继（context-1m / convert）：流式补全不一定标成 SSE，攒块会让 agent 那头的
//   逐字输出卡成一段一段，这条热路径原样透传。
const RELAY_PATH = /^\/api\/llm-providers\/[^/]+\/(?:context-1m|convert)\/v1(?:\/|$)/;

const gzip = compress({ encoding: "gzip" });
const settled = async () => {};

export function responseCompression(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (RELAY_PATH.test(c.req.path)) return;
    const { headers, status } = c.res;
    if (status === 206 || headers.has("Content-Range") || headers.has("Accept-Ranges")) return;
    // 这份表示是不是按 Accept-Encoding 协商出来的：是就**两种结果都**声明 Vary。只给压过的
    // 那份标，缓存先存下一份原样的（请求没带 gzip）就会拿它应付之后所有人，assets 还是一年
    // immutable，压缩等于白做。
    const negotiable = !headers.has("Content-Encoding") && COMPRESSIBLE_CONTENT_TYPE_REGEX.test(headers.get("Content-Type") ?? "");
    // 响应已经在手上了，交给 hono 的 compress 只做「判类型、协商、套压缩流」那一半。
    await gzip(c, settled);
    if (negotiable) c.res.headers.append("Vary", "Accept-Encoding");
  };
}
