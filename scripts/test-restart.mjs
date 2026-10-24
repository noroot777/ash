#!/usr/bin/env node
// 回归 restart.mjs 的本机探测：即使环境里有 HTTP_PROXY，:PORT 的探活也必须直连，
// 不能把「代理暂时连不上刚重启的服务」误报成「服务没起来」。
//
// 跟旧的 test-restart.sh 比,断言换了一档:那版是拦一个假 curl、检查参数里有没有
// `--noproxy '*'`;现在探活走 node:http(压根不读代理环境变量),没有参数可查,于是
// 改成端到端 —— 把 HTTP_PROXY/ALL_PROXY 指向黑洞,起一个**真的**假 server,看整条
// 流程能不能跑通。这比查参数更靠谱:它测的是「结果对不对」而不是「实现长什么样」。
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// 后半段那个「吃掉 SIGTERM」的假 server:断言中途失败会直接 process.exit,而它既不是
// detached 也杀不死自己,不在这里记一笔就会漏成僵尸,一直占着 :PORT 让下次跑不起来。
let stubbornChild = null;

function cleanup() {
  if (serverPid) killPid(serverPid);
  try { stubbornChild?.kill("SIGKILL"); } catch { /* 已经没了 */ }
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
  const residual = process.env.RESTART_TEST_RESIDUAL;
  const body = req.url?.startsWith("/api/restart-impact")
    ? '{"survives":[],"resumes":[],"interrupted":[],"mcpDisrupted":[]}'
    : JSON.stringify({ ok: true, pid: process.pid, previousResidualLock: residual ? JSON.parse(residual) : null });
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
  // 单实例锁的路径跟着 DB 走。指到临时目录,免得脚本读到本机真 ash 的那把锁
  // (它另有 port 判据兜着,但测试没道理去碰用户正在跑的东西)。
  ASH_DB: join(TMP, "ash.db"),
};

const run = spawnSync(process.execPath, [join(REPO, "scripts", "restart.mjs"), "--skip-mcp"], {
  cwd: REPO,
  env: { ...env, SKIP_MCP: "" },
  encoding: "utf8",
});
const output = (run.stdout ?? "") + (run.stderr ?? "");

// server 是 detached 起来的,脚本返回之后才读得到 pid;先记下来,后面的断言失败也能清理。
try { serverPid = Number(readFileSync(PID_FILE, "utf8").trim()); } catch { /* 下面统一报错 */ }

if (run.status !== 0) fail(`restart.mjs 退出码 ${run.status}`, output);
if (!output.includes(`${PORT} 已就绪`)) fail("没等到「已就绪」——本机探活可能被代理劫走了", output);
if (!output.includes("✅ 完成")) fail("没跑到最后一步", output);
if (!output.includes("⏭ SKIP_MCP")) fail("--skip-mcp 没跳过 MCP 刷新", output);

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

// ── 旧进程没下线时，绝不许报成功 ──────────────────────────────────────────────
// 2026-08-21 的真实故障：Rocky 容器里没装 lsof(ss/fuser 也可能没有)，listenerPids
// 返回空 → 旧进程被整个放过 → 新进程撞单实例锁当场退出 → 而 /api/health 由**老
// 进程**回 200，脚本打印「✓ 已就绪」。用户以为重启成功，机器上跑的是三小时前的
// 代码。这里用一个吃掉 SIGTERM 的赖着不走的 server 复现同一局面：不管平台上有没有
// lsof，它都杀不死，端口始终有人应答 —— 脚本必须失败退出，而不是报就绪。
//
// **这一段是 POSIX 专用的**:整个局面建立在「进程能忽略停止信号」之上,而 Windows
// 没有 SIGTERM,`killPid` 走的是无条件的 `taskkill /F` —— 赖着不走这个前提在那边
// 根本搭不出来,硬跑只会得到一条假失败,还会把后面几条用例挡在门外(2026-10-20 真机
// 验证时实测)。那条闸本身在 Windows 上照样有效,只是这个复现手法不适用。
const stubbornSkipped = IS_WINDOWS;
if (!stubbornSkipped) {
const stubborn = join(TMP, "stubborn.mjs");
const STUBBORN_PID = join(TMP, "stubborn.pid");
writeFileSync(stubborn, `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
process.on("SIGTERM", () => {});
createServer((req, res) => {
  const body = req.url?.startsWith("/api/restart-impact")
    ? '{"survives":[],"resumes":[],"interrupted":[],"mcpDisrupted":[]}'
    : JSON.stringify({ ok: true, pid: process.pid });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}).listen(${PORT}, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(STUBBORN_PID)}, String(process.pid));
});
`);

const stubbornProc = spawn(process.execPath, [stubborn], { stdio: "ignore", detached: false });
// 记一笔:上面那条注释说的就是它 —— 断言中途 `fail()` 会直接 process.exit,不登记
// 就漏成僵尸占着 :PORT。原来只登记了后半段那个回 401 的,这一个漏了。
stubbornChild = stubbornProc;
for (let i = 0; i < 50 && !existsSync(STUBBORN_PID); i++) await sleep(100);
if (!existsSync(STUBBORN_PID)) fail("赖着不走的假 server 没起来,这条回归没法测");

const blocked = spawnSync(process.execPath, [join(REPO, "scripts", "restart.mjs")], {
  cwd: REPO,
  env: { ...env, START_TIMEOUT: "3" },
  encoding: "utf8",
});
const blockedOutput = (blocked.stdout ?? "") + (blocked.stderr ?? "");
try { stubbornProc.kill("SIGKILL"); } catch { /* 已经没了 */ }
stubbornChild = null;
await sleep(200);

if (blocked.status === 0) fail("旧进程没下线,restart 却报了成功", blockedOutput);
if (blockedOutput.includes("已就绪")) fail("旧进程还占着端口,却打印了「已就绪」", blockedOutput);
if (!blockedOutput.includes("仍有一个 ash 在应答")) {
  fail("失败信息没说清「旧的没下线」这个成因", blockedOutput);
}
}

// ── 问不到「会打断谁」时必须 fail closed ──────────────────────────────────────
// 多人模式下 `/api/restart-impact` 要宿主机凭证(单实例锁文件里那串 token)。读不到锁、
// 或者跑脚本的不是启动 ash 的那个用户时,端点会 401 —— 而 `localJson` 把「连不上」和
// 「被拒」一律压成 null,脚本于是把「会被打断的任务数」算成 0,不加 FORCE 也照杀
// (第 1 轮审查 P1:安全闸静默失效)。这里让假 server 对这条端点回 401,其余照常 200,
// 脚本必须当场中止且**不许碰旧进程**。
const refusing = join(TMP, "refusing.mjs");
const REFUSING_PID = join(TMP, "refusing.pid");
writeFileSync(refusing, `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
createServer((req, res) => {
  if (req.url?.startsWith("/api/restart-impact")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"请先登录","needsAuth":true}');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, pid: process.pid }));
}).listen(${PORT}, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(REFUSING_PID)}, String(process.pid));
});
`);

for (const [forceLabel, forceArgs, forceEnv] of [
  ["FORCE=1", [], { FORCE: "1" }],
  ["--force", ["--force"], { FORCE: "" }],
]) {
rmSync(REFUSING_PID, { force: true });
const refusingProc = spawn(process.execPath, [refusing], { stdio: "ignore", detached: false });
stubbornChild = refusingProc;
for (let i = 0; i < 50 && !existsSync(REFUSING_PID); i++) await sleep(100);
if (!existsSync(REFUSING_PID)) fail("回 401 的假 server 没起来,这条回归没法测");
const refusingPid = Number(readFileSync(REFUSING_PID, "utf8").trim());

const refused = spawnSync(process.execPath, [join(REPO, "scripts", "restart.mjs")], {
  cwd: REPO,
  env: { ...env, START_TIMEOUT: "3" },
  encoding: "utf8",
});
const refusedOutput = (refused.stdout ?? "") + (refused.stderr ?? "");
const survived = isPidAlive(refusingPid);

if (refused.status !== 2) fail(`服务端拒答判据时该以 2 中止,实际 ${refused.status}`, refusedOutput);
if (!refusedOutput.includes("问不到「重启会打断谁」")) {
  fail("中止信息没说清「问不到判据」这个成因", refusedOutput);
}
if (refusedOutput.includes("已就绪")) fail("问不到判据却照样重启了", refusedOutput);
if (!survived) fail("问不到判据时不许动旧进程,它却被杀了", refusedOutput);
if (!refusedOutput.includes("npm run restart -- --force")) fail("没提供跨平台强制重启命令", refusedOutput);

// FORCE=1 是明说「知道可能打断也要重启」,那条路不该被这道闸挡住 —— 同一个回 401 的
// 旧 server 还在端口上,这次必须被换掉。
const restartArgs = forceArgs.length && process.env.npm_execpath
  ? [process.env.npm_execpath, "run", "restart", "--", ...forceArgs]
  : [join(REPO, "scripts", "restart.mjs"), ...forceArgs];
const forced = spawnSync(process.execPath, restartArgs, {
  cwd: REPO,
  env: { ...env, ...forceEnv, START_TIMEOUT: "10" },
  encoding: "utf8",
});
const forcedOutput = (forced.stdout ?? "") + (forced.stderr ?? "");
try { refusingProc.kill("SIGKILL"); } catch { /* 已经没了 */ }
stubbornChild = null;
try { serverPid = Number(readFileSync(PID_FILE, "utf8").trim()); } catch { /* 下面统一报错 */ }
await sleep(200);

if (forced.status !== 0) fail(`${forceLabel} 该照常重启,退出码 ${forced.status}`, forcedOutput);
if (forcedOutput.includes("问不到「重启会打断谁」")) fail(`${forceLabel} 不该被这道闸挡住`, forcedOutput);
if (!forcedOutput.includes(`${PORT} 已就绪`)) fail(`${forceLabel} 没把服务端换成新的`, forcedOutput);
if (serverPid) { killPid(serverPid); serverPid = 0; }
await sleep(200);
}

// ── 判据「问不出来」时也必须 fail closed ──────────────────────────────────────
// 上一条是**服务端明确拒答**(401);这一条是它**在端口上、却没按时答复** —— ash 正忙或者
// 卡住了。两者的 HTTP 读数都是「没拿到 JSON」,过去被压成同一个空对象,于是:
//   ① 安全闸算出「0 个会被打断」,不加 FORCE 也照样下刀;
//   ② Windows 那一刀拿不到 survives 名单,退回 `taskkill /T` 整树强杀,把本来能接管的
//      agent 一起带走 —— 而命令最后照样打印「已就绪」(第 1 轮审查 F1,真机复现)。
// 所以这里让假 server 对这条端点**永不响应**,其余照常 200:脚本必须中止、说清成因、
// 并且一根手指都不许动旧进程。
const mute = join(TMP, "mute.mjs");
const MUTE_PID = join(TMP, "mute.pid");
writeFileSync(mute, `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
createServer((req, res) => {
  if (req.url?.startsWith("/api/restart-impact")) return; // 收下请求,永不作答
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, pid: process.pid }));
}).listen(${PORT}, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(MUTE_PID)}, String(process.pid));
});
`);

const muteProc = spawn(process.execPath, [mute], { stdio: "ignore", detached: false });
stubbornChild = muteProc;
for (let i = 0; i < 50 && !existsSync(MUTE_PID); i++) await sleep(100);
if (!existsSync(MUTE_PID)) fail("不作答的假 server 没起来,这条回归没法测");
const mutePid = Number(readFileSync(MUTE_PID, "utf8").trim());

const muted = spawnSync(process.execPath, [join(REPO, "scripts", "restart.mjs")], {
  cwd: REPO,
  env: { ...env, START_TIMEOUT: "3" },
  encoding: "utf8",
});
const mutedOutput = (muted.stdout ?? "") + (muted.stderr ?? "");
const muteSurvived = isPidAlive(mutePid);
try { muteProc.kill("SIGKILL"); } catch { /* 已经没了 */ }
stubbornChild = null;
await sleep(200);

if (muted.status !== 2) fail(`判据问不出来时该以 2 中止,实际 ${muted.status}`, mutedOutput);
if (!mutedOutput.includes("问不到「重启会打断谁」")) fail("中止信息没说清「问不到判据」这个成因", mutedOutput);
if (!mutedOutput.includes("没答复这条判据")) {
  fail("得说清是「它在、只是没答上来」,不是「它不在」", mutedOutput);
}
if (mutedOutput.includes("已就绪")) fail("问不出判据却照样重启了", mutedOutput);
if (!muteSurvived) fail("问不出判据时不许动旧进程,它却被杀了", mutedOutput);

if (IS_WINDOWS) {
  const statePath = join(TMP, "cim-state.json");
  const servicePath = join(TMP, "cim-service.mjs");
  const hookPath = join(TMP, "cim-fault.cjs");
  writeFileSync(hookPath, `const cp=require('node:child_process');
const original=cp.execFileSync;
cp.execFileSync=function(file,args,options){
  const index=args?.indexOf('-EncodedCommand')??-1;
  const script=index>=0?Buffer.from(args[index+1],'base64').toString('utf16le'):'';
  if(script.includes('Get-CimInstance Win32_Process')) throw new Error('test CIM unavailable');
  return original(file,args,options);
};
require('node:module').syncBuiltinESMExports();`);
  writeFileSync(servicePath, `import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const agent=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
createServer((request,response)=>{
 response.setHeader('content-type','application/json');
 response.end(JSON.stringify(request.url.startsWith('/api/restart-impact')
  ? {survives:[{pid:agent.pid,title:'protected fixture'}],resumes:[],interrupted:[],mcpDisrupted:[]}
  : {ok:true,pid:process.pid}));
}).listen(${PORT},'127.0.0.1',()=>writeFileSync(${JSON.stringify(statePath)},JSON.stringify({pid:process.pid,agent:agent.pid})));`);
  const service = spawn(process.execPath, [servicePath], { stdio: "ignore" });
  stubbornChild = service;
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(statePath); attempt++) await sleep(100);
    if (!existsSync(statePath)) fail("CIM 故障用例的服务没有启动");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const result = spawnSync(process.execPath, [join(REPO, "scripts", "restart.mjs")], {
      cwd: REPO,
      env: { ...env, FORCE: "", WAIT: "", NODE_OPTIONS: `--require "${hookPath.replace(/\\/g, "/")}"` },
      encoding: "utf8", timeout: 60_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    if (result.status !== 2) fail(`CIM 失败时该以 2 中止,实际 ${result.status}`, output);
    if (output.includes("已就绪")) fail("CIM 失败却宣称重启成功", output);
    if (!isPidAlive(state.pid) || !isPidAlive(state.agent)) fail("CIM 失败时动了旧服务或受保护任务", output);
    console.log("✓ HTTP 判据成功但 CIM 查询失败时,完整 restart 在任何终止动作前中止");
  } finally {
    try { service.kill("SIGKILL"); } catch {}
    stubbornChild = null;
    await sleep(200);
  }
}

// ── 「上一轮留下了单例锁」怎么说给用户听 ─────────────────────────────────────
// 第 2 轮审查打回的是这条提示的措辞:账本里有退出意向时它写的是「上一实例是正常停的」。
// 那句站不住 —— 记完账之后再被 SIGKILL 留下的是同一个现场(审查实测)。所以这里钉的是
// 「只报观察到的意向 + 最终死因未知」,并反向断言不许出现那两句定性。
const residual = JSON.stringify({
  at: "2026-10-19T09:00:00.000Z",
  pid: 424242,
  kind: "residual",
  evidence: "exit_intent",
  observedIntent: { kind: "signal", signal: "SIGTERM", at: "2026-10-19T08:59:59.000Z" },
});
const residualRun = spawnSync(process.execPath, [join(REPO, "scripts", "restart.mjs")], {
  cwd: REPO,
  env: { ...env, RESTART_TEST_RESIDUAL: residual },
  encoding: "utf8",
});
const residualOutput = (residualRun.stdout ?? "") + (residualRun.stderr ?? "");
try { serverPid = Number(readFileSync(PID_FILE, "utf8").trim()); } catch { /* 下面统一报错 */ }

if (residualRun.status !== 0) fail(`带残留锁提示时也该正常重启,退出码 ${residualRun.status}`, residualOutput);
if (!residualOutput.includes("退出意向(收到 SIGTERM)")) fail("没把观察到的那条意向报出来", residualOutput);
if (!residualOutput.includes("最终死因仍然未知")) fail("两档都必须落在「死因未知」上", residualOutput);
if (residualOutput.includes("是正常停的")) fail("一条进程内的记录定不了性,不许说成正常停", residualOutput);
if (residualOutput.includes("不是强杀")) fail("同理也不许声称排除强杀", residualOutput);
if (serverPid) { killPid(serverPid); serverPid = 0; }

process.stdout.write("✓ restart.mjs 的本机探测绕过代理，且脚本返回后 detached server 仍在运行\n");
process.stdout.write(stubbornSkipped
  ? "⏭ 旧进程没能下线那条:Windows 上跳过(没有 SIGTERM,赖着不走的前提搭不出来)\n"
  : "✓ 旧进程没能下线时 restart.mjs 明确失败，不再谎报「已就绪」\n");
process.stdout.write("✓ 问不到「会打断谁」时 fail closed(FORCE=1 / --force 仍可越过)\n");
process.stdout.write("✓ 判据超时/无答复也走 fail closed,不退回整树强杀\n");
process.stdout.write("✓ 上一轮留下单例锁时只报观察到的意向,不定性成正常停或强杀\n");
