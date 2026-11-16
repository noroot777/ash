// 回归:单实例锁里的号码**不授权**停任何进程(restart.mjs 的 answeringPid 注释)。
//
// 事故形状:ash 没正常退出,锁留在原地,号码被别的进程复用 —— Windows 上重启过机器几乎
// 必然撞上。旧版拿锁里的号码当旧实例去停:Windows 上报「无法安全终止 Windows 旧实例」拒绝
// 重启(--force 则整树强杀它),POSIX 上直接 SIGTERM 它。中间两版改成按命令行把号码「认回
// 来」,照样认错(第 1、2 轮审查)—— 所以这里的旁观者故意做成最难分辨的样子:命令行末尾
// 就是 ash 的 server 入口,锁里的 argv 与启动时刻都照它的真值写。
//
// 端到端跑真的 restart.mjs(假 npm、假 server,同 test-restart.mjs 的搭法),端口上没人应答:
// 重启必须照常完成,旁观者必须毫发无损。
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
const PORT = 14327;
const TMP = mkdtempSync(join(tmpdir(), "ash-restart-lock-"));
const FAKE_BIN = join(TMP, "bin");
const ENTRY = join(TMP, "ash", "server", "dist", "index.js");
const BYSTANDER = join(TMP, "watcher.cjs");
const BORN = join(TMP, "bystander.json");
const PID_FILE = join(TMP, "server.pid");
mkdirSync(FAKE_BIN);
mkdirSync(join(TMP, "ash", "server", "dist"), { recursive: true });

const npmShim = join(FAKE_BIN, "npm-shim.mjs");
writeFileSync(npmShim, "");
if (IS_WINDOWS) {
  writeFileSync(join(FAKE_BIN, "npm.cmd"), `@echo off\r\nnode "${npmShim}" %*\r\n`);
} else {
  writeFileSync(join(FAKE_BIN, "npm"), `#!/bin/sh\nexec node "${npmShim}" "$@"\n`);
  chmodSync(join(FAKE_BIN, "npm"), 0o755);
}
writeFileSync(ENTRY, "setInterval(() => {}, 1000);\n");
writeFileSync(BYSTANDER, `require("node:fs").writeFileSync(${JSON.stringify(BORN)}, JSON.stringify({
  argv: process.argv, born: Date.now() - Math.round(process.uptime() * 1000) }));
setInterval(() => {}, 1000);\n`);
const fakeServer = join(TMP, "fake-server.mjs");
writeFileSync(fakeServer, `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
createServer((req, res) => {
  const body = req.url?.startsWith("/api/restart-impact")
    ? '{"survives":[],"resumes":[],"interrupted":[],"mcpDisrupted":[]}'
    : JSON.stringify({ ok: true, pid: process.pid });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}).listen(${PORT}, "127.0.0.1", () => writeFileSync(${JSON.stringify(PID_FILE)}, String(process.pid)));
`);

const bystander = spawnTestFixture(process.execPath, [BYSTANDER, "--entry", ENTRY], { stdio: "ignore" });
let server = null;
await withTestResources(async () => {
  for (let i = 0; i < 100 && !existsSync(BORN); i++) await sleep(50);
  const { argv, born } = JSON.parse(readFileSync(BORN, "utf8"));
  writeFileSync(join(TMP, "ash.db.ash.lock"), JSON.stringify({
    version: 1, pid: bystander.pid, processStartedAtMs: born, port: PORT, argv, cwd: TMP, token: "t",
  }));

  const run = await runTestProcess(process.execPath, [join(REPO, "scripts", "restart.mjs"), "--skip-mcp"], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: FAKE_BIN + (IS_WINDOWS ? ";" : ":") + process.env.PATH,
      PORT: String(PORT),
      ASH_DB: join(TMP, "ash.db"),
      ASH_LOG: join(TMP, "ash.log"),
      SERVER_ENTRY: fakeServer,
      START_TIMEOUT: "10",
    },
    encoding: "utf8",
    preserveScripts: [fakeServer],
  });
  const serverPid = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, "utf8").trim()) : 0;
  server = run.preserved.find((instance) => instance.pid === serverPid) ?? null;
  const output = (run.stdout ?? "") + (run.stderr ?? "");

  assert.ok(isPidAlive(bystander.pid), `锁里的号码被当成旧实例停掉了:\n${output}`);
  assert.doesNotMatch(output, /无法安全终止|试过 kill/, "锁里的号码不该进候选");
  assert.match(output, new RegExp(`${PORT} 已就绪`), `重启没完成:\n${output}`);
  console.log("✓ 残锁指向一个命令行末尾就是 ash 入口的无关进程:重启照常完成,它毫发无损");
}, [
  async () => {
    if (!server) return;
    const shot = terminateInstance(server);
    if (shot.error) throw shot.error;
    for (let i = 0; i < 50 && isPidAlive(server.pid); i++) await sleep(40);
  },
  () => bystander.dispose(),
  () => rmSync(TMP, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }),
]);
