// Single-instance startup guard regression test.
// Requires a built server because it validates the production entrypoint:
//   npm -w server run build && npm -w server run test:singleton
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { migrateLegacyDbFiles } from "../src/db/path.js";
import { singletonLockFileForDb } from "../src/singleton.js";
import { exitLedgerFileForDb, readExitRecords, recordExit, type ExitRecord } from "../src/exit-ledger.js";

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
    await testResidualWithoutExitRecord(root);
    await testCleanupFailureIsNotReportedAsKill(root);
    await testHealthDoesNotLeakForeignCommandLine(root);
    testCorruptTailDoesNotSwallowNextRecord(root);
    await testTrimLeavesUnderBudgetLedgerAlone(root);
    if (process.platform === "win32") {
      // Windows 分支压根不注册 SIGTERM(见 singleton.ts 的 EXIT_SIGNALS),拿 POSIX 的
      // 143/129 去断言它只会测出一个假结论。真机覆盖仍是缺口,如实跳过而不是假装通过。
      console.log("[singleton-test] Windows:跳过 POSIX 信号用例(SIGTERM/SIGHUP 在该平台不投递)");
    } else {
      await testSignalExitIsRecorded(root, "SIGTERM", 143);
      await testSignalExitIsRecorded(root, "SIGHUP", 129);
    }
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
    assert.match(server.output(), /连最后存活时刻都给不出/, "没有心跳时不能编一个存活时刻出来");
    console.log(`[singleton-test] stale lock for dead PID ${stalePid} was overwritten`);
    console.log(indentBlock(server.output().split("\n").find((line) => line.includes("stale singleton lock")) ?? ""));
  } finally {
    await server.stop();
  }
}

/**
 * 发现残留锁、而账本里**没有**那一轮的退出记录:只能报「死因未知」。
 *
 * 第 1 轮审查打回的正是旧版本在这里的过度断言 —— 它直接写成「被 SIGKILL 带走」。
 * 锁留在原地有别的来由(删锁失败、旧版本没有 HUP/QUIT 处理器),所以这一档只许说
 * 「没有已确认的退出记录」。
 */
async function testResidualWithoutExitRecord(root: string) {
  const db = join(root, "residual.db");
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
    assert.match(output, /账本里\*\*没有\*\*它这一轮的退出记录/, "必须说清判据是账本里没有记录");
    assert.match(output, /死因未知/, "拿不准就只能说死因未知");
    assert.ok(output.includes(heartbeatAt), "要报出最后已知存活时刻");
    assert.doesNotMatch(output, /没走任何退出路径就消失/, "不许把「锁还在」说成「没走退出路径」");

    const residual = readLedger(db).filter((record) => record.kind === "residual");
    assert.equal(residual.length, 1, "应当只落一条 residual");
    assert.equal(residual[0]!.diagnosis, "unknown", "没有退出记录时死因必须是 unknown");
    assert.equal(residual[0]!.lastHeartbeatAt, heartbeatAt, "落账要带上最后已知存活");

    const health = await healthOf(port);
    assert.equal(health.previousResidualLock?.pid, stalePid, "/api/health 要带上这件事,重启脚本靠它提示");
    assert.equal(health.previousResidualLock?.diagnosis, "unknown");
    console.log(`[singleton-test] 残留锁 + 无退出记录 → 死因未知(PID ${stalePid})`);
  } finally {
    await server.stop();
  }
}

/**
 * 正常停止 + 删锁失败,**不能**被下一个实例报成强杀。
 *
 * 复现手法同第 1 轮审查:数据目录改成只读(删文件要目录写权限,往已存在的账本文件
 * 追加不要),于是 SIGTERM 退出时 unlink 拿到 EACCES、锁留在原地。此时账本里有这一轮
 * 的 signal 记录,下一个实例必须据此判成「退出已记录、清理失败」。
 */
async function testCleanupFailureIsNotReportedAsKill(root: string) {
  const dir = join(root, "cleanup-fail");
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "ash.db");
  const server = await startServer(await freePort(), db);
  // 先把账本文件建出来:目录只读之后仍然可以往已存在的文件里追加。
  writeFileSync(exitLedgerFileForDb(db), "", { mode: 0o600 });
  try {
    chmodSync(dir, 0o500);
    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child);
    assert.equal(exit.code, 143, "SIGTERM 仍应正常收场");
    assert.match(server.output(), /单例锁删除失败/, "删锁失败要如实说,不能照说「已释放」");
    assert.doesNotMatch(server.output(), /单例锁已释放/, "没删掉就不许说已释放");
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(existsSync(singletonLockFileForDb(db)), true, "删不掉,锁应该还在原地");
  const signalRecord = readLedger(db).find((record) => record.kind === "signal");
  assert.equal(signalRecord?.signal, "SIGTERM", "退出记录要落下来");
  assert.ok(signalRecord?.runId, "退出记录必须带 runId —— 残留锁的定性全靠它");

  const port = await freePort();
  const next = spawnServer(port, db);
  try {
    await waitForOutput(next, /server on/);
    assert.match(next.output(), /没能把锁删掉/, "要指出这是清理失败");
    assert.match(next.output(), /不是强杀/, "必须明确排除强杀");
    assert.doesNotMatch(next.output(), /SIGKILL/, "正常停 + 清理失败不得提 SIGKILL");
    const health = await healthOf(port);
    assert.equal(health.previousResidualLock?.diagnosis, "cleanup_failed");
    console.log("[singleton-test] 正常停 + 删锁失败 → 判为 cleanup_failed,没报成强杀");
  } finally {
    await next.stop();
  }
}

/**
 * 免登录的 /api/health 不得泄露别的进程的命令行。
 *
 * 触发条件是残留锁里的 PID 已被别的程序复用:`staleLockReason` 会把 `ps` 读到的整段
 * 命令写进诊断原文,而那里面可能带密钥。第 1 轮审查实测过未登录请求能读到它。
 * 哨兵进程的参数里放的是**假**密钥。
 */
async function testHealthDoesNotLeakForeignCommandLine(root: string) {
  const db = join(root, "leak.db");
  const sentinel = "SINGLETON_TEST_FAKE_SECRET_d41d8c";
  const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--fake-key=${sentinel}`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await delay(300);
    assert.ok(decoy.pid, "哨兵进程应当起来了");
    // 不写 heartbeat:这一支要走的是「PID 活着但不是 ash」那条陈旧判据。
    writeStaleLock(db, decoy.pid!, { processStartedAtMs: Date.now() - 3_600_000 });

    const port = await freePort();
    const server = spawnServer(port, db);
    try {
      await waitForOutput(server, /server on/);
      const ledgerText = readFileSync(exitLedgerFileForDb(db), "utf8");
      assert.ok(ledgerText.includes(sentinel), "本地 0600 账本里该留着完整诊断原文,否则没法查");

      const raw = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.text());
      assert.ok(!raw.includes(sentinel), `公开 health 不得带上别的进程的命令行;实际响应:${raw}`);
      const health = JSON.parse(raw) as HealthBody;
      assert.ok(health.previousResidualLock, "该带的诊断摘要还是要带");
      assert.equal("note" in (health.previousResidualLock as object), false, "note 属于内部字段,不进公开响应");
      console.log("[singleton-test] 公开 health 只给白名单字段,未泄露哨兵进程的命令行");
    } finally {
      await server.stop();
    }
  } finally {
    decoy.kill("SIGKILL");
  }
}

/**
 * 上一次写到半行上,不能把下一条完整记录一起吞掉。
 *
 * 实测过的故障:坏尾行后面直接接新 JSON,两段粘成一行,解析时两条一起丢。
 */
function testCorruptTailDoesNotSwallowNextRecord(root: string) {
  const db = join(root, "corrupt-tail.db");
  const ledger = exitLedgerFileForDb(db);
  const good = { at: "2026-10-19T00:00:00.000Z", pid: 111, kind: "exit" as const };
  writeFileSync(ledger, `${JSON.stringify(good)}\n{"at":"unfinished`);
  recordExit({ at: new Date().toISOString(), pid: 222, kind: "residual", diagnosis: "unknown" }, db);
  const pids = readExitRecords(10, db).map((record) => record.pid);
  assert.deepEqual(pids, [111, 222], `坏尾行不能吞掉新记录;实际读出 ${JSON.stringify(pids)}`);
  console.log("[singleton-test] 坏尾行只丢自己,新记录照样读得出来");
}

/**
 * 没超水位时,裁剪一个字都不该动账本。
 *
 * 原来每次取锁都整文件重写(`writeFileSync` 先截断),等于把刚写进去的关键记录反复
 * 放进一个可能失败的写入里 —— 实测在文件大小限制下历史被截成 0 字节。
 */
async function testTrimLeavesUnderBudgetLedgerAlone(root: string) {
  const db = join(root, "trim-noop.db");
  const ledger = exitLedgerFileForDb(db);
  const seeded = `${JSON.stringify({ at: "2026-10-18T00:00:00.000Z", pid: 7, kind: "exit" })}\n`;
  writeFileSync(ledger, seeded, { mode: 0o600 });
  const server = await startServer(await freePort(), db);
  try {
    assert.equal(readFileSync(ledger, "utf8"), seeded, "没超水位时启动不该改写账本");
    console.log("[singleton-test] 未超水位,启动时账本保持原样");
  } finally {
    await server.stop();
  }
}

/**
 * 每个可捕获的致命信号都要:落账、释放锁、在日志里留一行。
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
  assert.match(server.output(), /单例锁已释放/, "删成功了就该这么说");

  const recorded = readLedger(db).filter((record) => record.kind === "signal" && record.signal === signal);
  assert.equal(recorded.length, 1, `${signal} 应当落一条账(且只有一条,exit 路径不再重复记)`);
  assert.ok(recorded[0]!.runId, "退出记录要带 runId");
  console.log(`[singleton-test] ${signal} → exit ${exit.code}、锁已释放、账本已记`);
}

type HealthBody = {
  pid?: number;
  previousResidualLock?: (Omit<ExitRecord, "note" | "runId"> & { note?: never }) | null;
};

async function healthOf(port: number): Promise<HealthBody> {
  return await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()) as HealthBody;
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
