// 回归:restart.mjs 停谁只认「谁在监听端口」,单实例锁里的号码不当线索(用户 2026-11-16 选定)。
//
// 事故形状:ash 没正常退出,锁留在原地,号码被别的进程复用 —— 2026-11-16 那台 Windows 上旧 ash
// 11-12 就死了,号码被一个系统服务占着,restart 拿它当旧实例,报「无法安全终止 Windows 旧实例:
// <pid> 的进程身份不完整」。中间几版试过从锁里把号码「认回来」(比对命令行、出生时刻早于心跳),
// 都被审查拆穿:命令行会认错,时钟回拨能骗过心跳证明。所以这里的旁观者两种形状都做:命令行末尾
// 就是 ash 入口,锁里的心跳既有「早于它出生」也有「晚于它出生」(时钟回拨后的样子)。
//
// 端到端跑真的 restart.mjs(假 npm、假 server,同 test-restart.mjs 的搭法)。POSIX 上用一组一律
// 失败的 lsof/ss/fuser 垫片模拟「系统查不出监听者」;Windows 的监听者走 PowerShell,垫不掉,
// 那一段只在 POSIX 上跑。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
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
const NO_LISTENERS_BIN = join(TMP, "no-listeners");
const ENTRY = join(TMP, "ash", "server", "dist", "index.js");

// 四个互不相同的空闲端口：同时占住再一起放，免得拿到同一个。写死端口的话这条测试没法跟自己并行，
// 也会撞上机器上碰巧占着那个号的东西。
const PORTS = await (async () => {
  const probes = await Promise.all(Array.from({ length: 4 }, async () => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    return probe;
  }));
  const ports = probes.map((probe) => probe.address().port);
  await Promise.all(probes.map((probe) => new Promise((done) => probe.close(done))));
  return ports;
})();

function shim(dir, name, body) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
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

/** 跑一次真的 restart.mjs。新起的假 server 记进 `started`,由收尾统一停掉。 */
const started = [];
async function restart(port, { lock = null, args = [], status = 0, noListeners = false } = {}) {
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
  const bins = noListeners ? [NO_LISTENERS_BIN, FAKE_BIN] : [FAKE_BIN];
  const run = await runTestProcess(process.execPath, [join(REPO, "scripts", "restart.mjs"), "--skip-mcp", ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: [...bins, process.env.PATH].join(IS_WINDOWS ? ";" : ":"),
      PORT: String(port),
      ASH_DB: join(dir, "ash.db"),
      ASH_LOG: join(dir, "ash.log"),
      SERVER_ENTRY: fakeServer,
      START_TIMEOUT: "10",
    },
    encoding: "utf8",
    preserveScripts: [fakeServer],
  }, status);
  const serverPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  const server = run.preserved.find((one) => one.pid === serverPid);
  if (server) started.push(server);
  return (run.stdout ?? "") + (run.stderr ?? "");
}

async function stopStarted() {
  for (const instance of started.splice(0)) {
    const shot = terminateInstance(instance);
    if (shot.error) throw shot.error;
    for (let i = 0; i < 50 && isPidAlive(instance.pid); i++) await sleep(40);
  }
}

await withTestResources(async () => {
  mkdirSync(FAKE_BIN);
  mkdirSync(NO_LISTENERS_BIN);
  mkdirSync(join(TMP, "ash", "server", "dist"), { recursive: true });
  writeFileSync(ENTRY, "setInterval(() => {}, 1000);\n");
  const npmShim = join(FAKE_BIN, "npm-shim.mjs");
  writeFileSync(npmShim, "");
  if (IS_WINDOWS) writeFileSync(join(FAKE_BIN, "npm.cmd"), `@echo off\r\nnode "${npmShim}" %*\r\n`);
  else {
    shim(FAKE_BIN, "npm", `exec node "${npmShim}" "$@"`);
    for (const name of ["lsof", "ss", "fuser"]) shim(NO_LISTENERS_BIN, name, "exit 1");
  }

  // ── 1. 残锁的号码被复用:心跳早于它出生、晚于它出生(时钟回拨)都不碰 ────────────
  {
    const script = fixtureScript("bystander");
    const bystander = spawnTestFixture(process.execPath, [script.file, "--entry", ENTRY], { stdio: "ignore" });
    await withTestResources(async () => {
      const { argv, born } = await bornOf(script.born);
      for (const [port, heartbeatAtMs, shape] of [[PORTS[0], born - 2_000, "心跳早于它出生"], [PORTS[3], born + 3_600_000, "时钟回拨:心跳晚于它出生"]]) {
        const output = await restart(port, { lock: { pid: bystander.pid, processStartedAtMs: born - 3_600_000, argv, heartbeatAtMs } });
        assert.ok(isPidAlive(bystander.pid), `${shape}:锁里的号码被当成旧实例停掉了:\n${output}`);
        assert.doesNotMatch(output, /无法安全终止|试过 kill/, `${shape}:锁里的号码不该进候选`);
        assert.match(output, new RegExp(`${port} 已就绪`), `${shape}:重启没完成:\n${output}`);
        await stopStarted();
      }
      console.log("✓ 残锁的号码被一个命令行末尾就是 ash 入口的进程复用:心跳怎么写都不碰它,重启照常完成");
    }, [stopStarted, () => bystander.dispose()]);
  }

  // ── 2. 卡死不应答的旧实例,系统查得到监听者:--force 换得掉 ────────────────────
  {
    const port = PORTS[1];
    const script = fixtureScript("hung-listened", { port, hung: true });
    const old = spawnTestFixture(process.execPath, [script.file], { stdio: "ignore" });
    await withTestResources(async () => {
      await bornOf(script.born);
      const output = await restart(port, { args: ["--force"] });
      assert.match(output, new RegExp(`${port} 已就绪`), `卡死的旧实例没被换掉:\n${output}`);
      for (let i = 0; i < 50 && isPidAlive(old.pid); i++) await sleep(40);
      assert.ok(!isPidAlive(old.pid), "卡死的旧实例还活着");
      console.log("✓ 卡死不应答的旧实例:按监听者找到它,--force 换得掉");
    }, [stopStarted, () => old.dispose()]);
  }

  // ── 3. 同样卡死,但系统查不出监听者:不碰它(锁里有它的号码也不用),如实中止 ──────
  if (!IS_WINDOWS) {
    const port = PORTS[2];
    const script = fixtureScript("hung-unlistened", { port, hung: true });
    const old = spawnTestFixture(process.execPath, [script.file], { stdio: "ignore" });
    await withTestResources(async () => {
      const { argv, born } = await bornOf(script.born);
      await sleep(2_000);
      const lock = { pid: old.pid, processStartedAtMs: born, argv, heartbeatAtMs: Date.now() };
      const output = await restart(port, { lock, args: ["--force"], status: 1, noListeners: true });
      assert.ok(isPidAlive(old.pid), "查不出监听者时不该凭锁里的号码下刀");
      assert.match(output, /连得上、但不应答/, `没说清端口被谁占着:\n${output}`);
      assert.match(output, /lsof\/ss\/fuser/, `没提示查不到监听者的原因:\n${output}`);
      assert.doesNotMatch(output, /已就绪|启动进程已退出|EADDRINUSE/, `不该去起新进程:\n${output}`);
      console.log("✓ 卡死且查不出监听者:不碰它,如实中止并提示手工停掉,不起注定撞端口的新进程");
    }, [stopStarted, () => old.dispose()]);
  }
}, [() => rmSync(TMP, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 })]);
