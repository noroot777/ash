// 「预览起没起来」怎么探。
//
// 跟 preview-log.ts 分家的理由一样：preview.ts 一进来就拖着 db 和进程管理，探测这点事
// 只碰 node:net 和 fetch，单独放才测得动（回归 test:preview-probe）。
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import type { PreviewReady } from "@harness/shared/workflow";

/** 日志里出现这些词才算「它自己说自己好了」。 */
const READY_WORDS = /ready|listening|started|compiled|running at|server running/i;

/**
 * 本机回环的两个地址族都得试。
 *
 * 不是洁癖：**vite 默认只监听 `::1`**（日志里印的却是 `http://localhost:…`，看不出来），
 * 只连 `127.0.0.1` 会 ECONNREFUSED —— 于是一个明明已经跑起来的预览被判成「没起来」，
 * 一路干等到超时，用户收到一句「等了 120 秒还没起来」。反过来只连 `::1` 同样不行，
 * 绑 `0.0.0.0` 的服务一大把。两个都试，哪个通都算通。
 */
const LOOPBACKS = ["127.0.0.1", "::1"];

function connectTo(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function canConnect(port: number): Promise<boolean> {
  for (const host of LOOPBACKS) {
    if (await connectTo(host, port)) return true;
  }
  return false;
}

/**
 * HTTP 那一档不走 `fetch`，两条理由都很实在：
 * ① `fetch`（undici）认环境里的 `HTTP_PROXY` / `NODE_USE_ENV_PROXY` —— 打给本机的请求
 *    被发去代理，回来一个 502，于是「预览起没起来」变成了「用户开没开梯子」；
 * ② 它只按 DNS 给的那一个地址连，`::1`-only 的 vite 照样连不上（见 LOOPBACKS）。
 * 自己发请求两条一起躲开：直连回环地址，`Host` 头照原样带上（vite 一类的服务会按
 * `Host` 做来源检查，写成 `::1:5173` 会被它 403 掉）。
 */
async function http200(url: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const path = `${target.pathname}${target.search}` || "/";
  for (const host of LOOPBACKS) {
    if (await status200(target.protocol, host, port, path, target.host)) return true;
  }
  return false;
}

// 必须是**自己的** agent。Node 24 起 `NODE_USE_ENV_PROXY=1` 会把 `node:http` 的默认
// globalAgent 也接到系统代理上（不只是 fetch）——打给 127.0.0.1 的请求就此石沉大海，
// 挂到超时才回来，探测于是稳定地报「预览没起来」。给一个自己的 agent 就绕开了。
const HTTP_AGENT = new HttpAgent();
const HTTPS_AGENT = new HttpsAgent({ rejectUnauthorized: false });

function status200(
  protocol: string, host: string, port: number, path: string, hostHeader: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const options = { host, port, path, headers: { host: hostHeader }, timeout: 3000 };
    const onResponse = (res: IncomingMessage) => {
      res.resume();
      resolve(res.statusCode === 200);
    };
    const req = protocol === "https:"
      // 预览是本机自己起的服务，dev 用自签证书是常态，卡在证书上没有意义。
      ? httpsRequest({ ...options, agent: HTTPS_AGENT, rejectUnauthorized: false }, onResponse)
      : httpRequest({ ...options, agent: HTTP_AGENT }, onResponse);
    req.once("error", () => resolve(false));
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function ready(mode: PreviewReady, url: string, port: number, log: string): Promise<boolean> {
  if (mode === "http200") return http200(url);
  if (!(await canConnect(port))) return false;
  return mode === "port" || READY_WORDS.test(log);
}
