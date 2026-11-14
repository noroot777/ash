// mac app 窗口专用的那个端口（`ASH_WINDOW_PORT`，只在本机自用模式下生效）。
//
// 窗口原来直接连 :4317。app 那份服务停掉、端口被另一份 ash 接手的那一秒里，页面还在发的请求
// 会落到新来的那一份上：新版 ash 见到别人的实例号会拒收（instance-binding.ts），可旧版 ash 不认
// 这一层，请求到了它手上就照样执行 —— 在「窗口直接连 4317」的结构里这个口子堵不住。所以窗口
// 改连只属于这份服务的端口：app 按数据根算出一个固定端口交给服务，服务在 4317 之外再监听它，
// health 报出来，窗口只认它。别的 ash 默认只会去占 4317，这份服务一停，窗口专用端口就空着，
// 撤页之前的请求连不上任何人。4317 照旧给浏览器、CLI 和 MCP 用。
// 这个端口不归这份服务独占：有人特意用 PORT 把旧版 ash 起在它上面、又赶在撤页前那一下，请求仍会被
// 执行。这是用户知情接受的剩余风险（desktop/macos/README.md），彻底堵住要换掉窗口的请求形式。
//
// 端口被别的程序占着就不监听，health 答 null：app 据此不载页面、说明是哪个端口被占，绝不退回 4317。
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { LOCAL_ONLY, LOCAL_ONLY_HOSTNAME } from "./local-only.js";

const raw = Number(process.env.ASH_WINDOW_PORT);
const requested = LOCAL_ONLY && Number.isInteger(raw) && raw > 0 && raw <= 65_535 ? raw : null;
// 读完就拿掉：agent 与应用内终端会继承服务的环境，再起一份服务不该抢这个端口。
delete process.env.ASH_WINDOW_PORT;

let listening: number | null = null;

/** 窗口专用端口确实监听上了才有值。 */
export function windowPort(): number | null {
  return listening;
}

/** 在 4317 之前先把窗口端口监听好：health 一答就带着它，app 不会在中间那一下把自己那份认成别人。 */
export function listenWindowPort(fetch: Parameters<typeof serve>[0]["fetch"], attach: (server: Server) => void): Promise<void> {
  if (!requested) return Promise.resolve();
  return new Promise((resolve) => {
    const server = serve({ fetch, port: requested, hostname: LOCAL_ONLY_HOSTNAME }, (info) => {
      listening = info.port;
      console.log(`[ash] mac app 窗口专用端口 http://${LOCAL_ONLY_HOSTNAME}:${info.port}`);
      resolve();
    }) as Server;
    server.once("error", (error) => {
      console.error(`[ash] mac app 窗口专用端口 ${requested} 没监听上（${String(error)}），app 不会载页面`);
      resolve();
    });
    attach(server);
  });
}
