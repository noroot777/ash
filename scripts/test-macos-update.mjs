// mac app 自更新的定点回归（仅 macOS）：装新版之前那道闸（UpdateGate）和发版脚本（release.mjs）。
//
// 闸：编进测试驱动的是真的 UpdateGate / RestartImpact / ServerShutdown / DatabaseBackup /
// ServerRecord；端口上摆一个假的 ash（独立进程，按 health 协议报 pid 和数据根，restart-impact
// 的答复从一个状态文件里读，收到 SIGTERM 才退），数据根里放一份 WAL 还没落盘的真 SQLite 库。
// 覆盖：没人会被打断 → 不问、停服务、备份、放行；会打断（判失败 + 握着 MCP，同一个任务只算
// 一次）→ 先问；选「等」→ 排空后自己放行；选「现在」→ 立刻放行；问不出来 → 当成会打断；
// 服务停不下来 → 不放行、不备份、松开启动闸；端口上是别的 ash → 不碰它；退出那一档的取消 /
// 等 / 现在；备份只留最近 5 份；旧版 app 起的服务认得出来。
//
// 发版：用演练密钥和一个假的 Ash.app 跑 `release.mjs --local`：zip 与 appcast 都验得过签、被篡改的
// 包与 appcast 验不过；同一版、更旧的版本拒发；app 里的公钥和签名私钥不是一对时拒发；第二版排在
// 第一版前面、第一版原样保留。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const env = { ...process.env, ASH_URL: `http://127.0.0.1:${port}`, ASH_DATA_DIR: data };
const impactFile = join(temporary, "impact.json");
const setImpact = (value) => writeFileSync(impactFile, typeof value === "string" ? value : JSON.stringify(value));
const clear = { survives: [{ id: "s", title: "接管得了的", pid: 1 }], resumes: [{ id: "lead", title: "调度台" }], interrupted: [], mcpDisrupted: [] };

/** 假 ash：独立进程，pid 就是它自己。stubborn = 不理 SIGTERM。 */
async function startFake({ dataDir = data, stubborn = false } = {}) {
  const source = `
    const http = require('node:http'); const fs = require('node:fs');
    ${stubborn ? "process.on('SIGTERM', () => {});" : ""}
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/restart-impact')) {
        const raw = fs.readFileSync(${JSON.stringify(impactFile)}, 'utf8');
        if (raw === 'refuse') { res.statusCode = 401; return res.end('{"error":"请先登录"}'); }
        return res.end(raw);
      }
      res.end(JSON.stringify({ ok: true, pid: process.pid, instance: { dataDir: ${JSON.stringify(dataDir)}, codeDir: '/fake/' } }));
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
  assert.match(result.out, /ASK .*问不出重启会打断哪些任务（服务端回 401）/);
  console.log("PASS: an unanswered impact question is treated as disruptive, not as none");

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

  // ── 备份只留最近 5 份 ──
  rmSync(join(data, "backups"), { recursive: true, force: true });
  result = await drive(["backups", "7"]);
  const kept = result.out.match(/KEPT (.*)/)[1].split(",");
  assert.equal(kept.length, 5, result.out);
  assert.deepEqual(kept.map((n) => n.split("-").pop()), ["v6.db", "v5.db", "v4.db", "v3.db", "v2.db"], "newest first, oldest dropped");
  assert.deepEqual(readdirSync(join(data, "backups")).sort(), [...kept].sort(), "no partial files left behind");
  db.close();
  console.log("PASS: backups are consistent snapshots, newest five kept");

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

  const second = join(feed, "Ash-0.2.0-20000101.0002.zip");
  const newest = appcast().match(/sparkle:edSignature="([^"]+)"/)[1];
  appendFileSync(second, "tampered");
  assert.notEqual(verify(second, newest), 0, "a tampered zip fails verification");
  writeFileSync(join(feed, "appcast.xml"), appcast().replace("20000101.0002</sparkle:version>", "20990101.0002</sparkle:version>"));
  assert.notEqual(verify(join(feed, "appcast.xml")), 0, "a tampered appcast fails verification");
  console.log("PASS: release --local signs zip and appcast, refuses re-releases, older versions and mismatched keys; tampering is detected");
}
