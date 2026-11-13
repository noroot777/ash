// 请求点名要另一份 ash 时，真正处理它的服务一律不执行（server/src/instance-binding.ts，mac app 第 2 轮审查 F2）。
//
// 起一份真服务（本机自用模式、临时 HOME / 数据根、随机端口），拿它自己报的实例号当「认过的那一份」，
// 再拿一个别的实例号当「端口换人之前认过的那一份」：
//   · 带着别人的实例号来的写请求 409，库里一行都没写进去（cookie、请求头两条路都试）；
//   · 页面本身、预览代理、预览的 WebSocket 升级同样拒；
//   · `/api/health` 照常答（窗口靠它重新认人），带着自己的实例号、或者什么都不带的请求照常执行；
//   · mac app 窗口专用的端口（`ASH_WINDOW_PORT`，server/src/window-port.ts）：health 报出它，它上面
//     一样能用、一样认实例号；端口被别的程序占着时 health 报 null，服务照常在主端口上起来。
//
// 跑法：npm -w server run test:instance-binding
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "ash-instance-binding-"));
const home = join(root, "home");
const data = join(root, "data");
const project = join(root, "project");
for (const dir of [home, data, project]) mkdirSync(dir, { recursive: true });

const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});
const port = await freePort();
const windowPort = await freePort();
const base = `http://127.0.0.1:${port}`;
let server: ChildProcess | null = null;

async function startServer(window: number): Promise<void> {
  const output: string[] = [];
  const child = spawn(process.execPath, ["--import", tsx, "src/index.ts"], {
    cwd: serverRoot,
    env: {
      HOME: home, PATH: "/usr/bin:/bin", PORT: String(port), ASH_LOCAL_ONLY: "1", ASH_DATA_DIR: data, ASH_DB: join(data, "ash.db"),
      ASH_WINDOW_PORT: String(window),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;
  child.stdout!.on("data", (d) => output.push(String(d)));
  child.stderr!.on("data", (d) => output.push(String(d)));
  const started = Date.now();
  while (!/server on/.test(output.join(""))) {
    assert.ok(child.exitCode === null, `服务没起来：\n${output.join("")}`);
    assert.ok(Date.now() - started < 60_000, `等服务超时：\n${output.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopServer(): Promise<void> {
  const child = server;
  if (!child) return;
  server = null;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.exitCode !== null ? resolve(null) : child.once("exit", resolve));
}

type Health = { instance?: { id?: string; windowPort?: number | null } };

try {
  await startServer(windowPort);
  const health = await (await fetch(`${base}/api/health`)).json() as Health;
  const ours = health.instance?.id;
  assert.ok(ours && /^[0-9a-f-]{36}$/.test(ours), `本机直连的 health 要报实例号：${JSON.stringify(health)}`);
  assert.equal(health.instance?.windowPort, windowPort, "health 报出窗口专用端口");
  const stale = "00000000-0000-4000-8000-000000000000";

  const create = (name: string, headers: Record<string, string>) => fetch(`${base}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name, repoPath: project }),
  });
  const names = async () => ((await (await fetch(`${base}/api/projects`)).json()) as { name: string }[]).map((p) => p.name);

  for (const [label, headers] of [
    ["cookie", { cookie: `theme=dark; ash_instance=${stale}` }],
    ["请求头", { "x-ash-instance": stale }],
    ["cookie 对、请求头不对", { cookie: `ash_instance=${ours}`, "x-ash-instance": stale }],
  ] as const) {
    const response = await create(`stale-${label}`, headers);
    assert.equal(response.status, 409, `带着别人的实例号（${label}）的写请求要 409`);
    assert.equal(((await response.json()) as { instanceMismatch?: boolean }).instanceMismatch, true);
  }
  assert.deepEqual((await names()).filter((n) => n.startsWith("stale-")), [], "被拒的写请求一行都没写进库");

  assert.equal((await create("ours", { cookie: `ash_instance=${ours}` })).status < 300, true, "带自己的实例号照常执行");
  assert.equal((await create("plain", {})).status < 300, true, "什么都不带（浏览器、CLI）照常执行");
  assert.deepEqual((await names()).filter((n) => n === "ours" || n === "plain").sort(), ["ours", "plain"]);

  const staleCookie = { cookie: `ash_instance=${stale}` };
  assert.equal((await fetch(`${base}/`, { headers: staleCookie })).status, 409, "页面本身也不给");
  assert.equal((await fetch(`${base}/api/tasks`, { headers: staleCookie })).status, 409, "读接口也不给（SSE、轮询同一条路）");
  assert.equal((await fetch(`${base}/preview/x/`, { headers: staleCookie })).status, 409, "预览代理排在后面，同样拒");
  assert.equal((await fetch(`${base}/api/health`, { headers: staleCookie })).status, 200, "health 照常答，窗口靠它重新认人");

  // 预览的 WebSocket 升级不经过 Hono。
  const upgrade = (at: number) => new Promise<string>((resolve, reject) => {
    const socket = connect(at, "127.0.0.1", () => socket.write([
      "GET /preview/x/ws HTTP/1.1", `Host: 127.0.0.1:${at}`, "Connection: Upgrade", "Upgrade: websocket",
      "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", `Cookie: ash_instance=${stale}`, "", "",
    ].join("\r\n")));
    let reply = "";
    socket.on("data", (chunk) => { reply += String(chunk); });
    socket.on("end", () => resolve(reply));
    socket.on("error", reject);
  });
  for (const at of [port, windowPort]) {
    const reply = await upgrade(at);
    assert.match(reply, /^HTTP\/1\.1 409/, `预览 WebSocket 升级同样拒（${at}）：${reply}`);
  }

  // 窗口专用端口：同一份服务、同一套判据。
  const windowBase = `http://127.0.0.1:${windowPort}`;
  const viaWindow = await (await fetch(`${windowBase}/api/health`)).json() as Health;
  assert.equal(viaWindow.instance?.id, ours, "窗口端口上答的是同一份服务");
  const windowCreate = (name: string, cookie: string) => fetch(`${windowBase}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, repoPath: project }),
  });
  assert.equal((await windowCreate("window-stale", `ash_instance=${stale}`)).status, 409, "窗口端口上带着别人的实例号一样 409");
  assert.ok((await windowCreate("window-ours", `ash_instance=${ours}`)).status < 300, "窗口端口上带自己的实例号照常执行");
  assert.deepEqual((await names()).filter((n) => n.startsWith("window-")), ["window-ours"]);
  assert.equal((await fetch(`${windowBase}/`, { headers: { cookie: `ash_instance=${ours}` } })).status, 200, "窗口端口上能载页面");

  // 窗口专用端口被别的程序占着：服务照常起在主端口上，health 报 null（app 据此不载页面）。
  await stopServer();
  const squatter = createServer().listen(windowPort, "127.0.0.1");
  await once(squatter, "listening");
  try {
    await startServer(windowPort);
    const occupied = await (await fetch(`${base}/api/health`)).json() as Health;
    assert.ok(occupied.instance?.id, "主端口照常答");
    assert.equal(occupied.instance?.windowPort, null, "没监听上的窗口端口报 null，不冒充");
  } finally {
    squatter.close();
  }

  console.log("test-instance-binding: ok");
} finally {
  await stopServer();
  // 服务开机会问一下本机装着的 CLI（ash MCP 登记自检，auth/user-cli.ts），那个子进程可能比服务活得久、
  // 往临时 HOME 里落一份配置：删完再看一会儿，又冒出来就再删。
  for (let quiet = 0; quiet < 4;) {
    rmSync(root, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    quiet = existsSync(root) ? 0 : quiet + 1;
  }
}
