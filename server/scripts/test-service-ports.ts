/**
 * 「停止命令留空 = 杀掉启动起来的东西」最后一档的回归:**端口兜底**(server/src/service-ports.ts)。
 *
 * 前三档(ppid 树 / ctty 会话成员 / 累积 pgid)由 test-project-commands.ts 盯着,那套能覆盖
 * `cmd &`、nohup、disown。这里专钉它们都够不着的那一种:**真·守护化** —— 子进程 setsid 自成
 * 会话、父进程随即退出让它挂到 PID 1 名下、stdio 全部重定向。knowledge-base 的 kb.sh 就是这个
 * 形状(用户 2026-10-26 报的「启动了按钮却没变成停止」),ash 按进程归属一个线索都找不到,
 * 只剩服务自己打印的那句 `http://127.0.0.1:<port>`。
 *
 * 三件事必须成立:① 那句话被记下来、端口还听着就等于「服务开着」(按钮该是停止);
 * ② 点停止真能把它杀掉;③ 端口上坐着的若不是这次启动起来的,**绝不动它**,而是如实说清楚。
 * ③ 是这条路全部的安全性 —— 杀错进程不可逆。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE_COMMAND_ID } from "@ash/shared/project-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { listeningPids, portsFromOutput, stopByPorts } from "../src/service-ports.js";
import { terminalSessions } from "../src/terminal.js";
import { startCommand, stopCommand, type RunnableCommand } from "../src/terminal-commands.js";

// ── 认端口:只认本机地址、只认 ≥1024 ────────────────────────────────────────
assert.deepEqual(portsFromOutput("[web] http://127.0.0.1:8787"), [8787]);
assert.deepEqual(portsFromOutput("  ➜  Local:   http://localhost:5173/"), [5173]);
assert.deepEqual(portsFromOutput("listening on 0.0.0.0:3000 and http://[::1]:3000"), [3000], "同一个端口只记一次");
assert.deepEqual(portsFromOutput("connected to db.internal:5432"), [], "非本机主机名不是我们起的服务");
assert.deepEqual(portsFromOutput("http://127.0.0.1:80"), [], "低位端口一律不碰:那一档住的是系统服务");
assert.deepEqual(portsFromOutput("已启动 http://127.0.0.1:4000，另一个在 http://localhost:4001"), [4000, 4001]);

if (IS_WINDOWS) {
  // Windows 没有 lsof,这一档整档不启用(service-ports.ts 里直接短路),行为与改动前一致。
  assert.deepEqual(await stopByPorts([8787], { cwd: process.cwd(), since: Date.now() }), { killed: [], spared: [] });
  console.log("service ports test passed (windows: 端口兜底不启用)");
  process.exit(0);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-ports-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "ash-outside-")));

/** 一个只管听端口、把自己 pid 写进文件的小服务。 */
const serverSource = `
const http = require("node:http");
const fs = require("node:fs");
const [port, pidfile] = process.argv.slice(2);
http.createServer((_, res) => res.end("ok")).listen(Number(port), "127.0.0.1", () => {
  fs.writeFileSync(pidfile, String(process.pid));
});
`;
writeFileSync(join(cwd, "serve.js"), serverSource);

/** 没人用的端口:先听一下再让开,拿到号码。 */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等不到:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const serviceSession = (projectId: string) => terminalSessions.listCommandSessions()
  .filter((session) => session.projectId === projectId && session.commandId === SERVICE_COMMAND_ID)
  .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

try {
  // ── ① 守护化的服务:启动脚本退了,端口还听着 = 开着 ──────────────────────────
  const port = await freePort();
  const pidfile = join(cwd, "service.pid");
  // detached:true 就是 setsid;父进程随即退出,服务挂到 PID 1 名下 —— 与 kb.sh 的
  // daemonize() 同形。启动脚本最后自报端口,那是后面唯一还指得到它的线索。
  const script = [
    `node -e 'const {spawn}=require("node:child_process");`
    + `const c=spawn(process.argv[1],["serve.js","${port}","${pidfile}"],{detached:true,stdio:"ignore"});c.unref();'`
    + ` ${process.execPath}`,
    `echo "[svc] 已启动 http://127.0.0.1:${port}"`,
  ].join("\n");
  const service: RunnableCommand = {
    id: SERVICE_COMMAND_ID, name: "服务", command: script, restartCommand: null, stopCommand: null,
  };
  assert.equal((await startCommand("ports1", cwd, service)).status, 201);
  await waitFor("启动脚本自己退出(守护化形状)", () => serviceSession("ports1")?.exitCode !== null);
  await waitFor("服务真的听上了端口", async () => (await listeningPids(port)).length > 0);
  const servicePid = Number(readFileSync(pidfile, "utf8").trim());
  assert.ok(servicePid > 0 && alive(servicePid), "守护进程应当活着");

  const session = serviceSession("ports1")!;
  assert.deepEqual(session.ports, [port], "启动脚本打印的端口要被记下来");
  assert.equal(session.groupAlive, false, "进程归属那条线索确实断了 —— 这正是本回归要盯的形状");
  await waitFor("端口探测那一拍把 portsAlive 翻成 true", () => serviceSession("ports1")?.portsAlive === true);

  // ② 没配停止命令也要能停:按端口找到它,连进程组一起收。
  const stopped = await stopCommand("ports1", SERVICE_COMMAND_ID, null, { portGraceMs: 500 });
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.body, { stopped: true });
  await waitFor("守护进程被杀掉", () => !alive(servicePid));
  assert.deepEqual(await listeningPids(port), [], "端口要真的让出来");
  await waitFor("停过之后不再说它开着", () => serviceSession("ports1")?.portsAlive === false);
  assert.equal(serviceSession("ports1")?.stoppedByUser, true, "「我点过停止」要留下来,刷新后还看得见");

  // ── ③ 身份闸:端口上不是这次起的东西,一根汗毛都不许动 ──────────────────────
  const strayPort = await freePort();
  const strayPidfile = join(outside, "stray.pid");
  const stray = spawn(process.execPath, [join(cwd, "serve.js"), String(strayPort), strayPidfile], {
    cwd: outside, detached: true, stdio: "ignore",
  });
  stray.unref();
  await waitFor("旁人把端口占上", async () => (await listeningPids(strayPort)).length > 0);
  const strayPid = Number(readFileSync(strayPidfile, "utf8").trim());

  // 工作目录不在项目里 —— 典型如 docker 的后台进程替容器转发端口,杀它会殃及别人。
  const spared = await stopByPorts([strayPort], { cwd, since: Date.now() - 60_000, graceMs: 300 });
  assert.deepEqual(spared.killed, [], "工作目录不在项目里的住户不许杀");
  assert.equal(spared.spared.length, 1);
  assert.match(spared.spared[0].reason, /工作目录/);
  assert.ok(alive(strayPid), "它必须还好好活着");

  // 比这次启动更早起来的也不许杀 —— 端口本来就被人占着,不是我们起的。
  const older = await stopByPorts([strayPort], { cwd: outside, since: Date.now() + 60_000, graceMs: 300 });
  assert.deepEqual(older.killed, []);
  assert.match(older.spared[0].reason, /不是这次起来的/);
  assert.ok(alive(strayPid), "它必须还好好活着");

  // 两条都核得上才动手(cwd 在项目里 + 起得比这次晚),这时才允许杀。
  const killed = await stopByPorts([strayPort], { cwd: outside, since: Date.now() - 60_000, graceMs: 500 });
  assert.equal(killed.killed.length, 1);
  assert.equal(killed.killed[0].pid, strayPid);
  await waitFor("核得上身份的才真被杀", () => !alive(strayPid));

  // ④ 杀不到时绝不谎报:端口上坐着别人,停止要返回失败并说清楚出路,而不是说「已停止」。
  const heldPort = await freePort();
  const heldPidfile = join(outside, "held.pid");
  const held = spawn(process.execPath, [join(cwd, "serve.js"), String(heldPort), heldPidfile], {
    cwd: outside, detached: true, stdio: "ignore",
  });
  held.unref();
  await waitFor("第三方服务听上了端口", async () => (await listeningPids(heldPort)).length > 0);
  const heldPid = Number(readFileSync(heldPidfile, "utf8").trim());
  const fake: RunnableCommand = {
    id: SERVICE_COMMAND_ID, name: "服务", command: `echo "listening on http://127.0.0.1:${heldPort}"`,
    restartCommand: null, stopCommand: null,
  };
  assert.equal((await startCommand("ports2", cwd, fake)).status, 201);
  await waitFor("这条启动脚本退出", () => serviceSession("ports2")?.exitCode !== null);
  await waitFor("它也认为服务开着(端口有人听)", () => serviceSession("ports2")?.portsAlive === true);
  const refused = await stopCommand("ports2", SERVICE_COMMAND_ID, null, { portGraceMs: 300 });
  assert.equal(refused.status, 502, "杀不到就得报失败");
  assert.match((refused.body as { error: string }).error, /还有人在听/);
  assert.match((refused.body as { error: string }).error, /停止命令/, "要给出路:去配一条停止命令");
  assert.ok(alive(heldPid), "别人的进程一根汗毛都不许动");
  try { process.kill(heldPid, "SIGKILL"); } catch { /* 清场 */ }

  console.log("service ports test passed");
} finally {
  terminalSessions.shutdown();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
