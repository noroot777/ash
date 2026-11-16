// 回归:restart.mjs 认「停谁」的两条线索里,单实例锁那一条(lockProvenPid)。
//
// 两头都要钉住:
//  · **复用号码不授权下刀**。ash 没正常退出,锁留在原地,号码被别的进程复用 —— Windows 上
//    重启过机器几乎必然。旧版拿锁里的号码当旧实例去停:Windows 上报「无法安全终止 Windows
//    旧实例」拒绝重启(--force 则整树强杀它),POSIX 上直接 SIGTERM 它。中间几版按命令行把
//    号码「认回来」,照样认错(第 1、2 轮审查),所以这里的旁观者命令行末尾就是 ash 入口。
//  · **卡死的真旧实例要停得掉**。系统查不出监听者、它又不应答时,锁是唯一线索;丢了它,
//    --force 也停不掉,新进程起来撞端口(第 3 轮审查)。证明不了身份时必须如实中止,
//    不许起一个注定撞端口的新进程。
//
// 端到端跑真的 restart.mjs(假 npm、假 server,同 test-restart.mjs 的搭法)。POSIX 上用一组
// 一律失败的 lsof/ss/fuser 垫片模拟「系统查不出监听者」;Windows 的监听者走 PowerShell,
// 垫不掉,那边只跑前两段(第二段在那边由监听者那条线索兜住,断言照样成立)。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS, isPidAlive, sleep } from "./platform.mjs";
import { withTestResources } from "./test-process-resources.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture, terminateInstance } from "./test-process-scope.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "ash-restart-lock-"));
const FAKE_BIN = join(TMP, "bin");
const ENTRY = join(TMP, "ash", "server", "dist", "index.js");
mkdirSync(FAKE_BIN);
mkdirSync(join(TMP, "ash", "server", "dist"), { recursive: true });
writeFileSync(ENTRY, "setInterval(() => {}, 1000);\n");

const npmShim = join(FAKE_BIN, "npm-shim.mjs");
writeFileSync(npmShim, "");
if (IS_WINDOWS) {
  writeFileSync(join(FAKE_BIN, "npm.cmd"), `@echo off\r\nnode "${npmShim}" %*\r\n`);
} else {
  for (const [name, body] of [["npm", `exec node "${npmShim}" "$@"`], ["lsof", "exit 1"], ["ss", "exit 1"], ["fuser", "exit 1"]]) {
    writeFileSync(join(FAKE_BIN, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(FAKE_BIN, name), 0o755);
  }
}

/** 一个会自报出生时刻(口径同 server 写锁:Date.now() - uptime)的 fixture;`hung` 时占着端口但从不应答。 */
function fixtureScript(name, { port = 0, hung = false } = {}) {
  const file = join(TMP, `${name}.cjs`);
  const born = join(TMP, `${name}.born`);
  writeFileSync(file, `const { writeFileSync } = require("node:fs");
const report = () => writeFileSync(${JSON.stringify(born)}, JSON.stringify({ argv: process.argv, born: Date.now() - Math.round(process.uptime() * 1000) }));
${hung ? `require("node:http").createServer(() => {}).listen(${port}, "127.0.0.1", report);` : "report();"}
setInterval(() => {}, 1000);\n`);
  return { file, born };
}

async function bornOf(file) {
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(50);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 跑一次真的 restart.mjs。新起的假 server 交回实例凭据,由调用方收走。 */
async function restart(port, lock, args, expectedStatus) {
  const dir = join(TMP, `db-${port}`);
  mkdirSync(dir, { recursive: true });
  if (lock) writeFileSync(join(dir, "ash.db.ash.lock"), JSON.stringify({ version: 1, port, cwd: TMP, token: "t", ...lock }));
  const pidFile = join(dir, "server.pid");
  const fakeServer = join(dir, "fake-server.mjs");
  writeFileSync(fakeServer, `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
createServer((req, res) => {
  const body = req.url?.startsWith("/api/restart-impact")
    ? '{"survives":[],"resumes":[],"interrupted":[],"mcpDisrupted":[]}'
    : JSON.stringify({ ok: true, pid: process.pid });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}).listen(${port}, "127.0.0.1", () => writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
`);
  const run = await runTestProcess(process.execPath, [join(REPO, "scripts", "restart.mjs"), "--skip-mcp", ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: FAKE_BIN + (IS_WINDOWS ? ";" : ":") + process.env.PATH,
      PORT: String(port),
      ASH_DB: join(dir, "ash.db"),
      ASH_LOG: join(dir, "ash.log"),
      SERVER_ENTRY: fakeServer,
      START_TIMEOUT: "10",
    },
    encoding: "utf8",
    preserveScripts: [fakeServer],
  }, expectedStatus);
  const serverPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  return { output: (run.stdout ?? "") + (run.stderr ?? ""), server: run.preserved.find((one) => one.pid === serverPid) ?? null };
}

const started = [];
async function stopStarted() {
  for (const instance of started.splice(0)) {
    const shot = terminateInstance(instance);
    if (shot.error) throw shot.error;
    for (let i = 0; i < 50 && isPidAlive(instance.pid); i++) await sleep(40);
  }
}

// ── 1. 复用号码:旁观者出生在原主最后一次心跳之后 ────────────────────────────────
{
  const script = fixtureScript("bystander");
  const bystander = spawnTestFixture(process.execPath, [script.file, "--entry", ENTRY], { stdio: "ignore" });
  await withTestResources(async () => {
    const { argv, born } = await bornOf(script.born);
    const port = 14327;
    // 号码上的元数据照旁观者的真值写(argv、出生时刻),只有心跳是「原主」留下的。
    const run = await restart(port, { pid: bystander.pid, processStartedAtMs: born, argv, heartbeatAtMs: born - 2_000 }, []);
    if (run.server) started.push(run.server);
    assert.ok(isPidAlive(bystander.pid), `复用号码被当成旧实例停掉了:\n${run.output}`);
    assert.doesNotMatch(run.output, /无法安全终止|试过 kill/, "复用号码不该进候选");
    assert.match(run.output, new RegExp(`${port} 已就绪`), `重启没完成:\n${run.output}`);
    console.log("✓ 残锁的号码被一个命令行末尾就是 ash 入口的进程复用:重启照常完成,它毫发无损");
  }, [stopStarted, () => bystander.dispose()]);
}

// ── 2. 卡死的真旧实例:不应答、系统查不出监听者,锁的心跳证明得了身份 ─────────────
{
  const port = 14328;
  const script = fixtureScript("hung-proven", { port, hung: true });
  const old = spawnTestFixture(process.execPath, [script.file], { stdio: "ignore" });
  await withTestResources(async () => {
    const { argv, born } = await bornOf(script.born);
    // 它活过了几个心跳周期:最后一次心跳在出生之后。
    await sleep(3_000);
    const run = await restart(port, { pid: old.pid, processStartedAtMs: born, argv, heartbeatAtMs: Date.now() }, ["--force"]);
    if (run.server) started.push(run.server);
    assert.match(run.output, new RegExp(`${port} 已就绪`), `卡死的旧实例没被换掉:\n${run.output}`);
    assert.doesNotMatch(run.output, /EADDRINUSE/, "不许起一个撞端口的新进程");
    for (let i = 0; i < 50 && isPidAlive(old.pid); i++) await sleep(40);
    assert.ok(!isPidAlive(old.pid), "卡死的旧实例还活着");
    console.log("✓ 卡死不应答、查不出监听者的旧实例:靠锁的心跳证明身份,--force 换得掉");
  }, [stopStarted, () => old.dispose()]);
}

// ── 3. 同样卡死,但锁证明不了身份(旧版本的锁没有心跳):如实中止,不起新进程 ──────
if (!IS_WINDOWS) {
  const port = 14329;
  const script = fixtureScript("hung-unproven", { port, hung: true });
  const old = spawnTestFixture(process.execPath, [script.file], { stdio: "ignore" });
  await withTestResources(async () => {
    const { argv, born } = await bornOf(script.born);
    const run = await restart(port, { pid: old.pid, processStartedAtMs: born, argv }, ["--force"], 1);
    if (run.server) started.push(run.server);
    assert.ok(isPidAlive(old.pid), "证明不了身份的号码被停掉了");
    assert.match(run.output, /连得上、但不应答/, `没说清端口被谁占着:\n${run.output}`);
    assert.doesNotMatch(run.output, /已就绪|启动进程已退出|EADDRINUSE/, `不该去起新进程:\n${run.output}`);
    console.log("✓ 卡死且身份证明不了:不碰它,如实中止,不起注定撞端口的新进程");
  }, [stopStarted, () => old.dispose()]);
}

rmSync(TMP, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
