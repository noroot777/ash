// 升级里三块不用起整套假安装就能钉住的地方(审查第 2、3 轮 R1–R3 那几类问题):
//   · 留底:库交给 SQLite 做一致快照 —— 库是软链、-wal 在它指着的那份旁边时,-wal 里已提交的那些也在备份里;
//   · 核对「升级前」那份先认人:不在、被换过、没记指纹都是没核对成,而且不会替它建一份空库;
//   · 升级锁:谁都不删别人的登记 —— 有活着的别人就退下(两个同时到的都退下),死掉的不算数,读不懂的按活着算;
//   · 数据锁按库文件的真实落点上:两份安装经各自的软链指着同一份库,也是同一把锁;
//   · 退回命令里的 `stop.mjs --pid --born`:等那个服务进程真的退出才算完(它收到信号还要忙一阵也等);出生时刻对不上、
//     只是参数里含着入口路径、已经在端口上应答的,一律不动。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, sleep } from "./platform.mjs";
import { selfStartedAtMs } from "./relocate-checkout-lock.mjs";
import { backupDb, backupSources, fileDigest, readIds, verifyData } from "./upgrade-data.mjs";
import { processBirth } from "./process-birth.mjs";
import { acquireUpgradeLock, dataLockDirs } from "./upgrade-lock.mjs";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "navi-upgrade-units-"));

/** 一份 WAL 库:before 已经合回主库,in-wal 只在 -wal 里(写的进程被 SIGKILL,没机会合并)—— 异常退出后的合法停机形态。 */
function walDb(file) {
  const code = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(file)});
db.exec("pragma journal_mode=wal; pragma wal_autocheckpoint=0; create table projects(id text); create table tasks(id text primary key); create table sessions(id text);"
  + "insert into tasks values('before'); pragma wal_checkpoint(truncate); insert into tasks values('in-wal');");
process.kill(process.pid, "SIGKILL");`;
  spawnSync(process.execPath, ["-e", code]);
}

try {
  // ── 留底 ────────────────────────────────────────────────────────────────────────
  {
    const real = join(dir, "elsewhere", "real.sqlite");
    mkdirSync(join(dir, "elsewhere"));
    walDb(real);
    assert.ok(existsSync(`${real}-wal`), "造不出带 -wal 的库,这一格没法测");
    let linked = true;
    try { symlinkSync(real, join(dir, "custom.sqlite")); } catch { linked = false; }
    const db = linked ? join(dir, "custom.sqlite") : real;
    writeFileSync(`${db}.identity.json`, "{\"id\":\"me\"}");
    const b = await backupDb({ backupRoot: dir, db, explicit: true, stamp: "t" });
    const name = linked ? "custom.sqlite" : "real.sqlite";
    assert.deepEqual(b.files.sort(), [name, `${name}.identity.json`].sort(), "库的 -wal / -shm 不另拷(快照里有了),身份文件照拷");
    assert.deepEqual(readIds(join(b.dir, name)).tasks.sort(), ["before", "in-wal"], "只在 -wal 里的那条没进备份");
    assert.deepEqual(readdirSync(b.dir).sort(), [name, `${name}.identity.json`].sort(), "快照自己就是完整的一份,只读打开也不该多出 -wal");
    assert.equal(b.baseline.file, join(b.dir, name));
    assert.equal(b.baseline.digest, fileDigest(b.baseline.file));
    assert.ok(existsSync(`${real}-wal`), "留底这一步不该替源库合并日志");
    console.log(linked ? "✓ 库是软链、-wal 在它指着的那份旁边:快照照样带上 -wal 里已提交的那条" : "⚠ 建不了软链,只测了普通 WAL 库的快照");

    // ── 核对认人 ──────────────────────────────────────────────────────────────────
    const live = join(dir, "live.sqlite");
    copyFileSync(b.baseline.file, live);
    assert.equal(verifyData(b.baseline, live).state, "ok");
    const gone = { file: join(b.dir, "nope.sqlite"), digest: b.baseline.digest };
    const v1 = verifyData(gone, live);
    assert.equal(v1.state, "unverified", v1.line);
    assert.ok(!existsSync(gone.file), "核对替不存在的备份建了一份空库");
    assert.equal(verifyData({ file: b.baseline.file, digest: "0".repeat(64) }, live).state, "unverified", "指纹对不上还拿它当基线");
    assert.equal(verifyData({ file: b.baseline.file, digest: null }, live).state, "unverified", "没记指纹还拿它当基线");
    writeFileSync(join(dir, "empty.sqlite"), "");
    assert.equal(verifyData({ file: join(dir, "empty.sqlite"), digest: fileDigest(join(dir, "empty.sqlite")) }, live).state, "unverified", "空文件当了基线");
    assert.equal(verifyData(b.baseline, live).state, "ok", "核对把备份改了(指纹变了)");
    console.log("✓ 核对先认人:不在、空的、被换过、没记指纹都是没核对成,不会替它建空库;核对本身不改备份");

    if (linked) {
      rmSync(real);
      assert.equal(backupSources({ backupRoot: dir, db, explicit: true }).problems.length, 1, "悬空的软链没拦下");
      await assert.rejects(backupDb({ backupRoot: dir, db, explicit: true, stamp: "u" }), /软链指着的东西不在了/);
      console.log("✓ 软链悬空在停服务之前拦下");
    }
  }

  // ── 升级锁 ──────────────────────────────────────────────────────────────────────
  {
    const lockDir = join(dir, "locks");
    const entry = (pid, extra = {}) => JSON.stringify({ pid, startedAtMs: pid === process.pid ? selfStartedAtMs() : undefined, startedAt: "刚才", note: "升级", ...extra });
    const a = acquireUpgradeLock([lockDir], { note: "升级" });
    assert.ok(a.ok, a.why);
    // 第二个进程来拿:看见活着的那份就退下,自己那份撤干净。
    /** 另起一个进程来拿(token 给了就是同一次操作的下一段),交回它拿锁的结果和那一刻锁目录里有几份登记。 */
    const other = (token) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { readdirSync } from "node:fs";
import { acquireUpgradeLock } from ${JSON.stringify(new URL("./upgrade-lock.mjs", import.meta.url).href)};
const r = acquireUpgradeLock([${JSON.stringify(lockDir)}], { note: "restart", token: ${JSON.stringify(token)} });
if (r.ok) process.on("exit", r.release);
console.log(JSON.stringify({ ...r, held: readdirSync(${JSON.stringify(lockDir)}).length }));`], { encoding: "utf8" }).stdout);
    const second = other(null);
    assert.equal(second.ok, false);
    assert.match(second.why, /正被另一次 升级 占着\(pid \d+/);
    assert.equal(readdirSync(lockDir).length, 1, "没拿到的那个没把自己的登记撤掉");
    // 同一次操作的下一段(另一个进程、同一个 token)不跟自己冲突;它退出时撤掉自己那份。
    const handoff = other(a.token);
    assert.ok(handoff.ok, handoff.why);
    assert.equal(handoff.held, 2, "下一段没放下自己的登记");
    a.release();
    assert.deepEqual(readdirSync(lockDir), [], "放锁没撤干净");

    // 两个同时到:各自放下登记之后都看得见对方 ⇒ 都退下(只会都没拿到,不会都拿到)。
    writeFileSync(join(lockDir, `aaaa.${process.pid}.json`), entry(process.pid));
    const both = acquireUpgradeLock([lockDir], { note: "升级" });
    assert.equal(both.ok, false, "看见别人活着的登记还拿到了锁");
    assert.deepEqual(readdirSync(lockDir), [`aaaa.${process.pid}.json`], "退下时动了别人的登记");
    rmSync(join(lockDir, `aaaa.${process.pid}.json`));

    // 主人死了的登记不算数(顺手清掉);读不懂的按活着算,不删、交给人。
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(lockDir, `bbbb.${dead}.json`), entry(Number(dead)));
    const c = acquireUpgradeLock([lockDir], { note: "升级" });
    assert.ok(c.ok, c.why);
    assert.ok(!existsSync(join(lockDir, `bbbb.${dead}.json`)), "死掉的登记没清掉");
    c.release();
    writeFileSync(join(lockDir, "cccc.1234.json"), "");
    const d = acquireUpgradeLock([lockDir], { note: "升级" });
    assert.equal(d.ok, false);
    assert.match(d.why, /读不懂/);
    assert.ok(existsSync(join(lockDir, "cccc.1234.json")), "读不懂的登记被删了");
    console.log("✓ 升级锁:有活着的别人就退下(同时到的都退下),同一次操作的下一段不冲突,死掉的不算数,读不懂的不删");
  }

  // ── 数据锁按库文件的真实落点 ──────────────────────────────────────────────────────
  {
    const shared = join(dir, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "real.db"), "");
    const homes = ["checkout-a", "checkout-b"].map((n) => join(dir, n, "data"));
    let linked = true;
    for (const h of homes) {
      mkdirSync(h, { recursive: true });
      try { symlinkSync(join(shared, "real.db"), join(h, "navi.db")); } catch { linked = false; }
    }
    if (linked) {
      const env = {};
      assert.deepEqual(dataLockDirs(join(homes[0], "navi.db"), env).filter((d) => dataLockDirs(join(homes[1], "navi.db"), env).includes(d)),
        [join(realpathSync(shared), ".navi-upgrade.lock.d")], "两份安装经软链用同一份库,却没有共同的锁");
      const a = acquireUpgradeLock(dataLockDirs(join(homes[0], "navi.db"), env), { note: "升级" });
      assert.ok(a.ok, a.why);
      const b = JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e",
        `import { acquireUpgradeLock, dataLockDirs } from ${JSON.stringify(new URL("./upgrade-lock.mjs", import.meta.url).href)};
console.log(JSON.stringify(acquireUpgradeLock(dataLockDirs(${JSON.stringify(join(homes[1], "navi.db"))}, {}), { note: "升级" })));`], { encoding: "utf8" }).stdout);
      assert.equal(b.ok, false, "另一份安装经自己的软链照样拿到了同一份库的锁");
      a.release();
      console.log("✓ 数据锁按库文件的真实落点:两份安装经各自的软链用同一份库,只有一个拿得到");
    } else {
      console.log("⚠ 建不了软链,跳过数据锁的软链那一格");
    }
  }

  // ── stop.mjs --pid ──────────────────────────────────────────────────────────────
  {
    // 异步跑:被结束的假服务是本进程的子进程,事件循环得转着才收得走它(否则它留成僵尸、看着还「活着」)。
    // 一个此刻空着的端口(先让系统挑一个再放掉),别跟同时在跑的别的回归撞上。
    const port = await new Promise((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => done(p)); }); });
    const stop = (pid, extra = [], timeout = "10", born = processBirth(pid)) => new Promise((done) => {
      const c = spawn(process.execPath, [fileURLToPath(new URL("./stop.mjs", import.meta.url)), "--pid", String(pid), "--born", born, ...extra], {
        env: { ...process.env, SERVER_ENTRY: "", STOP_PID_TIMEOUT: timeout, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      c.stdout.on("data", (d) => { stdout += d; });
      c.stderr.on("data", (d) => { stdout += d; });
      c.on("close", (status) => done({ status, stdout, stderr: "" }));
    });
    mkdirSync(join(dir, "server", "dist"), { recursive: true });
    // 假服务:收到 SIGTERM 之后还要忙一阵(同步迁移那种)才退;stubborn 的干脆不退;listen 的在端口上应答(慢服务后来起来了)。
    writeFileSync(join(dir, "server", "dist", "index.js"), `const stubborn = process.argv[2] === "stubborn";
process.on("SIGTERM", () => { if (stubborn) return; const until = Date.now() + 1500; while (Date.now() < until); process.exit(0); });
if (process.argv[2] === "listen") require("node:http").createServer((q, s) => s.end(JSON.stringify({ pid: process.pid }))).listen(${port}, "127.0.0.1", () => console.log("up"));
else { setInterval(() => {}, 1000); console.log("up"); }`);
    writeFileSync(join(dir, "worker.js"), "setInterval(() => {}, 1000); console.log(\"up\");");
    const start = async (...args) => {
      const child = spawn(process.execPath, args[0] === "worker" ? ["worker.js", "--artifact=server/dist/index.js"] : ["server/dist/index.js", ...args], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
      await new Promise((r) => child.stdout.once("data", r));
      return child.pid;
    };
    const busy = await start();
    const r1 = await stop(busy);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.ok(!isPidAlive(busy), "stop --pid 报成功时那个进程还活着");
    const stubborn = await start("stubborn");
    if (process.platform !== "win32") {
      const r2 = await stop(stubborn, [], "1");
      assert.equal(r2.status, 1, r2.stdout);
      assert.ok(isPidAlive(stubborn), "等满了还没退,却没如实失败");
    }
    const r3 = await stop(stubborn, ["--force"], "1");
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    for (let i = 0; i < 20 && isPidAlive(stubborn); i += 1) await sleep(50);
    assert.ok(!isPidAlive(stubborn));
    // 认人:参数里只是含着入口路径的别的程序、出生时刻对不上的(号码被复用)、已经在端口上应答的,都不动。
    const worker = await start("worker");
    const r4 = await stop(worker);
    assert.equal(r4.status, 2, r4.stdout);
    assert.ok(isPidAlive(worker), "参数里只是提到入口路径的进程被结束了");
    const reused = await start();
    const r5 = await stop(reused, [], "10", String(Number(processBirth(reused).replace(/^w/, "")) - 1000));
    assert.equal(r5.status, 2, r5.stdout);
    assert.match(r5.stdout, /号码被复用了/);
    assert.ok(isPidAlive(reused), "出生时刻对不上的进程被结束了");
    const answering = await start("listen");
    const r6 = await stop(answering, ["--force"]);
    assert.equal(r6.status, 2, r6.stdout);
    assert.match(r6.stdout, /已经在 :\d+ 上应答了/);
    assert.ok(isPidAlive(answering), "已经在应答的服务被按号码结束了");
    for (const pid of [worker, reused, answering]) process.kill(pid, "SIGKILL");
    console.log("✓ stop.mjs --pid --born:等服务进程真的退出才算完;等满还不退如实失败、--force 才强杀;只是参数含入口的、号码被复用的、已经在应答的都不动");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("✅ 留底、核对认人、升级锁(含软链库)、按 pid + 出生时刻结束服务");
