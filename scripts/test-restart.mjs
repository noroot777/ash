#!/usr/bin/env node
// 回归 restart.mjs 的本机探测：即使环境里有 HTTP_PROXY，:PORT 的探活也必须直连，
// 不能把「代理暂时连不上刚重启的服务」误报成「服务没起来」。
//
// 跟旧的 test-restart.sh 比,断言换了一档:那版是拦一个假 curl、检查参数里有没有
// `--noproxy '*'`;现在探活走 node:http(压根不读代理环境变量),没有参数可查,于是
// 改成端到端 —— 把 HTTP_PROXY/ALL_PROXY 指向黑洞,起一个**真的**假 server,看整条
// 流程能不能跑通。这比查参数更靠谱:它测的是「结果对不对」而不是「实现长什么样」。
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS, capture, isPidAlive, killPid, sleep } from "./platform.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PORT = 14317;
const TMP = mkdtempSync(join(tmpdir(), "ash-restart-test-"));
const FAKE_BIN = join(TMP, "bin");
mkdirSync(FAKE_BIN);

const PID_FILE = join(TMP, "server.pid");
let serverPid = 0;

function cleanup() {
  if (serverPid) killPid(serverPid);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录,清不掉也无所谓 */ }
}
process.on("exit", cleanup);

function fail(message, extra = "") {
  process.stderr.write(`✕ ${message}\n${extra ? `${extra}\n` : ""}`);
  process.exit(1);
}

// ── 假 npm:只记录被怎么调的,不真装东西 ────────────────────────────────────────
// Windows 上 `npm` 是 `npm.cmd`,PATH 查找靠 PATHEXT —— 两边各放一个垫片,内容都只是
// 转手给同一个 .mjs,免得维护两份逻辑。
const npmShim = join(FAKE_BIN, "npm-shim.mjs");
writeFileSync(npmShim, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.RESTART_TEST_TMP + "/npm.log", process.argv.slice(2).join(" ") + "\\n");
`);
if (IS_WINDOWS) {
  writeFileSync(join(FAKE_BIN, "npm.cmd"), `@echo off\r\nnode "${npmShim}" %*\r\n`);
} else {
  const shim = join(FAKE_BIN, "npm");
  writeFileSync(shim, `#!/bin/sh\nexec node "${npmShim}" "$@"\n`);
  chmodSync(shim, 0o755);
}

// ── 假 server:真监听、真回 JSON ───────────────────────────────────────────────
// 用真的 HTTP server 而不是 stub,是为了让探活走完整条 node:http 路径 —— 代理变量
// 有没有被绕开,只有真发一次请求才看得出来。
const fakeServer = join(TMP, "fake-server.mjs");
writeFileSync(fakeServer, `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
createServer((req, res) => {
  const body = req.url?.startsWith("/api/restart-impact")
    ? '{"survives":[],"resumes":[],"interrupted":[],"mcpDisrupted":[]}'
    : '{"ok":true}';
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}).listen(${PORT}, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(PID_FILE)}, String(process.pid));
});
`);

const env = {
  ...process.env,
  PATH: FAKE_BIN + (IS_WINDOWS ? ";" : ":") + process.env.PATH,
  RESTART_TEST_TMP: TMP,
  HTTP_PROXY: "http://127.0.0.1:1",
  HTTPS_PROXY: "http://127.0.0.1:1",
  ALL_PROXY: "socks5://127.0.0.1:1",
  PORT: String(PORT),
  ASH_LOG: join(TMP, "ash.log"),
  SERVER_ENTRY: fakeServer,
  START_TIMEOUT: "10",
  SKIP_MCP: "1",
};

const run = spawnSync(process.execPath, [join(REPO, "scripts", "restart.mjs")], {
  cwd: REPO,
  env,
  encoding: "utf8",
});
const output = (run.stdout ?? "") + (run.stderr ?? "");

// server 是 detached 起来的,脚本返回之后才读得到 pid;先记下来,后面的断言失败也能清理。
try { serverPid = Number(readFileSync(PID_FILE, "utf8").trim()); } catch { /* 下面统一报错 */ }

if (run.status !== 0) fail(`restart.mjs 退出码 ${run.status}`, output);
if (!output.includes(`${PORT} 已就绪`)) fail("没等到「已就绪」——本机探活可能被代理劫走了", output);
if (!output.includes("✅ 完成")) fail("没跑到最后一步", output);

const npmLog = readFileSync(join(TMP, "npm.log"), "utf8")
  .split("\n")
  .filter((line) => line && !line.startsWith("config get "));
if (npmLog[0] !== "install --no-audit --no-fund") fail(`第一条 npm 操作调用不对:${npmLog[0]}`);
if (npmLog[1] !== "run build") fail(`第二条 npm 操作调用不对:${npmLog[1]}`);

if (!serverPid || !isPidAlive(serverPid)) fail("脚本返回后 detached server 已经不在了", output);

// POSIX 上还能再确认一层:父进程已退出、它被交给了 init(ppid=1),说明确实脱离了
// 调用方的进程组。Windows 没有这个语义(孤儿进程的父 pid 就那么悬着),测到「还活着」为止。
if (!IS_WINDOWS) {
  const ppid = capture("ps", ["-p", String(serverPid), "-o", "ppid="]).trim();
  if (ppid !== "1") fail(`detached server 的 ppid 是 ${ppid},没脱离调用方进程组`);
}

killPid(serverPid);
await sleep(200);
serverPid = 0;

process.stdout.write("✓ restart.mjs 的本机探测绕过代理，且脚本返回后 detached server 仍在运行\n");
