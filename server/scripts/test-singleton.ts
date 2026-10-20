// Single-instance startup guard regression test.
// Requires a built server because it validates the production entrypoint:
//   npm -w server run build && npm -w server run test:singleton
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { migrateLegacyDbFiles } from "../src/db/path.js";
import { killPidsCommand } from "../src/platform.js";
import { singletonLockFileForDb } from "../src/singleton.js";
import {
  exitLedgerFileForDb,
  findExitByRunId,
  readExitRecords,
  recordExit,
  rotateExitLedger,
  type ExitRecord,
} from "../src/exit-ledger.js";

// `new URL(..).pathname` 在 Windows 上给的是 `/D:/...`(带前导斜杠),`resolve` 会把它
// 拼成 `C:\D:\...` —— 于是每个 spawn 的 cwd 都不存在,报 `spawn node.exe ENOENT`。
// 这一行是基线既有的,后果是**这套用例在 Windows 上从来没跑起来过**;2026-10-20 上
// 真机验证 win32 分支时撞上,改成 fileURLToPath 才跑得动。
const serverRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const singletonUrl = pathToFileURL(join(serverRoot, "dist/singleton.js")).href;
const POSIX = process.platform !== "win32";

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
    await testHealthDoesNotLeakForeignCommandLine(root);
    testCorruptTailDoesNotSwallowNextRecord(root);
    testRotationNeverDropsRecords(root);
    await testRotationLeavesUnderBudgetLedgerAlone(root);
    if (POSIX) {
      // 这几条全是 POSIX 专用的:chmod 的权限位、SIGTERM/SIGHUP 的投递、SIGSTOP、
      // 128+signo 的退出码在 Windows 上都不等价(见 singleton.ts 的 EXIT_SIGNALS,
      // 那边压根不注册 SIGTERM)。门控必须按**依赖**划,不是按名字里有没有 signal
      // 划 —— 第 2 轮审查指出清理失败那条当时漏在门外。真机覆盖仍是缺口,如实跳过。
      await testCleanupFailureDoesNotClaimNormalStop(root);
      await testExitIntentDoesNotExcludeKill(root);
      testUnreadableTailDoesNotSwallowNextRecord(root);
      await testSignalExitIsRecorded(root, "SIGTERM", 143);
      await testSignalExitIsRecorded(root, "SIGHUP", 129);
    } else {
      console.log("[singleton-test] Windows:跳过 POSIX 专用用例(chmod 权限位、SIGTERM/SIGHUP/SIGSTOP 投递、128+signo 退出码)");
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
    assert.ok(
      output.includes(killPidsCommand([first.child.pid!])),
      `message should include a copyable kill command (${killPidsCommand([first.child.pid!])})`,
    );
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
    assert.match(output, /账本里\*\*没有\*\*它这一轮的任何记录/, "必须说清判据是账本里没有记录");
    assert.match(output, /最终死因未知/, "拿不准就只能说死因未知");
    assert.ok(output.includes(heartbeatAt), "要报出最后已知存活时刻");
    assert.doesNotMatch(output, /没走任何退出路径就消失/, "不许把「锁还在」说成「没走退出路径」");

    const residual = readLedger(db).filter((record) => record.kind === "residual");
    assert.equal(residual.length, 1, "应当只落一条 residual");
    assert.equal(residual[0]!.evidence, "none", "没有退出记录时证据等级必须是 none");
    assert.equal(residual[0]!.observedIntent, undefined, "没有记录就没有可报的意向");
    assert.equal(residual[0]!.lastHeartbeatAt, heartbeatAt, "落账要带上最后已知存活");

    const health = await healthOf(port);
    assert.equal(health.previousResidualLock?.pid, stalePid, "/api/health 要带上这件事,重启脚本靠它提示");
    assert.equal(health.previousResidualLock?.evidence, "none");
    console.log(`[singleton-test] 残留锁 + 无记录 → 证据 none、最终死因未知(PID ${stalePid})`);
  } finally {
    await server.stop();
  }
}

/**
 * 收到 SIGTERM + 删锁失败:要报出「留过退出意向」,但**既不能**说成强杀,**也不能**
 * 说成正常停。
 *
 * 复现手法同第 1 轮审查:数据目录改成只读(删文件要目录写权限,往已存在的账本文件
 * 追加不要),于是 SIGTERM 退出时 unlink 拿到 EACCES、锁留在原地。
 *
 * 第 2 轮审查打回的是这里的另一头:当时的断言要求输出「不是强杀」。那个结论站不住 ——
 * 同一个现场也可以是「记完账、释放锁的路上被 SIGKILL」(见
 * testExitIntentDoesNotExcludeKill)。所以这条用例现在钉的是「只报观察到的事实 +
 * 最终死因未知」,并且**反向断言**不许出现那两句定性。
 */
async function testCleanupFailureDoesNotClaimNormalStop(root: string) {
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
    assert.match(next.output(), /退出意向\(收到 SIGTERM/, "要报出观察到的那条意向");
    assert.match(next.output(), /清理没完成/, "锁还在 ⇒ 这一轮的清理确实没完成,这一句可以说");
    assert.match(next.output(), /最终死因未知/, "记录之后仍可能被强杀,死因只能说未知");
    assert.doesNotMatch(next.output(), /不是强杀/, "一条进程内的记录排除不了之后的强杀");
    assert.doesNotMatch(next.output(), /是正常停的/, "同理也不许说成正常停");
    const health = await healthOf(port);
    assert.equal(health.previousResidualLock?.evidence, "exit_intent");
    assert.equal(health.previousResidualLock?.observedIntent?.signal, "SIGTERM", "公开摘要要带上观察到的意向");
    console.log("[singleton-test] 收到 SIGTERM + 删锁失败 → 证据 exit_intent,没定性成正常停");
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
  recordExit({ at: new Date().toISOString(), pid: 222, kind: "residual", evidence: "none" }, db);
  const pids = readExitRecords(10, db).map((record) => record.pid);
  assert.deepEqual(pids, [111, 222], `坏尾行不能吞掉新记录;实际读出 ${JSON.stringify(pids)}`);
  console.log("[singleton-test] 坏尾行只丢自己,新记录照样读得出来");
}

/**
 * 账本**读不了、但写得进去**时,坏尾行同样不许吞掉新记录。
 *
 * 第 2 轮审查就是这么复现的:旧实现靠「先读一次尾巴、缺换行就补」,而读失败被当成
 * 「不需要补」—— 把账本设成 0200 之后,追加成功、新记录却和坏尾行粘成一行。所以
 * 不变量必须落在**帧格式**上(每条追加自带前后边界),不是落在「先读成功」上。
 *
 * 三种 kind 走的是同一个 recordExit,这里全测一遍:审查的版本里它们是一起坏的。
 */
function testUnreadableTailDoesNotSwallowNextRecord(root: string) {
  for (const kind of ["signal", "exit", "residual"] as const) {
    const db = join(root, `unreadable-tail-${kind}.db`);
    const ledger = exitLedgerFileForDb(db);
    writeFileSync(ledger, `${JSON.stringify({ at: "2026-10-19T00:00:00.000Z", pid: 111, kind: "exit" })}\n{"at":"unfinished`);
    chmodSync(ledger, 0o200);
    try {
      recordExit({ at: new Date().toISOString(), pid: 222, kind, signal: kind === "signal" ? "SIGTERM" : undefined }, db);
    } finally {
      chmodSync(ledger, 0o600);
    }
    const pids = readExitRecords(10, db).map((record) => record.pid);
    assert.deepEqual(pids, [111, 222], `${kind}:可写不可读时也不许吞掉新记录;实际读出 ${JSON.stringify(pids)}`);
  }
  console.log("[singleton-test] 账本可写不可读时,三种记录的边界都还在");
}

/**
 * 裁剪**一条已经落盘的记录都不许删**,无论它是在改名前还是改名后追加的。
 *
 * 第 2 轮审查用真实生产入口复现过旧实现的丢失:启动失败那条路先松锁、退出记录后到
 * (`index.ts` 的 `exitAfterStartupFailure` → `process.exit(1)` → exit 钩子),新实例
 * 此刻已经读好了裁剪快照,一 rename 就把那条记录盖掉 —— 206 条变 200 条。
 *
 * 现在裁剪只改名、不产生内容,所以这条不变量跟「谁持着锁」无关。两种交错各测一次。
 */
function testRotationNeverDropsRecords(root: string) {
  const db = join(root, "rotate-race.db");
  const ledger = exitLedgerFileForDb(db);
  const history = Array.from({ length: 205 }, (_, i) => ({
    at: "2026-10-19T00:00:00.000Z", pid: 100_000 + i, kind: "exit" as const, code: 0,
  }));
  writeFileSync(ledger, `${history.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });

  // 交错一:追加先落在改名前的 inode 上(就是审查复现的那一种)。
  recordExit({ at: new Date().toISOString(), pid: 4242, runId: "late-run", kind: "exit", code: 1 }, db);
  const beforeRotate = readFileSync(ledger, "utf8");
  rotateExitLedger(db);
  assert.equal(readFileSync(`${ledger}.1`, "utf8"), beforeRotate, "裁剪只许改名:上一代内容必须逐字节原样");
  assert.equal(findExitByRunId("late-run", db)?.pid, 4242, "迟到的退出记录不许被裁剪吞掉");
  assert.equal(readExitRecords(1000, db).length, 206, "一条都不该少");

  // 交错二:追加落在改名之后的新文件上,读的一侧要横跨两代。
  recordExit({ at: new Date().toISOString(), pid: 4343, runId: "later-run", kind: "exit", code: 0 }, db);
  assert.equal(findExitByRunId("later-run", db)?.pid, 4343, "改名之后的追加也要找得到");
  const pids = readExitRecords(1000, db).map((record) => record.pid);
  assert.ok(pids.includes(4242) && pids.includes(4343), "两代都要读得到");
  console.log("[singleton-test] 裁剪只改名:两种交错下迟到的退出记录都没丢");
}

/**
 * 没超水位时,启动一个字都不该动账本。
 *
 * 原来每次取锁都整文件重写(`writeFileSync` 先截断),等于把刚写进去的关键记录反复
 * 放进一个可能失败的写入里 —— 第 1 轮审查实测在文件大小限制下历史被截成 0 字节。
 */
async function testRotationLeavesUnderBudgetLedgerAlone(root: string) {
  const db = join(root, "rotate-noop.db");
  const ledger = exitLedgerFileForDb(db);
  const seeded = `${JSON.stringify({ at: "2026-10-18T00:00:00.000Z", pid: 7, kind: "exit" })}\n`;
  writeFileSync(ledger, seeded, { mode: 0o600 });
  const server = await startServer(await freePort(), db);
  try {
    assert.equal(readFileSync(ledger, "utf8"), seeded, "没超水位时启动不该改写账本");
    assert.equal(existsSync(`${ledger}.1`), false, "也不该无故轮转出上一代");
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

/**
 * 「留下了退出意向、却仍然被强杀」—— 这个现场**不许**被说成正常停。
 *
 * 第 2 轮审查的复现:SIGTERM 处理器已经把 signal 记录写进账本,进程在 `lock.release()`
 * 的路上被 SIGKILL 带走。操作系统侧的终态是 SIGKILL,账本侧的意向是 SIGTERM,现场跟
 * 「删锁失败」完全一样 —— 所以任何「有记录 ⇒ 不是强杀」的推断都是假的。
 *
 * 手法同审查:猴补 `lock.release` 在入口处 SIGSTOP 自己,把本来就存在的抢占窗口撑开,
 * 父进程再发 SIGKILL。生产代码没有为测试改过一行。
 */
async function testExitIntentDoesNotExcludeKill(root: string) {
  const db = join(root, "intent-then-kill.db");
  const victim = spawnModule(db, `
    import { acquireDbSingletonLock } from ${JSON.stringify(singletonUrl)};
    const lock = acquireDbSingletonLock();
    const release = lock.release;
    lock.release = () => { console.log("BEFORE_RELEASE"); process.kill(process.pid, "SIGSTOP"); return release(); };
    console.log("READY");
    setInterval(() => {}, 1000);
  `);
  await waitForOutput(victim, /READY/);
  victim.child.kill("SIGTERM");
  await waitForOutput(victim, /BEFORE_RELEASE/);
  const intent = readLedger(db).find((record) => record.kind === "signal");
  assert.equal(intent?.signal, "SIGTERM", "退出意向应当已经落账");
  assert.equal(existsSync(singletonLockFileForDb(db)), true, "锁还没来得及删");
  victim.child.kill("SIGKILL");
  const exit = await waitForExit(victim.child);
  assert.equal(exit.signal, "SIGKILL", "这一轮的真实终态就是强杀");

  const next = spawnModule(db, `
    import { acquireDbSingletonLock, previousResidualLockPublic } from ${JSON.stringify(singletonUrl)};
    acquireDbSingletonLock();
    console.log("SUMMARY=" + JSON.stringify(previousResidualLockPublic()));
    process.exit(0);
  `);
  const nextExit = await waitForExit(next.child);
  assert.equal(nextExit.code, 0, next.output());
  assert.doesNotMatch(next.output(), /不是强杀/, "实际就是被强杀的,不许声称排除");
  assert.doesNotMatch(next.output(), /是正常停的/, "更不许说成正常停");
  assert.match(next.output(), /最终死因未知/, "只能说死因未知");
  const summary = JSON.parse(/SUMMARY=(.*)/.exec(next.output())![1]!) as ExitRecord;
  assert.equal(summary.evidence, "exit_intent", "能报的只是「留过退出意向」");
  assert.equal(summary.observedIntent?.signal, "SIGTERM");
  console.log("[singleton-test] 留过退出意向 + 真被强杀 → 只报意向,没有定性成正常停");
}

/** 跑一小段 ESM,直接用构建产物里的 singleton(不起 HTTP 服务,只要锁和账本)。 */
function spawnModule(db: string, source: string): StartedServer {
  const chunks: string[] = [];
  const env = { ...process.env, ASH_DB: db, ASH_ALLOW_MULTI: "" };
  delete env.HARNESS_DB;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
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
      child.kill("SIGKILL");
      await waitForExit(child);
    },
  };
}

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

/** 两代账本都读(裁剪会把当前那份改名成 `.1`),故意不复用生产实现。 */
function readLedger(db: string): ExitRecord[] {
  const file = exitLedgerFileForDb(db);
  return [`${file}.1`, file].flatMap((path) => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ExitRecord);
  });
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
