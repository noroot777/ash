// 「这个请求是发给哪一份 ash 的」（mac app 第 2 轮审查 F2）。
//
// mac app 的窗口开着页面时，端口上的服务可能换了人（app 那份停了，仓库里的开发实例接着占了
// :4317）。窗口定时认人、导航前认人都只能**事后**撤页：已经载好的页面自己发的 fetch、SSE 重连
// 不经过任何导航，撤页之前那一两秒里发出的写请求照样落进新来的那一份库（审查实测：换人后 2ms
// 写请求就到了）。客户端那一侧没有办法在发请求之前确认 TCP 那头是谁，所以这道判据只能由**真正
// 处理请求的那个进程**来做：
//
//   · 每个服务进程起来时生成一个随机的实例号，`/api/health` 对本机直连报出来（routes.ts）；
//   · 窗口认过人（数据根、代码根、本机自用模式都对上）之后，把那个实例号作为 cookie 交给页面；
//     原生那几个请求（首启补接 MCP）放在请求头里；
//   · 这里核对：请求带着实例号、却不是本进程的，一律 409，什么都不执行。不带的照常放行 ——
//     浏览器、CLI、agent 的 MCP 本来就不认识这一层。
//
// `/api/health` 不拦：窗口正是靠它重新认人、拿到新的实例号的。预览代理的 WebSocket 升级不经过
// Hono，在 preview-proxy.ts 里用同一个判据。
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export const INSTANCE_ID = randomUUID();
export const INSTANCE_COOKIE = "ash_instance";
export const INSTANCE_HEADER = "x-ash-instance";

/** 请求自称发给哪一份（cookie 与请求头里的全部取值）。 */
function claimed(cookie: string | undefined, header: string | undefined): string[] {
  const values = header?.trim() ? [header.trim()] : [];
  for (const part of cookie?.split(";") ?? []) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === INSTANCE_COOKIE) values.push(part.slice(at + 1).trim());
  }
  return values;
}

/** 请求明说了自己要的是另一份 ash。 */
export function addressedElsewhere(cookie: string | undefined, header: string | undefined): boolean {
  const values = claimed(cookie, header);
  return values.length > 0 && !values.every((value) => value === INSTANCE_ID);
}

export const INSTANCE_MISMATCH = "这个页面认的是另一份 ash（端口上的服务已经换了），请求没有执行。";

export function instanceBinding(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === "/api/health" || !addressedElsewhere(c.req.header("cookie"), c.req.header(INSTANCE_HEADER))) return next();
    return c.json({ error: INSTANCE_MISMATCH, instanceMismatch: true }, 409);
  };
}
