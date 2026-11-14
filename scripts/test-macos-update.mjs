// mac app 自更新的定点回归（仅 macOS）：装新版之前那道闸（UpdateGate）和发版脚本（release.mjs）。
//
// 闸：编进测试驱动的是真的 UpdateGate / RestartImpact / ServerShutdown / DatabaseBackup /
// ServerRecord；端口上摆一个假的 ash（独立进程，按 health 协议报 pid 和数据根，restart-impact
// 的答复从一个状态文件里读，收到 SIGTERM 才退），数据根里放一份 WAL 还没落盘的真 SQLite 库。
// 覆盖：没人会被打断 → 不问、停服务、备份、放行；会打断（判失败 + 握着 MCP，同一个任务只算
// 一次）→ 先问；选「等」→ 排空后自己放行；选「现在」→ 立刻放行；问不出来 → 当成会打断；
// 等的时候服务一时回 503 / 不应答 → 确认不了、接着等，不停服务；停服务只停评估过的那个进程；
// 服务停不下来 → 不放行、不备份、松开启动闸；另一处攥着启动锁 → 不停服务；维护期里别的进程起
// 不了服务、维护方没了就作废；端口上是别的 ash → 不碰它；退出那一档的取消 / 等 / 现在、备份失败
// 时的说法；Sparkle 放弃（放行后 / 等待中）→ 闸收回、作废的安装回调不再跑、重试再备份；库上次是
// 别的构建号在用、又没备份过 → 起服务前先备份并固定成恢复点，备份不成不起；没有服务记录、新版连着
// 起不来时重试不再备份，迁移前的原件一直留着；起它的启动器没等到、服务后来起来了 → 之后谁看到它
// 应答谁确认，下一版照常补备份；上一版起过却没人确认 → 也不拿更早的底顶替；确认之后旧恢复点作废
// （删不掉文件也一样）；确认之前备份不轮换、之后只留最近 5 份，同一秒不覆盖、按生成先后认新旧；
// 旧版 app 起的服务认得出来。
//
// 发版：用演练密钥和一个假的 Ash.app 跑 `release.mjs --local`：zip 与 appcast 都验得过签、被篡改的
// 包与 appcast 验不过；同一版、更旧的版本拒发；app 里的公钥和签名私钥不是一对时拒发；第二版排在
// 第一版前面、第一版原样保留；`--notes` 进 appcast（转义过）；同一构建号缓存的 zip 来自另一份 app
// 时拒发。正式发版对着一个本地假 GitHub 跑：只给 GH_TOKEN，传包和提交 appcast 都走这一张凭证；
// 凭证没有写权限时什么都不传。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { once } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "macOS-only regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const mac = join(root, "desktop/macos");
const temporary = mkdtempSync(join(tmpdir(), "ash-macos-update-"));
const data = join(temporary, "data");
const binary = join(temporary, "update-tests");
const fakes = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

const build = spawnSync("swiftc", ["-swift-version", "5",
  ...["AshConfig", "AshHealth", "DatabaseBackup", "RestartImpact", "ServerControl", "ServerLauncher", "ServerStartLock", "UpdateGate"]
    .map((name) => join(mac, `Sources/${name}.swift`)),
  join(mac, "Tests/Update/main.swift"), "-o", binary], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

const port = await freePort();
const runtime = join(temporary, "no-runtime");
const windowPort = await freePort();
const env = { ...process.env, ASH_URL: `http://127.0.0.1:${port}`, ASH_DATA_DIR: data, ASH_MAC_RUNTIME: runtime,
  ASH_MAC_WINDOW_PORT: String(windowPort) };
const impactFile = join(temporary, "impact.json");
const setImpact = (value) => writeFileSync(impactFile, typeof value === "string" ? value : JSON.stringify(value));
const healthFile = join(temporary, "health.txt");
/** 假服务的 /api/health 怎么答：ok / 503 / hang（不应答）。 */
const setHealth = (value) => writeFileSync(healthFile, value);
const clear = { survives: [{ id: "s", title: "接管得了的", pid: 1 }], resumes: [{ id: "lead", title: "调度台" }], interrupted: [], mcpDisrupted: [] };

/** 假 ash：独立进程，pid 就是它自己。stubborn = 不理 SIGTERM。 */
async function startFake({ dataDir = data, stubborn = false } = {}) {
  const source = `
    const http = require('node:http'); const fs = require('node:fs');
    ${stubborn ? "process.on('SIGTERM', () => {});" : ""}
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const id = 'fake-' + process.pid;
      if (req.url.startsWith('/api/restart-impact')) {
        // 和 server/src/instance-binding.ts 一样：点名要别的实例（或没点名）就不答，闸只能问认过的那一份。
        if (req.headers['x-ash-instance'] !== id) { res.statusCode = 409; return res.end('{"error":"不是这一份"}'); }
        const raw = fs.readFileSync(${JSON.stringify(impactFile)}, 'utf8');
        if (raw === 'refuse') { res.statusCode = 401; return res.end('{"error":"请先登录"}'); }
        return res.end(raw);
      }
      const health = fs.existsSync(${JSON.stringify(healthFile)}) ? fs.readFileSync(${JSON.stringify(healthFile)}, 'utf8') : 'ok';
      if (health === 'hang') return;
      if (health === '503') { res.statusCode = 503; return res.end('{"ok":false}'); }
      res.end(JSON.stringify({ ok: true, pid: process.pid, instance: { id, dataDir: ${JSON.stringify(dataDir)},
        codeDir: ${JSON.stringify(runtime)}, localOnly: true, windowPort: ${windowPort} } }));
    }).listen(${port}, '127.0.0.1', () => console.log('LISTENING'));`;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "inherit"] });
  fakes.add(child);
  child.once("exit", () => fakes.delete(child));
  await new Promise((done) => child.stdout.once("data", done));
  return child;
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

/**
 * 驱动一场。一律异步：假服务是这个进程的子进程，事件循环不转就没人收它的尸，SIGTERM 之后
 * 它会一直以僵尸的样子「活着」（真 server 是 detached 出去的，归 launchd 收）。
 */
async function drive(args, { answers = "", extraEnv = {} } = {}) {
  return driveAsync(args, answers, extraEnv).done;
}

function driveAsync(args, answers, extraEnv = {}) {
  const child = spawn(binary, args, { env: { ...env, ANSWERS: answers, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const done = new Promise((resolveDone) => child.once("close", (status) => resolveDone({ status, out })));
  return { done, output: () => out };
}

const backups = () => (existsSync(join(data, "backups")) ? readdirSync(join(data, "backups")).filter((n) => n.endsWith(".db")) : []);

try {
  // 数据根里一份真库：WAL 模式、写入还在 WAL 里（就像正在跑的 server 刚写过）。
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "ash.db"));
  db.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table tasks (id text primary key)");
  for (let i = 0; i < 50; i += 1) db.exec(`insert into tasks values ('t${i}')`);

  // ── 没人会被打断：不问，停服务、备份、放行 ──
  setImpact(clear);
  let fake = await startFake();
  let result = await drive(["update", "10"]);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /ASK/, "tasks that survive a restart are no reason to ask");
  assert.match(result.out, /HOLD 正在安装更新/);
  assert.match(result.out, /PROCEED[\s\S]*PHASE prepared LAUNCH-HOLD 正在安装更新/, "launching stays held until Sparkle replaces the app");
  await delay(100);
  assert.equal(alive(fake), false, "own service is stopped before the app is replaced");
  assert.equal(backups().length, 1);
  const copy = new DatabaseSync(join(data, "backups", backups()[0]), { readOnly: true });
  assert.equal(copy.prepare("select count(*) as n from tasks").get().n, 50, "writes still in the WAL are in the backup");
  copy.close();
  console.log("PASS: nothing would be interrupted → no question; service stopped, database backed up, install proceeds, launching held");

  // ── 会打断：先问；选「等」→ 排空后自己放行 ──
  setImpact({ ...clear,
    interrupted: [{ id: "a", title: "排队的任务", reason: "排队中，还没有进程可接管" }],
    mcpDisrupted: [{ id: "a", title: "排队的任务", pid: 2 }, { id: "b", title: "握着 MCP 的任务", pid: 3 }] });
  fake = await startFake();
  const waiting = driveAsync(["update", "15"], "wait");
  for (let i = 0; i < 100 && !waiting.output().includes("ASK"); i++) await delay(50);
  const asked = waiting.output();
  assert.match(asked, /会打断 2 个任务/, "a task in both lists counts once");
  assert.match(asked, /排队的任务 —— 会被判失败：排队中/);
  assert.match(asked, /握着 MCP 的任务 —— 手里握着 ash MCP/);
  assert.match(asked, /等它们跑完再装,现在装/);
  await delay(800);
  assert.equal(alive(fake), true, "waiting leaves the service alone");
  assert.doesNotMatch(waiting.output(), /PROCEED/);
  setImpact(clear);
  result = await waiting.done;
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /PROCEED/);
  await delay(100);
  assert.equal(alive(fake), false);
  assert.equal(backups().length, 2);
  console.log("PASS: would interrupt → asks, listing each task once with why; 'wait' polls and proceeds by itself once drained");

  // ── 选「现在」──
  setImpact({ ...clear, interrupted: [{ id: "a", title: "排队的任务", reason: "排队中" }] });
  fake = await startFake();
  result = await drive(["update", "10"], { answers: "now" });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ASK[\s\S]*PROCEED/);
  await delay(100);
  assert.equal(alive(fake), false);
  console.log("PASS: 'install now' proceeds at once");

  // ── 问不出来 = 当成会打断 ──
  setImpact("refuse");
  fake = await startFake();
  result = await drive(["update", "10"], { answers: "now" });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ASK .*确认不了重启会不会打断任务（服务端回 401）/);
  console.log("PASS: an unanswered impact question is treated as disruptive, not as none");

  // ── 等的时候服务一时答不上来：确认不了，接着等；绝不停它 ──
  for (const flaky of ["503", "hang"]) {
    setImpact({ ...clear, interrupted: [{ id: "a", title: "排队的任务", reason: "排队中" }] });
    setHealth("ok");
    fake = await startFake();
    const flakyWait = driveAsync(["update", "20"], "wait");
    for (let i = 0; i < 100 && !flakyWait.output().includes("ASK"); i++) await delay(50);
    assert.match(flakyWait.output(), /ASK/);
    setHealth(flaky);
    await delay(flaky === "hang" ? 4000 : 1200);
    setHealth("ok");
    await delay(600);
    assert.equal(alive(fake), true, `a ${flaky} health answer while waiting is no reason to stop a service with tasks`);
    assert.doesNotMatch(flakyWait.output(), /PROCEED/);
    setImpact(clear);
    result = await flakyWait.done;
    assert.match(result.out, /PROCEED/, result.out);
    await delay(100);
    assert.equal(alive(fake), false);
  }
  console.log("PASS: while waiting, a 503 or an unanswered health check is 'cannot confirm', not 'nothing to protect'");

  // ── 停服务只停评估过的那个进程 ──
  fake = await startFake();
  result = await drive(["stop", `ours:${fake.pid + 1}`]);
  assert.match(result.out, /STOP changed/, result.out);
  result = await drive(["stop", "absent"]);
  assert.match(result.out, /STOP changed/, "a service that appeared after 'nobody is listening' is not stopped on that verdict");
  setHealth("503");
  result = await drive(["stop", "consented"]);
  assert.match(result.out, /STOP changed/, "an unidentifiable answer stops nothing, even after consent");
  setHealth("ok");
  assert.equal(alive(fake), true);
  result = await drive(["stop", `ours:${fake.pid}`]);
  assert.match(result.out, new RegExp(`STOP stopped\\(Optional\\(${fake.pid}\\)\\)`), result.out);
  await delay(100);
  assert.equal(alive(fake), false);
  result = await drive(["stop", "absent"]);
  assert.match(result.out, /STOP stopped\(nil\)/);
  console.log("PASS: shutdown is bound to the process that was assessed; anything else is re-assessed, not killed");

  // ── 另一处攥着启动锁（正在起服务）：等不到就不停、不装 ──
  setImpact(clear);
  fake = await startFake();
  const entered = join(temporary, "lock-entered");
  const locker = spawn("/usr/bin/lockf", ["-k", join(data, ".mac-launch.lock"), process.execPath, "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(entered)},'1');setTimeout(()=>{},60000)`], { stdio: "ignore" });
  fakes.add(locker);
  for (let i = 0; i < 100 && !existsSync(entered); i++) await delay(50);
  const backupsBefore = backups().length;
  result = await drive(["update", "10"], { extraEnv: { LOCK_TIMEOUT: "1" } });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /REPORT 另一处正在起 ash 服务/);
  assert.equal(alive(fake), true, "the service is not stopped while someone else is starting one");
  assert.equal(backups().length, backupsBefore);
  locker.kill("SIGKILL");
  await once(locker, "exit");
  console.log("PASS: the gate takes the launch lock before stopping anything");

  // ── 维护期跨进程：别的进程起不了服务；维护方没了就作废 ──
  fake.kill("SIGKILL");
  await once(fake, "exit");
  const maintainer = driveAsync(["maintain", "30"], "");
  for (let i = 0; i < 100 && !maintainer.output().includes("MAINTAINING"); i++) await delay(50);
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH failed 测试里的维护/, "a launcher in another process honours the maintenance marker");
  const maintainerPid = Number(readFileSync(join(data, ".mac-maintenance.json"), "utf8").match(/"pid":(\d+)/)[1]);
  process.kill(maintainerPid, "SIGKILL");
  await maintainer.done;
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH failed .*不完整/, "once the holder is gone the marker is void (here the fixture has no runtime)");
  assert.equal(existsSync(join(data, ".mac-maintenance.json")), false);
  console.log("PASS: maintenance holds every launcher across processes, and dies with its holder");

  // ── 停不下来：不放行、不备份、松开启动闸 ──
  setImpact(clear);
  fake = await startFake({ stubborn: true });
  const before = backups().length;
  result = await drive(["update", "10"], { extraEnv: { SHUTDOWN_TIMEOUT: "1" } });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /REPORT 服务进程 \d+ 1 秒内没有退出/);
  assert.match(result.out, /RELEASE[\s\S]*PHASE idle LAUNCH-HOLD none/, "a failed attempt lets the window bring the service back");
  assert.doesNotMatch(result.out, /PROCEED/);
  assert.equal(backups().length, before, "no backup of a database that is still being written");
  fake.kill("SIGKILL");
  await once(fake, "exit");
  console.log("PASS: a service that will not stop blocks the install and releases the launch hold");

  // ── 端口上是别的 ash：不碰它 ──
  setImpact({ ...clear, interrupted: [{ id: "x", title: "别人的任务", reason: "r" }] });
  fake = await startFake({ dataDir: join(temporary, "someone-else") });
  result = await drive(["update", "10"]);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /ASK/);
  assert.equal(alive(fake), true, "another ash on the port is not ours to stop");
  fake.kill("SIGKILL");
  await once(fake, "exit");
  console.log("PASS: another ash on the port is neither asked about nor stopped");

  // ── 退出那一档：取消 / 等 / 现在 ──
  setImpact({ ...clear, interrupted: [{ id: "a", title: "排队的任务", reason: "排队中" }] });
  fake = await startFake();
  result = await drive(["quit", "5"], { answers: "cancel" });
  assert.match(result.out, /ASK .*退出 ash 时 Sparkle 会把下好的新版装上.*\| 等它们跑完再装,现在装,取消/);
  assert.match(result.out, /REPLY false/);
  assert.equal(alive(fake), true);
  const quitWaiting = driveAsync(["quit", "15", "drain"], "wait");
  for (let i = 0; i < 100 && !quitWaiting.output().includes("REPLY"); i++) await delay(50);
  assert.match(quitWaiting.output(), /REPLY false/, "'wait' cancels this quit");
  setImpact(clear);
  result = await quitWaiting.done;
  assert.match(result.out, /DRAINED/, "and finishes the quit once drained");
  await delay(100);
  assert.equal(alive(fake), false);
  setImpact({ ...clear, interrupted: [{ id: "a", title: "排队的任务", reason: "排队中" }] });
  fake = await startFake();
  result = await drive(["quit", "10"], { answers: "now" });
  assert.match(result.out, /REPLY true/);
  await delay(100);
  assert.equal(alive(fake), false);
  console.log("PASS: quitting with a downloaded update goes through the same gate, with a cancel");

  // ── Sparkle 放弃了：放行之后 → 闸收回、重试从头评估并再备份；等待中 → 排着的安装作废 ──
  rmSync(join(data, "backups"), { recursive: true, force: true });
  setImpact(clear);
  fake = await startFake();
  result = await drive(["abandon-prepared", "10"]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /PROCEED[\s\S]*RELEASE[\s\S]*PHASE idle PENDING false LAUNCH-HOLD none[\s\S]*HOLD 正在安装更新[\s\S]*PROCEED/,
    "after an abort the launch hold is gone and a retry goes through the whole gate again");
  assert.equal(backups().length, 2, "the retry backs up again");
  setImpact({ ...clear, interrupted: [{ id: "a", title: "排队的任务", reason: "排队中" }] });
  fake = await startFake();
  const abandoned = driveAsync(["abandon-waiting", "10", "2"], "wait");
  for (let i = 0; i < 100 && !abandoned.output().includes("ABANDONED"); i++) await delay(50);
  setImpact(clear);
  result = await abandoned.done;
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /PHASE idle PENDING false/);
  assert.equal(alive(fake), true, "an abandoned update never stops the service later, even once drained");
  fake.kill("SIGKILL");
  await once(fake, "exit");
  console.log("PASS: a Sparkle abort resets the gate: hold released, stale install callbacks dropped, retry re-assesses and re-backs up");

  // ── 退出那一档备份失败：说清楚退出会发生什么 ──
  mkdirSync(join(data, "backups"), { recursive: true });
  chmodSync(join(data, "backups"), 0o500);
  result = await drive(["quit", "10"], { answers: "now" });
  chmodSync(join(data, "backups"), 0o700);
  assert.match(result.out, /ASK 更新没装上 \| 更新前备份库没成功.*新版起服务之前会先备份库，备份不成就不起服务/, result.out);
  assert.match(result.out, /REPLY true/);
  console.log("PASS: a failed backup on quit says what quitting will and will not do");

  // ── 库上次是别的构建号在用、又没备份过：起服务前先备份并固定成恢复点，备份不成不起 ──
  const pins = async () => (await drive(["pins"])).out.match(/PINS (.*)/)[1].split(",").filter(Boolean);
  const rows = (file, id) => {
    const copy = new DatabaseSync(join(data, "backups", file), { readOnly: true });
    try { return copy.prepare("select count(*) as n from tasks where id = ?").get(id).n; } finally { copy.close(); }
  };
  rmSync(join(data, "backups"), { recursive: true, force: true });
  await drive(["record", "4242", "20000101.0000"]);
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH failed .*不完整/, result.out);
  assert.deepEqual(backups().map((n) => n.split("-").pop()), ["20000101.0000.db"], "backed up before a newer build may migrate it");
  assert.deepEqual(await pins(), backups(), "and pinned as the recovery point");
  result = await drive(["launch", "2"]);
  assert.equal(backups().length, 1, "this build already had its go at this database: no second backup");
  rmSync(join(data, "backups"), { recursive: true, force: true });
  await drive(["record", "4242", "20000101.0000"]);
  mkdirSync(join(data, "backups"));
  chmodSync(join(data, "backups"), 0o500);
  result = await drive(["launch", "2"]);
  chmodSync(join(data, "backups"), 0o700);
  assert.match(result.out, /LAUNCH failed .*迁移前先备份库没成功.*没起服务/, result.out);
  console.log("PASS: a launcher about to run a newer build on an un-backed-up database backs it up first, or does not start");

  // ── 没有服务记录（导入来的、旧版 app 没写过）、新版连着起不来：迁移前的原件一直留着 ──
  rmSync(join(data, "backups"), { recursive: true, force: true });
  rmSync(join(data, ".mac-server.json"), { force: true });
  db.exec("insert into tasks values ('before-migration')");
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH failed .*不完整/, result.out);
  const original = backups()[0];
  assert.deepEqual(await pins(), [original]);
  // 失败的迁移已经改过这份库；之后每一次重试都起不来。
  db.exec("delete from tasks where id = 'before-migration'");
  for (let i = 0; i < 6; i += 1) {
    await delay(1100);
    result = await drive(["launch", "2"]);
    assert.match(result.out, /LAUNCH failed .*不完整/, result.out);
  }
  assert.deepEqual(backups(), [original], "retries of a failing new build never back up the half-migrated database over the original");
  assert.equal(rows(original, "before-migration"), 1, "the recovery point is the pre-migration original");
  // 再来几次更新前备份（闸那一头）照做，原件仍固定着、不被轮换掉。
  for (let i = 0; i < 6; i += 1) await drive(["backups", "1"]);
  assert.ok((await pins()).includes(original), "an unconfirmed recovery point stays pinned");
  assert.ok(backups().includes(original), "and outside the rotation");
  console.log("PASS: with no service record, repeated failed launches keep the pre-migration original pinned and never rotate it out");

  // ── 起它的启动器没等到（被退掉、超时），服务后来起来了：谁先看到它应答谁确认；下一版照常补备份 ──
  rmSync(join(data, "backups"), { recursive: true, force: true });
  rmSync(join(data, ".mac-server.json"), { force: true });
  result = await drive(["launch", "2"]);
  const beforeB = backups()[0];
  assert.deepEqual(await pins(), [beforeB]);
  fake = await startFake();
  await drive(["record", String(fake.pid)]); // 启动器拉起了进程、记下 pid，然后就被退掉了
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH ready/, result.out);
  assert.deepEqual(await pins(), [], "a service seen answering by a later launcher confirms its build, not only the one that started it");
  db.exec("insert into tasks values ('after-B')");
  fake.kill("SIGKILL");
  await once(fake, "exit");
  await drive(["record", String(fake.pid), "20000101.0000"]); // 换了下一版 app：库最后是上一版起的
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH failed .*不完整/, result.out);
  const beforeC = (await pins())[0];
  assert.notEqual(beforeC, beforeB, "the next build backs up again instead of trusting the earlier generation's point");
  assert.equal(rows(beforeC, "after-B"), 1, "and that backup has what was written while the previous build ran");
  console.log("PASS: confirmation does not depend on the launcher that started the service; the next build gets its own backup");

  // ── 上一版起过却从没被谁看到应答（比如只在浏览器里用过）：也不拿上一次的底当这一次的 ──
  rmSync(join(data, "backups"), { recursive: true, force: true });
  rmSync(join(data, ".mac-server.json"), { force: true });
  result = await drive(["launch", "2"]);
  const unseenBefore = backups()[0];
  await drive(["record", "0", "20000101.0000"]); // 上一版起过（记录写着它），从没确认
  db.exec("insert into tasks values ('unseen-B')");
  result = await drive(["launch", "2"]);
  const points = await pins();
  assert.equal(points.length, 2, "a backup that predates another build's run does not cover this one");
  assert.equal(rows(points[0], "unseen-B"), 1, "the newest point is the one just before this build");
  assert.equal(points[1], unseenBefore, "the older unconfirmed point is kept too");
  console.log("PASS: a point taken before another build ran never stands in for this build's backup");

  // ── 确认之后旧恢复点一律作废，删不掉恢复点文件也一样 ──
  fake = await startFake();
  await drive(["record", String(fake.pid)]);
  chmodSync(join(data, "backups"), 0o500);
  result = await drive(["launch", "2"]);
  chmodSync(join(data, "backups"), 0o700);
  assert.match(result.out, /LAUNCH ready/, result.out);
  assert.equal(existsSync(join(data, "backups", "recovery-points.json")), true, "fixture: the pin file could not be deleted");
  assert.deepEqual(await pins(), [], "points older than the confirmation no longer count");
  fake.kill("SIGKILL");
  await once(fake, "exit");
  console.log("PASS: a confirmation voids older points even when their file cannot be removed");

  // ── 旧版 app 起的服务 ──
  result = await drive(["record", "4242"]);
  assert.match(result.out, /STALE none/, "a service this very build started is current");
  result = await drive(["record", "4242", "20000101.0000"]);
  assert.match(result.out, /STALE 20000101\.0000/);
  assert.match(result.out, /STALE-OTHER-PID none/, "a record about some other process says nothing");
  setImpact(clear);
  fake = await startFake();
  result = await drive(["stale", "10"]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /HOLD 正在换成新版的 ash 服务[\s\S]*RELEASE[\s\S]*PROCEED[\s\S]*PHASE idle LAUNCH-HOLD none/,
    "after replacing a stale service the gate opens again so the window starts the new one");
  console.log("PASS: a service started by an older build is recognised and replaced through the gate");

  // ── 备份：确认之前一份不轮换；确认之后只留最近 5 份；同一秒的多份不覆盖、按生成先后认新旧 ──
  rmSync(join(data, "backups"), { recursive: true, force: true });
  result = await drive(["backups", "7"]);
  let kept = result.out.match(/KEPT (.*)/)[1].split(",");
  assert.deepEqual(kept.map((n) => n.split("-").pop()), ["v6.db", "v5.db", "v4.db", "v3.db", "v2.db", "v1.db", "v0.db"],
    "unconfirmed points are never rotated out");
  assert.deepEqual(result.out.match(/PINS (.*)/)[1].split(","), kept);
  await drive(["record", "4242"]);
  assert.match((await drive(["confirm", "4242"])).out, /PINS $/m, "a confirmation releases them");
  result = await drive(["backups", "1"]);
  kept = result.out.match(/KEPT (.*)/)[1].split(",");
  assert.equal(kept.length, 5, result.out);
  assert.equal(kept[0], result.out.match(/MADE (\S+)/)[1], "newest first");
  assert.deepEqual(readdirSync(join(data, "backups")).filter((n) => n.endsWith(".db")).sort(), [...kept].sort(), "no partial files left behind");
  rmSync(join(data, "backups"), { recursive: true, force: true });
  result = await drive(["backups-same-second"]);
  const same = result.out.match(/SAME-SECOND distinct=(\d+) last=(\S+) newest=(\S+)/);
  assert.equal(same[1], "12", "backups in the same second get different names");
  assert.equal(same[3], same[2], "the newest is the one made last, whatever its name sorts as");
  db.close();
  console.log("PASS: backups are consistent snapshots; unconfirmed points are kept, then the newest five; never overwritten, ordered by creation");

  // ── 发版：本地演练 ──
  await releaseRehearsal();
} finally {
  for (const child of fakes) child.kill("SIGKILL");
  rmSync(temporary, { recursive: true, force: true });
}

async function releaseRehearsal() {
  const sparkle = spawnSync(process.execPath, [join(mac, "scripts/sparkle.mjs")], { encoding: "utf8" });
  assert.equal(sparkle.status, 0, sparkle.stderr);
  const signUpdate = join(sparkle.stdout.trim(), "bin/sign_update");
  const makeKey = (name) => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const file = join(temporary, `${name}.key`);
    writeFileSync(file, Buffer.from(jwk.d, "base64url").toString("base64"));
    return { file, publicKey: Buffer.from(jwk.x, "base64url").toString("base64") };
  };
  const key = makeKey("rehearsal");
  const wrong = makeKey("wrong");
  const feed = join(temporary, "feed");
  const fakeApp = (version, publicKey) => {
    const app = join(temporary, `apps-${version}`, "Ash.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents/MacOS/Ash"), `binary ${version}`);
    writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>AshSourceCommit</key><string>unknown</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>SUFeedURL</key><string>http://127.0.0.1:1/appcast.xml</string>
  <key>SUPublicEDKey</key><string>${publicKey}</string>
</dict></plist>`);
    return app;
  };
  const release = (app, keyFile, notes = "演练") => spawnSync(process.execPath,
    [join(mac, "scripts/release.mjs"), "--local", feed, "--app", app, "--ed-key-file", keyFile, "--notes", notes],
    { encoding: "utf8", env: { ...process.env, ASH_MAC_RELEASE_ARTIFACTS: join(temporary, "artifacts") } });
  const verify = (...args) => spawnSync(signUpdate, ["--verify", "--ed-key-file", key.file, ...args], { encoding: "utf8" }).status;
  const appcast = () => readFileSync(join(feed, "appcast.xml"), "utf8");

  let result = release(fakeApp("20000101.0001", key.publicKey), key.file);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const first = join(feed, "Ash-0.2.0-20000101.0001.zip");
  assert.ok(existsSync(first));
  const signature = appcast().match(/sparkle:edSignature="([^"]+)"/)[1];
  assert.equal(verify(first, signature), 0, "the zip verifies against the signature in the appcast");
  assert.equal(verify(join(feed, "appcast.xml")), 0, "the appcast itself is signed");
  assert.match(appcast(), /url="http:\/\/127\.0\.0\.1:1\/Ash-0\.2\.0-20000101\.0001\.zip"/);
  assert.match(appcast(), /length="\d+"/);

  result = release(fakeApp("20000101.0001", key.publicKey), key.file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已经发过了/);
  result = release(fakeApp("20000101.0000", key.publicKey), key.file);
  assert.match(result.stderr, /不比 appcast 里最新的 20000101\.0001 新/);
  result = release(fakeApp("20000101.0002", key.publicKey), wrong.file);
  assert.match(result.stderr, /不是一对/, "an app whose key does not match the signing key is never published");

  result = release(fakeApp("20000101.0002", key.publicKey), key.file, "第二版");
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const versions = [...appcast().matchAll(/<sparkle:version>([^<]+)<\/sparkle:version>/g)].map((m) => m[1]);
  assert.deepEqual(versions, ["20000101.0002", "20000101.0001"], "newest first, the earlier item kept");
  assert.equal(appcast().match(/sparkle:edSignature="([^"]+)"/g).length, 2);
  assert.equal(verify(join(feed, "appcast.xml")), 0, "re-signed after adding the item");
  const descriptions = [...appcast().matchAll(/<description>([^<]*)<\/description>/g)].map((m) => unescapeXml(m[1]));
  assert.deepEqual(descriptions, ["<p>第二版</p>", "<p>演练</p>"], "--notes reaches the appcast");

  const second = join(feed, "Ash-0.2.0-20000101.0002.zip");
  const newest = appcast().match(/sparkle:edSignature="([^"]+)"/)[1];
  appendFileSync(second, "tampered");
  assert.notEqual(verify(second, newest), 0, "a tampered zip fails verification");
  writeFileSync(join(feed, "appcast.xml"), appcast().replace("20000101.0002</sparkle:version>", "20990101.0002</sparkle:version>"));
  assert.notEqual(verify(join(feed, "appcast.xml")), 0, "a tampered appcast fails verification");
  // 同一构建号：上次压的 zip 来自另一份 app → 拒发
  const cached = join(temporary, "artifacts", "v0.2.0-20990101.0003");
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "Ash-0.2.0-20990101.0003.zip"), "zip of some other build");
  writeFileSync(join(cached, "Ash-0.2.0-20990101.0003.zip.source"), "0000\n");
  result = release(fakeApp("20990101.0003", key.publicKey), key.file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /是上次从另一份 app 压的/, "a cached zip of a different app is never signed for this one");
  console.log("PASS: release --local signs zip and appcast, refuses re-releases, older versions and mismatched keys; tampering is detected; notes kept; cached zip bound to its app");

  await formalRehearsal(key, fakeApp);
}

function unescapeXml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

/** 本地假 GitHub：只认 `Bearer test-token`；记下每个请求。push=false 时这张凭证没有写权限。 */
async function fakeGitHub({ push }) {
  const state = { calls: [], files: new Map(), releases: [], downloads: new Map() };
  let base = "";
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    const json = (status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && state.downloads.has(url.pathname)) return res.end(state.downloads.get(url.pathname));
    state.calls.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== "Bearer test-token") return json(401, { message: "Bad credentials" });
    if (req.method === "GET" && url.pathname === "/repos/o/r") return json(200, { permissions: { push } });
    const contents = url.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
    if (contents) {
      const path = decodeURIComponent(contents[1]);
      const file = state.files.get(path);
      if (req.method === "GET") return file ? json(200, { sha: file.sha, encoding: "base64", content: Buffer.from(file.text).toString("base64") }) : json(404, {});
      const put = JSON.parse(body);
      if (file?.sha !== put.sha) return json(409, { message: "sha does not match" });
      const sha = createHash("sha1").update(put.content).digest("hex");
      state.files.set(path, { sha, text: Buffer.from(put.content, "base64").toString("utf8"), branch: put.branch, message: put.message });
      return json(200, { content: { sha } });
    }
    if (req.method === "GET" && url.pathname.startsWith("/repos/o/r/releases/tags/")) {
      const found = state.releases.find((r) => r.tag_name === decodeURIComponent(url.pathname.split("/").pop()));
      return found ? json(200, found) : json(404, {});
    }
    if (req.method === "POST" && url.pathname === "/repos/o/r/releases") {
      const { tag_name: tag, body: notes } = JSON.parse(body);
      const created = { tag_name: tag, body: notes, assets: [], upload_url: `${base}/uploads/${tag}{?name,label}` };
      state.releases.push(created);
      return json(201, created);
    }
    if (req.method === "POST" && url.pathname.startsWith("/uploads/")) {
      const tag = url.pathname.split("/")[2];
      const name = url.searchParams.get("name");
      const asset = { name, size: body.length, browser_download_url: `${base}/download/${tag}/${name}` };
      state.downloads.set(`/download/${tag}/${name}`, body);
      state.releases.find((r) => r.tag_name === tag).assets.push(asset);
      return json(201, asset);
    }
    json(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  return { state, base, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) };
}

async function formalRehearsal(key, fakeApp) {
  const configFile = join(temporary, "release.json");
  writeFileSync(configFile, JSON.stringify({ repo: "o/r", branch: "main", appcastPath: "ash/mac/appcast.xml", tagPrefix: "ash-mac-v",
    keychainAccount: "unused", publicKey: key.publicKey }));
  const app = fakeApp("20000102.0001", key.publicKey);
  // 正式发版要求 app 的更新源就是 release.json 算出来的那一个。
  const plist = join(app, "Contents/Info.plist");
  writeFileSync(plist, readFileSync(plist, "utf8").replace("http://127.0.0.1:1/appcast.xml", "https://raw.githubusercontent.com/o/r/main/ash/mac/appcast.xml"));
  const publish = async (github) => new Promise((done) => {
    const child = spawn(process.execPath, [join(mac, "scripts/release.mjs"), "--app", app, "--ed-key-file", key.file, "--notes", "正式 & <b>演练</b>"], {
      env: { ...process.env, GH_TOKEN: "test-token", GITHUB_TOKEN: "", ASH_MAC_GITHUB_API: github.base,
        ASH_MAC_RELEASE_CONFIG: configFile, ASH_MAC_RELEASE_ARTIFACTS: join(temporary, "formal-artifacts") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("close", (status) => done({ status, out }));
  });

  let github = await fakeGitHub({ push: false });
  let result = await publish(github);
  await github.close();
  assert.notEqual(result.status, 0, result.out);
  assert.match(result.out, /没有写权限/);
  assert.deepEqual(github.state.calls.filter((c) => !c.startsWith("GET")), [], "nothing is published with a credential that cannot finish the job");

  github = await fakeGitHub({ push: true });
  result = await publish(github);
  await github.close();
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /GitHub 凭证：GH_TOKEN/);
  const order = github.state.calls.filter((c) => !c.startsWith("GET"));
  assert.deepEqual(order.map((c) => c.split(" ")[0] + " " + c.split("/")[1]), ["POST repos", "POST uploads", "PUT repos"],
    "release, then the zip, then the appcast — all through the API with the one token");
  const committed = github.state.files.get("ash/mac/appcast.xml");
  assert.equal(committed.branch, "main");
  assert.match(committed.text, /<sparkle:version>20000102\.0001<\/sparkle:version>/);
  assert.match(committed.text, new RegExp(`url="${github.base}/download/ash-mac-v0\\.2\\.0-20000102\\.0001/Ash-0\\.2\\.0-20000102\\.0001\\.zip"`));
  writeFileSync(join(temporary, "committed-appcast.xml"), committed.text);
  const sparkle = spawnSync(process.execPath, [join(mac, "scripts/sparkle.mjs")], { encoding: "utf8" }).stdout.trim();
  assert.equal(spawnSync(join(sparkle, "bin/sign_update"), ["--verify", "--ed-key-file", key.file, join(temporary, "committed-appcast.xml")]).status, 0,
    "the committed appcast is signed");
  assert.equal(github.state.releases[0].body, "正式 & <b>演练</b>", "the release body is the notes as given");
  assert.equal(unescapeXml(committed.text.match(/<description>([^<]*)<\/description>/)[1]), "<p>正式 &amp; &lt;b&gt;演练&lt;/b&gt;</p>",
    "in the appcast the notes are HTML-escaped");
  console.log("PASS: a formal release with only GH_TOKEN checks write access first, then uploads and commits the appcast with that same token");
}
