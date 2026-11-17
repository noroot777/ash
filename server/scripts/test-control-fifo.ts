// 可引导单飞回合的 stdin 具名管道不再越攒越多（executors/control-fifo.ts）：
//   ① 正常收工、整组 SIGKILL（trap 跑不了）两种退出，根一走管子就没了；正常收工时别的进程还开着
//      它就留着
//   ② 根被单独杀掉、CLI 还攥着 stdin：管子留着；等它也走了才收得掉
//   ③ 判据本身：没人开着才删；有人开着（带读端 / **只写**）、组可写、不是 FIFO、不存在都不删
//   ④ 起跑前同一路径上已有一根：没人开着就收掉照常起；有人开着就不起、那根原样留着
//   ⑤ 启动那一扫（sweepRunLogs）：只收没人开着的，在跑的那根、只写开着的、还没结束的会话那根都留着
// POSIX 专属：Windows 上可引导回合走壳守着的具名管道，没有这根文件。
import "./isolated-data.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IS_WINDOWS } = await import("../src/platform.js");
if (IS_WINDOWS) {
  console.log("- 跳过：Windows 没有 stdin FIFO");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "ash-control-fifo-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1"; // 起的是本文件自己写的假 agent，验的就是进程收尾
const { detachedPathsFor, spawnControllableForRun } = await import("../src/executors/detached.js");
const { controlFifoPath, removeIdleControlFifo } = await import("../src/executors/control-fifo.js");
const mkfifo = (path: string) => assert.equal(spawnSync("mkfifo", [path]).status, 0, `fixture: mkfifo ${path}`);
const { ensureSchema, db } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { sweepRunLogs } = await import("../src/run-logs-gc.js");

const agentScript = join(root, "agent.mjs");
writeFileSync(agentScript, `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  process.stdout.write(JSON.stringify({ line }) + "\\n");
  if (line === "stop") process.exit(0);
});
setInterval(() => {}, 1000);
`);

const pids = new Set<number>();
const holders = new Set<ChildProcess>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await wait(25);
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function start(name: string) {
  const paths = detachedPathsFor(root, name, "T0");
  const child = spawnControllableForRun(root, process.execPath, [agentScript], "one\n", undefined, paths);
  assert.ok(child.pid, `${name}: 起得来`);
  pids.add(child.pid!);
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const fifo = controlFifoPath(paths.rc);
  return { child, paths, fifo, closed };
}

/** 一个跟本次运行无关、自己开着这根管子的进程（带读端，跟根 shell 的 `3<>` 一样）。 */
async function hold(path: string) {
  const ready = join(root, `held-${holders.size}`);
  const holder = spawn("/bin/sh", ["-c", 'exec 3<>"$1"; : >"$2"; exec sleep 60', "sh", path, ready], { stdio: "ignore" });
  holders.add(holder);
  await until(() => existsSync(ready), "持有者打开管子");
  return holder;
}

/** 只留一个**只写**描述符的持有者：读端全关了，「有没有读端」那一问答「没有」（审查第 1 轮 F1）。 */
async function holdWriteOnly(path: string) {
  const ready = join(root, `held-${holders.size}`);
  const holder = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const rw = fs.openSync(process.argv[1], "r+");
fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
fs.closeSync(rw);
fs.writeFileSync(process.argv[2], "");
setInterval(() => {}, 1000);`, path, ready], { stdio: "ignore" });
  holders.add(holder);
  await until(() => existsSync(ready), "只写持有者打开管子");
  return holder;
}

try {
  // ① 正常收工
  {
    const run = start("normal");
    assert.ok(existsSync(run.fifo), "在跑时管子在");
    run.child.stdin!.write("stop\n");
    await run.closed;
    await until(() => !existsSync(run.fifo), "正常收工后管子被收掉");
  }
  // ① 整组 SIGKILL：shell 的 trap 没机会跑，靠 server 这一侧收
  {
    const run = start("killed");
    await wait(200);
    process.kill(-run.child.pid!, "SIGKILL");
    await run.closed;
    await until(() => !existsSync(run.fifo), "整组被杀后管子被收掉");
  }
  // ① 正常收工，但另有进程开着它：不删（shell 那句无条件的 trap rm 已经拿掉）
  {
    const run = start("shared");
    const holder = await hold(run.fifo);
    run.child.stdin!.write("stop\n");
    await run.closed;
    await wait(1000);
    assert.ok(existsSync(run.fifo), "别的进程还开着：管子留着");
    holder.kill("SIGKILL");
    await until(() => holder.exitCode !== null || holder.signalCode !== null, "持有者退出");
    assert.equal(await removeIdleControlFifo(run.fifo), "removed");
  }
  console.log("✓ 根退出（正常收工 / 整组 SIGKILL）后 stdin 管道被收掉；还有别人开着就留着");

  // ② 只杀根：CLI 还开着 stdin，管子不能删
  {
    const run = start("orphan");
    await wait(200);
    const cli = spawnSync("pgrep", ["-P", String(run.child.pid)], { encoding: "utf8" }).stdout.trim().split("\n").map(Number).filter(Boolean);
    assert.equal(cli.length, 1, "fixture: 根下面恰好一个 CLI");
    process.kill(run.child.pid!, "SIGKILL");
    await run.closed;
    await wait(300);
    assert.ok(alive(cli[0]), "fixture: CLI 活过了根");
    assert.ok(existsSync(run.fifo), "CLI 还开着 stdin：管子留着");
    assert.equal(await removeIdleControlFifo(run.fifo), "busy");
    process.kill(cli[0], "SIGKILL");
    await until(() => !alive(cli[0]), "CLI 退出");
    assert.equal(await removeIdleControlFifo(run.fifo), "removed", "最后一个持有者走了才收得掉");
  }
  console.log("✓ 根走了但 CLI 还开着管子时不删，没人开着之后才删");

  // ③ 判据
  {
    const dir = join(root, "probe");
    mkdirSync(dir);
    const idle = join(dir, "idle.agent-rc.stdin.fifo");
    const held = join(dir, "held.agent-rc.stdin.fifo");
    const plain = join(dir, "plain.agent-rc.stdin.fifo");
    const writeOnly = join(dir, "write-only.agent-rc.stdin.fifo");
    const shared = join(dir, "group-writable.agent-rc.stdin.fifo");
    for (const path of [idle, held, writeOnly, shared]) mkfifo(path);
    chmodSync(shared, 0o660);
    writeFileSync(plain, "not a pipe");
    const holder = await hold(held);
    const writer = await holdWriteOnly(writeOnly);
    assert.equal(await removeIdleControlFifo(writeOnly), "busy", "只写开着也算有人开着");
    assert.ok(existsSync(writeOnly));
    assert.equal(writer.exitCode, null);
    writer.kill("SIGKILL");
    await until(() => writer.signalCode !== null, "只写持有者退出");
    assert.equal(await removeIdleControlFifo(writeOnly), "removed");
    assert.equal(await removeIdleControlFifo(shared), "unknown", "组/其他人可写：别的用户的只写持有者看不见，不删");
    assert.ok(existsSync(shared));
    assert.equal(await removeIdleControlFifo(idle), "removed");
    assert.equal(existsSync(idle), false);
    assert.equal(await removeIdleControlFifo(held), "busy");
    assert.equal(await removeIdleControlFifo(held), "busy", "探测本身不会给持有者送 EOF、也不留下打开着的一端");
    assert.equal(holder.exitCode, null, "持有者没受影响");
    assert.equal(await removeIdleControlFifo(plain), "unknown");
    assert.ok(existsSync(plain), "不是 FIFO 的同名文件不碰");
    assert.equal(await removeIdleControlFifo(join(dir, "missing.agent-rc.stdin.fifo")), "absent");
  }
  console.log("✓ 只删没人开着的 FIFO；有人开着（读写或只写）、组可写、不是 FIFO、不存在都不删");

  // ④ 起跑前同一路径上已有一根
  {
    const idlePaths = detachedPathsFor(root, "leftover-idle", "T0");
    mkfifo(controlFifoPath(idlePaths.rc));
    const run = start("leftover-idle");
    run.child.stdin!.write("stop\n");
    await run.closed;
    assert.match(readFileSync(run.paths.out, "utf8"), /"line":"one"/, "没人开着的旧管子收掉后照常起跑");

    const busyPaths = detachedPathsFor(root, "leftover-busy", "T0");
    const busyFifo = controlFifoPath(busyPaths.rc);
    mkfifo(busyFifo);
    const holder = await hold(busyFifo);
    const refused = spawnControllableForRun(root, process.execPath, [agentScript], "one\n", undefined, busyPaths);
    if (refused.pid) pids.add(refused.pid);
    assert.equal(refused.pid, undefined, "有人开着就不起");
    assert.ok(existsSync(busyFifo), "那根原样留着");
    assert.equal(holder.exitCode, null, "持有者没受影响");
  }
  console.log("✓ 起跑前路径上的旧管子：没人开着才收，有人开着就不起也不删");

  // ④ 启动那一扫
  {
    await ensureSchema();
    const runs = process.env.ASH_RUNS_DIR!;
    const taskDir = join(runs, "task-sweep");
    mkdirSync(taskDir, { recursive: true });
    const stale = join(taskDir, "old-20261027T085042545Z.agent-rc.stdin.fifo");
    const busy = join(taskDir, "busy-20261117T081902137Z.agent-rc.stdin.fifo");
    const liveRc = join(taskDir, "live-20261117T090000000Z.agent-rc");
    const liveFifo = controlFifoPath(liveRc);
    const writeOnly = join(taskDir, "writer-20261117T082017788Z.agent-rc.stdin.fifo");
    for (const path of [stale, busy, liveFifo, writeOnly]) mkfifo(path);
    await hold(busy);
    await holdWriteOnly(writeOnly);
    const now = new Date().toISOString();
    await db.insert(projects).values({ id: "p-sweep", name: "p", repoPath: root, createdAt: now } as never);
    await db.insert(tasks).values({
      id: "task-sweep", projectId: "p-sweep", title: "t", body: "", status: "running", mode: "single",
      agentType: "claude", labels: "[]", createdAt: now, updatedAt: now, autoTitle: 0, useWorktree: 0,
    } as never);
    await db.insert(sessions).values({
      id: "s-live", taskId: "task-sweep", role: "single", agentType: "claude", executor: "claude@local",
      cwd: root, commandLine: "fake", startedAt: now, turnStartedAt: now, activeMs: 0,
      agentPid: 999999, agentRcPath: liveRc,
    } as never);
    const swept = await sweepRunLogs();
    assert.equal(swept.fifos, 1);
    assert.equal(existsSync(stale), false, "没人开着的旧管子被收掉");
    assert.ok(existsSync(busy), "此刻有人开着的那根留着");
    assert.ok(existsSync(writeOnly), "只写开着的那根也留着");
    assert.ok(existsSync(liveFifo), "还没结束的会话那根留着");
  }
  console.log("✓ 启动那一扫只收没人开着的旧管子");
} finally {
  for (const holder of holders) holder.kill("SIGKILL");
  for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* 已退出 */ } }
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
