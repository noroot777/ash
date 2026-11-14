// mac app 的定点回归（仅 macOS）。编进测试驱动的是真的 AshConfig / AshHealth / ServerLauncher /
// DataImport，配置全走环境变量：临时数据根、临时端口、一份假的「自带运行时」（node 就是跑这个
// 测试的 node，server 是几行假服务），日常那一份 app 的数据与 :4317 一概不碰。
//
// 覆盖：下载事务；红绿灯下的页面；「端口上是谁」的判据（自己那份 / 别的 ash / 不是 ash）；空数据根
// 不起服务、首启选了才起；起服务用自带 node、数据根与本机自用开关传对、不漏启动器自己的变量；
// 别的 ash 或别的程序占着端口时不起、说清是谁；并发起服务只起一份；锁超时与重试；请求合并；
// 进程起来就退时不干等；应答的 PID 对不上不算；启动器报错可见；运行时缺件；导入旧数据（WAL 里
// 没落盘的写入也带过来、只复制不动源、多人库拒绝、锁与缓存不搬、上次没导完的残留被换掉）。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "macOS-only regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "ash-macos-client-"));
const runtime = join(temporary, "runtime");
const data = join(temporary, "data");
const binary = join(temporary, "client-tests");
const children = new Set();
const serverPids = new Set();
const fixturePids = new Set();
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

// 假的「自带运行时」：布局与 bundle-runtime.mjs 装出来的一致。
mkdirSync(join(runtime, "node/bin"), { recursive: true });
mkdirSync(join(runtime, "scripts"), { recursive: true });
mkdirSync(join(runtime, "server/dist"), { recursive: true });
symlinkSync(process.execPath, join(runtime, "node/bin/node"));
copyFileSync(join(root, "scripts/start-detached.mjs"), join(runtime, "scripts/start-detached.mjs"));

const build = spawnSync("swiftc", ["-swift-version", "5",
  ...["AshConfig", "AshHealth", "DataImport", "DatabaseBackup", "DownloadTransaction", "ServerControl", "ServerStartLock", "ServerLauncher", "WindowChrome"]
    .map((name) => join(root, `desktop/macos/Sources/${name}.swift`)),
  ...["main", "WindowChromeProbe"].map((name) => join(root, `desktop/macos/Tests/${name}.swift`)), "-o", binary], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function launch(command, args, env = {}) {
  const base = { ...process.env };
  for (const key of ["ASH_DATA_DIR", "ASH_URL", "ASH_LOCAL_ONLY", "PORT"]) delete base[key];
  const child = spawn(command, args, { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const done = new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      children.delete(child);
      resolveResult({ status, signal, output });
    });
  });
  return { child, done, output: () => output };
}

async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  assert.fail(message);
}

const marker = join(temporary, "started");
const seen = join(temporary, "server-env.json");

/** 假服务：记下自己的 pid 和看到的环境，像真 server 一样在数据根里建库，按 health 协议应答。 */
function serviceSource({ pidOffset = 0, exitAtOnce = false } = {}) {
  writeFileSync(join(runtime, "server/dist/index.js"), `const fs=require('node:fs');const http=require('node:http');const path=require('node:path');
fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');
const dataDir=process.env.ASH_DATA_DIR;
fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({cwd:process.cwd(),dataDir,localOnly:process.env.ASH_LOCAL_ONLY??null,
  port:process.env.PORT??null,leaked:Object.keys(process.env).filter(k=>k.startsWith('ASH_MAC_'))}));
${exitAtOnce ? "process.exit(1);" : ""}
fs.writeFileSync(path.join(dataDir,'ash.db'),'');
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');
res.end(JSON.stringify({ok:true,pid:process.pid+${pidOffset},instance:{dataDir,codeDir:path.resolve(__dirname,'../..')}}));})
.listen(Number(process.env.PORT),'127.0.0.1');`);
}

function collectServers() {
  if (!existsSync(marker)) return;
  for (const pid of readFileSync(marker, "utf8").trim().split("\n").map(Number)) {
    if (pid > 1) serverPids.add(pid);
  }
}

async function stopServers() {
  collectServers();
  for (const pid of serverPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await delay(150);
  for (const pid of serverPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  serverPids.clear();
  rmSync(marker, { force: true });
}

/** 端口上摆一个假的应答者，跑完 body 再撤。 */
async function withResponder(port, respond, body) {
  const server = createHttpServer(respond);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  try {
    return await body();
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

try {
  const port = await freePort();
  const journal = join(temporary, "journal");
  const env = {
    ASH_URL: `http://127.0.0.1:${port}`, ASH_DATA_DIR: data, ASH_MAC_RUNTIME: runtime, ASH_MAC_DOWNLOAD_JOURNAL: journal,
  };

  // ── 下载事务 ──
  const destination = join(temporary, "export.md");
  let result = await launch(binary, ["transactions", destination], env).done;
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(readdirSync(journal), [], "finished and failed transactions leave no journal entry");
  const staged = () => readdirSync(temporary).filter((name) => name.startsWith(".ash-download-"));
  assert.deepEqual(staged(), [], "finished and failed transactions leave no staging directory");
  writeFileSync(destination, "original");
  const pending = launch(binary, ["pending", destination], env);
  await until(() => pending.output().includes("PENDING"), "download fixture did not stage");
  result = await launch(binary, ["reclaim"], env).done;
  assert.equal(result.status, 0, result.output);
  assert.equal(staged().length, 1, "reclaim must not touch a download another instance is still writing");
  assert.equal(readdirSync(journal).length, 1, "live transaction keeps its journal entry");
  pending.child.kill("SIGKILL");
  await pending.done;
  assert.equal(readFileSync(destination, "utf8"), "original", "app exit preserves original");
  assert.equal(staged().length, 1, "killed download leaves its staging directory behind");
  result = await launch(binary, ["reclaim"], env).done;
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(staged(), [], "next launch reclaims the abandoned staging directory");
  assert.deepEqual(readdirSync(journal), [], "reclaimed transaction is forgotten");
  assert.equal(readFileSync(destination, "utf8"), "original", "reclaim preserves original");
  console.log("PASS: download success, failure, failed commit and process exit preserve originals");

  const victim = join(temporary, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep"), "keep");
  writeFileSync(join(journal, "11111111-1111-1111-1111-111111111111"), victim);
  writeFileSync(join(journal, "22222222-2222-2222-2222-222222222222"), "");
  const unplugged = join(journal, "33333333-3333-3333-3333-333333333333");
  writeFileSync(unplugged, join(temporary, "unplugged-volume", ".ash-download-33333333-3333-3333-3333-333333333333"));
  result = await launch(binary, ["reclaim"], env).done;
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(join(victim, "keep"), "utf8"), "keep", "a journal entry cannot make reclaim delete a foreign path");
  assert.deepEqual(readdirSync(journal), ["33333333-3333-3333-3333-333333333333"],
    "malformed entries are dropped; an unreachable destination folder keeps its entry for a later launch");
  const longAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  utimesSync(unplugged, longAgo, longAgo);
  result = await launch(binary, ["reclaim"], env).done;
  assert.deepEqual(readdirSync(journal), [], "an entry unreachable for a month is given up");
  console.log("PASS: reclaim spares live downloads, collects killed ones, ignores malformed entries, expires unreachable ones");

  // 探针窗口摆在屏幕外、不激活应用；页面是内联的，不碰任何服务。
  result = await launch(binary, ["chrome"], env).done;
  assert.equal(result.status, 0, result.output);
  console.log("PASS: page under the window controls keeps its clicks; empty title strip and marked bars drag the window; documents that never opted in keep the ordinary title bar");

  // ── 端口上是谁 ──
  mkdirSync(data, { recursive: true });
  const dataAlias = join(temporary, "data-alias");
  symlinkSync(data, dataAlias);
  let healthStatus = 200;
  let healthBody = "";
  const probe = async (status, body) => {
    healthStatus = status;
    healthBody = typeof body === "string" ? body : JSON.stringify(body);
    const probed = await launch(binary, ["health"], env).done;
    assert.equal(probed.status, 0, probed.output);
    return probed.output.trim();
  };
  await withResponder(port, (request, response) => {
    response.statusCode = healthStatus;
    response.end(healthBody);
  }, async () => {
    assert.equal(await probe(200, "<h1>Bad Gateway</h1>"), "NOT ASH", "an HTTP 200 error page is not ash");
    assert.equal(await probe(200, { ok: false, pid: 1 }), "NOT ASH", "ok:false is not a ready ash");
    assert.equal(await probe(503, { ok: true, pid: 1 }), "NOT ASH", "non-200 is not ready");
    assert.equal(await probe(200, { ok: true, pid: 1 }), "FOREIGN", "an ash that does not say where its data lives is not ours");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { dataDir: join(temporary, "elsewhere"), codeDir: "/repo/" } }),
      "FOREIGN", "another data root is another ash");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { dataDir: `${dataAlias}/`, codeDir: "/app/" } }),
      "READY", "same data root by realpath, whoever started it");

    // 被别的 ash 占着：不起、不连，说清是谁。
    healthBody = JSON.stringify({ ok: true, pid: 4242, instance: { dataDir: "/Users/someone/code/ash/data", codeDir: "/Users/someone/code/ash/" } });
    result = await launch(binary, ["start-fresh", "2"], env).done;
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /4242/);
    assert.match(result.output, /\/Users\/someone\/code\/ash\//);
    assert.match(result.output, /kill 4242/);
    healthBody = "<h1>nginx</h1>";
    result = await launch(binary, ["start-fresh", "2"], env).done;
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /不是 ash/);
    assert.equal(existsSync(marker), false, "an occupied port must not get a second service");
  });
  assert.equal(await probe(200, ""), "DOWN", "nobody listening");
  console.log("PASS: own instance is recognised by data root; another ash or a non-ash on the port is reported, never joined");

  // ── 空数据根：无窗口那一档不起，首启选了才起 ──
  serviceSource();
  result = await launch(binary, ["start", "3"], env).done;
  assert.equal(result.status, 3, result.output);
  assert.equal(existsSync(marker), false, "an empty data root waits for the first-run choice");

  const first = launch(binary, ["start-fresh", "8"], env);
  const second = launch(binary, ["start-fresh", "8"], env);
  for (const launched of [first, second]) {
    result = await launched.done;
    assert.equal(result.status, 0, result.output);
  }
  collectServers();
  assert.equal(serverPids.size, 1, "concurrent GUI/headless launch starts one service");
  const serverEnv = JSON.parse(readFileSync(seen, "utf8"));
  assert.equal(serverEnv.dataDir, data, "data root is handed to the server");
  assert.equal(serverEnv.localOnly, "1", "the app always starts the local-only mode");
  assert.equal(serverEnv.port, String(port));
  assert.deepEqual(serverEnv.leaked, [], "launcher variables never reach the server");
  assert.equal(realpathSync(serverEnv.cwd), realpathSync(data), "server runs in the data root, not in some checkout");
  result = await launch(binary, ["start", "3"], env).done;
  assert.equal(result.status, 0, "once initialised and running, the headless path just confirms it");
  collectServers();
  assert.equal(serverPids.size, 1);
  await stopServers();
  console.log("PASS: empty data root waits for first run; one detached service with data root, local-only flag and clean env");

  // ── 锁超时与重试（数据根里已经有库了）──
  const lockFile = join(data, ".mac-launch.lock");
  const entered = join(temporary, "lock-entered");
  const held = launch("/usr/bin/lockf", ["-k", lockFile, process.execPath, "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(entered)},String(process.pid));setTimeout(()=>{},60000)`]);
  await until(() => existsSync(entered), "timeout fixture did not acquire lock");
  const holderPID = Number(readFileSync(entered, "utf8"));
  fixturePids.add(holderPID);
  result = await launch(binary, ["start", "0.4"], env).done;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /超时/);
  process.kill(holderPID, "SIGTERM");
  await held.done;
  fixturePids.delete(holderPID);
  // 顺带：库在、却没有服务记录（导入来的、旧版 app 没写过）→ 起之前先备份并固定成恢复点；
  // 这一版的服务应答了（迁移跑完了）就放开它。
  rmSync(join(data, ".mac-server.json"), { force: true });
  result = await launch(binary, ["start", "8"], env).done;
  assert.equal(result.status, 0, result.output);
  assert.equal(readdirSync(join(data, "backups")).filter((n) => n.endsWith(".db")).length, 1, "backed up before starting on an unknown database");
  assert.equal(existsSync(join(data, "backups", "recovery-points.json")), false, "the recovery point is released once the service answers");
  await stopServers();
  console.log("PASS: lock timeout is failure, not success; explicit retry recovers; an unknown database is backed up first and released once up");

  // ── 进程起来就退：请求合并成一次，所有回调都拿到失败，不干等满时限 ──
  serviceSource({ exitAtOnce: true });
  const started = Date.now();
  result = await launch(binary, ["coalesce"], env).done;
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /起来就退出了/);
  assert.ok(Date.now() - started < 4500, "a service that died is reported before the timeout");
  assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
  await stopServers();
  console.log("PASS: repeated launch requests coalesce; a service that exits at once fails fast");

  serviceSource({ pidOffset: 1 });
  result = await launch(binary, ["start", "1"], env).done;
  assert.equal(result.status, 1, "health from another PID cannot confirm the launched process");
  await stopServers();
  console.log("PASS: startup readiness checks the launched service PID");

  writeFileSync(join(runtime, "scripts/start-detached.mjs"), "console.error('injected launcher diagnostic');process.exit(7)");
  result = await launch(binary, ["start", "1"], env).done;
  assert.equal(result.status, 1);
  assert.match(result.output, /injected launcher diagnostic/);
  rmSync(join(runtime, "scripts/start-detached.mjs"));
  result = await launch(binary, ["start", "1"], env).done;
  assert.equal(result.status, 1);
  assert.match(result.output, /不完整/);
  console.log("PASS: launcher stderr is visible in failure result; an incomplete bundle says so");

  // ── 导入旧数据 ──
  const source = join(temporary, "old-data");
  mkdirSync(join(source, "runs", "task-1"), { recursive: true });
  mkdirSync(join(source, "uploads"), { recursive: true });
  mkdirSync(join(source, "deps", "cache"), { recursive: true });
  mkdirSync(join(source, "tmp"), { recursive: true });
  writeFileSync(join(source, "runs", "task-1", "transcript.jsonl"), "line\n");
  writeFileSync(join(source, "uploads", "a.png"), "png");
  writeFileSync(join(source, "ash.db.exits.jsonl"), "{}\n");
  writeFileSync(join(source, "ash.db.ash-online.123.json"), "{}");
  writeFileSync(join(source, ".mac-maintenance.json"), JSON.stringify({ pid: process.pid, note: "源那边在装更新", since: 0 }));
  // 源库开着、WAL 模式、最后几笔还在 WAL 里没落进主文件 —— 跟正在跑的那份 server 一样。
  const live = new DatabaseSync(join(source, "ash.db"));
  live.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0;");
  live.exec("create table app_settings (key text primary key, value text); create table tasks (id text primary key)");
  live.exec(`insert into app_settings values ('instanceMode', '"single"')`);
  for (let i = 0; i < 50; i += 1) live.exec(`insert into tasks values ('t${i}')`);
  writeFileSync(join(source, "ash.db.ash.lock"), JSON.stringify({ pid: process.pid, port: 4317, token: "x" }));
  const before = readdirSync(source).sort();

  rmSync(data, { recursive: true, force: true });
  mkdirSync(join(data, "runs"), { recursive: true });
  writeFileSync(join(data, "runs", "stale"), "from an import that never finished");
  result = await launch(binary, ["import-inspect", source], env).done;
  assert.equal(result.output.trim(), `OK live=${process.pid}`, "a source still opened by a server is reported");
  result = await launch(binary, ["import", source], env).done;
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(join(data, "runs", "task-1", "transcript.jsonl"), "utf8"), "line\n");
  assert.equal(readFileSync(join(data, "uploads", "a.png"), "utf8"), "png");
  assert.equal(existsSync(join(data, "runs", "stale")), false, "leftovers of an unfinished import are replaced");
  for (const skipped of ["deps", "tmp", "ash.db.ash.lock", "ash.db.ash-online.123.json", ".mac-maintenance.json", "ash.db-wal", "ash.db-shm", "ash.db.importing",
    "ash.db.importing-wal", "ash.db.importing-shm"]) {
    assert.equal(existsSync(join(data, skipped)), false, `${skipped} is not carried over`);
  }
  const copied = new DatabaseSync(join(data, "ash.db"), { readOnly: true });
  assert.equal(copied.prepare("select count(*) as n from tasks").get().n, 50, "writes still in the WAL come along");
  copied.close();
  assert.deepEqual(readdirSync(source).sort(), before, "the source directory is left as it was");
  live.exec("insert into tasks values ('after')");
  assert.equal(live.prepare("select count(*) as n from tasks").get().n, 51, "the source server keeps writing");
  live.close();

  result = await launch(binary, ["import", source], { ...env, ASH_DATA_DIR: source }).done;
  assert.match(result.output, /app 自己的数据目录/);
  result = await launch(binary, ["import", join(temporary, "runtime")], env).done;
  assert.match(result.output, /没有 ash\.db/);
  const multi = join(temporary, "multi-data");
  mkdirSync(multi);
  const multiDb = new DatabaseSync(join(multi, "ash.db"));
  multiDb.exec(`create table app_settings (key text primary key, value text); insert into app_settings values ('instanceMode', '"multi"')`);
  multiDb.close();
  result = await launch(binary, ["import-inspect", multi], env).done;
  assert.equal(result.status, 1);
  assert.match(result.output, /多人模式/);
  console.log("PASS: import takes a consistent snapshot of a live WAL database, copies the rest, leaves the source alone, refuses multi-user data");
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const pid of fixturePids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await stopServers();
  rmSync(temporary, { recursive: true, force: true });
}
