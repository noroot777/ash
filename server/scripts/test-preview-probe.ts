// 预览的就绪探测（server/src/preview-probe.ts）。
//
// 这条测试钉的是一个**看不见**的坑：dev server 在日志里印的一律是
// `http://localhost:xxxx`，但 localhost 是哪个地址族由它自己定 —— **vite 默认只监听
// `::1`**。探测只连 `127.0.0.1` 的话，一个已经跑起来的预览会被判成「没起来」，然后
// 一路干等到 120 秒超时，用户收到「等了 120 秒还没起来」，去浏览器一点却是好的。
// 这种错法比报错难查得多，所以两个地址族都得试。
//
// 跑法：npm -w server run test:preview-probe
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { canConnect, ready } from "../src/preview-probe.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

/** 在指定地址族上起一个只接受连接的空 server，返回它拿到的端口。 */
function listenOn(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve({ server, port: address.port });
      else reject(new Error("拿不到端口"));
    });
  });
}

const close = (server: Server) => new Promise<void>((done) => server.close(() => done()));

// 只监听 IPv6 回环 —— 就是 vite 的默认行为
const v6 = await listenOn("::1");
check("只监听 ::1 也认得出来", await canConnect(v6.port), true);
check("——并且 port 档就算起来了", await ready("port", `http://localhost:${v6.port}/`, v6.port, ""), true);
await close(v6.server);

// 只监听 IPv4 回环 —— 一大票 node 服务的默认
const v4 = await listenOn("127.0.0.1");
check("只监听 127.0.0.1 照旧认得出来", await canConnect(v4.port), true);
check("port+log 档还要日志说 ready", await ready("port+log", `http://localhost:${v4.port}/`, v4.port, "compiling"), false);
check("——日志说了就算数", await ready("port+log", `http://localhost:${v4.port}/`, v4.port, "ready in 81 ms"), true);
const free = v4.port;
await close(v4.server);

// 没人监听：必须干脆地否掉，不能靠超时兜着
check("没人监听就是连不上", await canConnect(free), false);
check("——那一档也一样", await ready("port", `http://localhost:${free}/`, free, "ready"), false);
check("http200 档连不上也不算起来", await ready("http200", `http://localhost:${free}/`, free, "ready"), false);

// http200 那一档走的是 fetch 而不是 socket，所以 ::1 这条坑得单独再确认一遍：
// 它拿到的 url 是日志里那句 http://localhost:xxxx，真服务却只在 IPv6 上。
const web = createHttpServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});
const webPort = await new Promise<number>((resolve, reject) => {
  web.once("error", reject);
  web.listen(0, "::1", () => {
    const address = web.address();
    if (typeof address === "object" && address) resolve(address.port);
    else reject(new Error("拿不到端口"));
  });
});
check("http200 档也认 ::1 上的服务", await ready("http200", `http://localhost:${webPort}/`, webPort, ""), true);
await new Promise<void>((done) => web.close(() => done()));

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);
