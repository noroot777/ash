// Single-instance startup guard regression test.
// Requires a built server because it validates the production entrypoint:
//   npm -w server run build && npm -w server run test:singleton
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { migrateLegacyDbFiles } from "../src/db/path.js";
import { singletonLockFileForDb } from "../src/singleton.js";
import { exitLedgerFileForDb, type ExitRecord } from "../src/exit-ledger.js";

const serverRoot = resolve(new URL("..", import.meta.url).pathname);

type StartedServer = {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  stop: () => Promise<void>;
};

async function main() {
  const root = mkdtempSync(join(tmpdir(), "ash-singleton-"));
  console.log(`[singleton-test] temp root: ${root}`);

  try {
    await testSameDbRejected(root);
    await testDifferentDbsAllowed(root);
    await testStaleLockOverwritten(root);
    await testVanishedPreviousReported(root);
    await testSignalExitIsRecorded(root, "SIGTERM", 143);
    await testSignalExitIsRecorded(root, "SIGHUP", 129);
    await testLegacyEnvAllowed(root);
    testLegacyDbMigration(root);
    console.log("[singleton-test] all checks passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testLegacyEnvAllowed(root: string) {
  const db = join(root, "legacy-env.db");
  const server = await startServer(await freePort(), db, /server on/, "HARNESS_DB");
  try {
    assert.ok(server.child.pid, "旧环境变量仍应能启动升级后的服务");
  } finally {
    await server.stop();
  }
}

function testLegacyDbMigration(root: string) {
  const legacy = join(root, "harness.db");
  const current = join(root, "ash.db");
  for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${legacy}${suffix}`, suffix || "db");
  migrateLegacyDbFiles(current, legacy);
  for (const suffix of ["", "-wal", "-shm"]) {
    assert.equal(existsSync(`${legacy}${suffix}`), false, `旧数据库${suffix}应已迁走`);
    assert.equal(existsSync(`${current}${suffix}`), true, `新数据库${suffix}应已就位`);
  }
}

async function testSameDbRejected(root: string) {
  const db = join(root, "same.db");
  const firstPort = await freePort();
  const secondPort = await freePort();
  const first = await startServer(firstPort, db);
  const second = spawnServer(secondPort, db);
  try {
    const exit = await waitForExit(second.child);
    const output = second.output();
    assert.equal(exit.code, 1, "second same-DB server should exit 1");
    assert.match(output, /Refusing to start/, "same-DB rejection should be explicit");
    assert.match(output, new RegExp(`PID: ${first.child.pid}`), "message should include conflicting PID");
    assert.match(output, new RegExp(`kill ${first.child.pid}`), "message should include a copyable kill command");
    console.log(`[singleton-test] same DB rejected with exit ${exit.code}`);
    console.log(indentBlock(output.trim()));
  } finally {
    await second.stop();
    await first.stop();
  }
}

async function testDifferentDbsAllowed(root: string) {
  const first = await startServer(await freePort(), join(root, "one.db"));
  const second = await startServer(await freePort(), join(root, "two.db"));
  try {
    assert.ok(first.child.pid);
    assert.ok(second.child.pid);
    console.log("[singleton-test] different DB instances ran concurrently");
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
}

async function testStaleLockOverwritten(root: string) {
  const db = join(root, "stale.db");
  const stalePid = findDeadPid();
  // 不带心跳 = 旧版本写下的锁。那种情况下只能说「给不出死亡时刻」,不能假装知道。
  writeStaleLock(db, stalePid);

  const server = spawnServer(await freePort(), db);
  try {
    await waitForOutput(server, /stale singleton lock/);
    await waitForOutput(server, /server on/);
    assert.match(server.output(), /stale singleton lock/, "stale lock should be reported");
    assert.match(server.output(), /给不出死亡时刻/, "没有心跳时不能编一个死亡时刻出来");
    console.log(`[singleton-test] stale lock for dead PID ${stalePid} was overwritten`);
    console.log(indentBlock(server.output().split("\n").find((line) => line.includes("stale singleton lock")) ?? ""));
  } finally {
    await server.stop();
  }
}

/**
 * 上一实例**没走任何退出路径**就消失时,下一次启动必须把这件事说清楚并落账。
 *
 * 这是 2026-10-19「ash 服务又停了」唯一能拿到的证据:锁还在 = 既不是优雅退出、也不是
 * SIGTERM(`npm run restart` 走的那条),只能是 SIGKILL 一类抓不住的方式。锁文件里的
 * 心跳给出死亡时刻 —— 在此之前只能靠 mDNSResponder 的系统日志反推。
 */
async function testVanishedPreviousReported(root: string) {
  const db = join(root, "vanished.db");
  const stalePid = findDeadPid();
  const heartbeatAtMs = Date.now() - 90_000;
  const heartbeatAt = new Date(heartbeatAtMs).toISOString();
  writeStaleLock(db, stalePid, {
    processStartedAtMs: heartbeatAtMs - 3_600_000,
    heartbeatAt,
    heartbeatAtMs,
  });

  const port = await freePort();
  const server = spawnServer(port, db);
  try {
    await waitForOutput(server, /server on/);
    const output = server.output();
    assert.match(output, /没走任何退出路径就消失了/, "必须明说上一实例是非正常消失的");
    assert.ok(output.includes(heartbeatAt), "必须报出最后心跳时刻(死亡时刻的上界)");
    assert.match(output, /SIGKILL/, "必须给出「被什么带走的」这个结论");

    const records = readLedger(db);
    const vanished = records.filter((record) => record.kind === "vanished");
    assert.equal(vanished.length, 1, "应当只落一条 vanished");
    assert.equal(vanished[0]!.pid, stalePid, "落账的 pid 要是上一实例的");
    assert.equal(vanished[0]!.lastHeartbeatAt, heartbeatAt, "落账要带上最后心跳");
    assert.ok((vanished[0]!.silentMs ?? 0) >= 60_000, "静默时长要算出来");

    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as
      { previousAbnormalExit?: ExitRecord | null };
    assert.equal(health.previousAbnormalExit?.pid, stalePid, "/api/health 要带上取证结论,重启脚本靠它提示");
    console.log(`[singleton-test] 上一实例(PID ${stalePid})的非正常消失已报出并落账`);
  } finally {
    await server.stop();
  }
}

/**
 * 每个可捕获的致命信号都要:释放锁、在日志里留一行、落一条账。
 *
 * SIGHUP 是这里的重点 —— 它以前**没有处理器**,默认动作是静默终止:不打印、不写崩溃
 * 报告、锁留在原地,跟被 SIGKILL 带走完全分不开。能分辨的死因越多,下次要猜的越少。
 */
async function testSignalExitIsRecorded(root: string, signal: NodeJS.Signals, expectedCode: number) {
  const db = join(root, `signal-${signal}.db`);
  const server = await startServer(await freePort(), db);
  const lockFile = singletonLockFileForDb(db);
  assert.equal(existsSync(lockFile), true, "跑起来之后锁应该在");

  server.child.kill(signal);
  const exit = await waitForExit(server.child);
  assert.equal(exit.code, expectedCode, `${signal} 的退出码应为 ${expectedCode}`);
  assert.equal(existsSync(lockFile), false, `${signal} 退出必须把单例锁删掉`);
  assert.match(server.output(), new RegExp(`收到 ${signal}`), `${signal} 退出必须在日志里留一行`);

  const recorded = readLedger(db).filter((record) => record.kind === "signal" && record.signal === signal);
  assert.equal(recorded.length, 1, `${signal} 应当落一条账(且只有一条,exit 路径不再重复记)`);
  console.log(`[singleton-test] ${signal} → exit ${exit.code}、锁已释放、账本已记`);
}

function writeStaleLock(db: string, pid: number, extra: Record<string, unknown> = {}) {
  writeFileSync(
    singletonLockFileForDb(db),
    JSON.stringify({
      version: 1,
      pid,
      processStartedAt: "2000-01-01T00:00:00.000Z",
      processStartedAtMs: 946684800000,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      port: 49999,
      dbFile: db,
      cwd: serverRoot,
      argv: ["node", "dist/index.js"],
      token: "stale-test-lock",
      ...extra,
    }, null, 2) + "\n",
  );
}

function readLedger(db: string): ExitRecord[] {
  const file = exitLedgerFileForDb(db);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExitRecord);
}

function spawnServer(port: number, db: string, dbEnv = "ASH_DB"): StartedServer {
  const chunks: string[] = [];
  const env = { ...process.env, PORT: String(port), ASH_ALLOW_MULTI: "" };
  delete env.ASH_DB;
  delete env.HARNESS_DB;
  env[dbEnv] = db;
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: serverRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => chunks.push(String(d)));
  child.stderr.on("data", (d) => chunks.push(String(d)));
  return {
    child,
    output: () => chunks.join(""),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await waitForExit(child);
    },
  };
}

async function startServer(port: number, db: string, ready = /server on/, dbEnv = "ASH_DB") {
  const server = spawnServer(port, db, dbEnv);
  await waitForOutput(server, ready);
  return server;
}

async function waitForOutput(server: StartedServer, pattern: RegExp) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (pattern.test(server.output())) return;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`server exited before ready; output:\n${server.output()}`);
    }
    await delay(50);
  }
  await server.stop();
  throw new Error(`timed out waiting for ${pattern}; output:\n${server.output()}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: child.exitCode, signal: child.signalCode });
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function freePort() {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      const port = address!.port;
      server.close(() => resolvePromise(port));
    });
  });
}

function findDeadPid() {
  for (let pid = 999_999; pid > 900_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error("could not find a dead PID for stale lock test");
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function indentBlock(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => `  ${line}`)
    .join("\n");
}

await main();
