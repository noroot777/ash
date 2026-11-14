// mac app 的定点回归（仅 macOS）。编进测试驱动的是真的 AshConfig / AshHealth / ServerLauncher /
// DataImport，配置全走环境变量：临时数据根、临时端口、一份假的「自带运行时」（node 就是跑这个
// 测试的 node，server 是几行假服务），日常那一份 app 的数据与 :4317 一概不碰。
//
// 覆盖：下载事务；红绿灯下的页面；「端口上是谁」的判据（自己那份 / 别的 ash / 不是 ash）；空数据根
// 不起服务、首启选了才起；起服务用自带 node、数据根/端口/窗口专用端口/本机自用开关传对（终端配置盖不掉）、不漏启动器自己的变量；
// 别的 ash 或别的程序占着端口时不起、说清是谁；窗口只连专用端口、在线后服务换了人就撤下页面（导航与定时两道）；并发起服务只起一份；锁超时与重试；请求合并；
// 进程起来就退时不干等；应答的 PID 对不上不算；启动器报错可见；运行时缺件；构建号严格递增；安装不换正被用着的旧包；导入旧数据（WAL 里
// 没落盘的写入也带过来、在暂存里洗过再发布、和起服务同一把锁、只往空数据根里放、失败与抢跑不留
// 痕迹、上次发布到一半的残留先收掉、只复制不动源、互相包含与多人库拒绝、锁与缓存不搬）。
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
import { testInstanceGuard } from "./macos-client-guard.mjs";
import { testInstall } from "./macos-client-install.mjs";

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
  ...["AshConfig", "AshHealth", "DataImport", "DownloadTransaction", "ServerStartLock", "ServerLauncher", "WindowChrome",
    "BrowserWindowController", "WebViewBridge", "LaunchFlow", "OfflineView", "HostMcpSetup"]
    .map((name) => join(root, `desktop/macos/Sources/${name}.swift`)),
  ...["main", "WindowChromeProbe", "InstanceGuardProbe"].map((name) => join(root, `desktop/macos/Tests/${name}.swift`)),
  "-o", binary], { encoding: "utf8" });
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
  port:process.env.PORT??null,windowPort:process.env.ASH_WINDOW_PORT??null,leaked:Object.keys(process.env).filter(k=>k.startsWith('ASH_MAC_'))}));
${exitAtOnce ? "process.exit(1);" : ""}
fs.writeFileSync(path.join(dataDir,'ash.db'),'');
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');
res.end(JSON.stringify({ok:true,pid:process.pid+${pidOffset},instance:{id:'svc-'+process.pid,dataDir,codeDir:path.resolve(__dirname,'../..'),
  localOnly:process.env.ASH_LOCAL_ONLY==='1',windowPort:Number(process.env.ASH_WINDOW_PORT)}}));})
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
  const windowPort = await freePort();
  const journal = join(temporary, "journal");
  const env = {
    ASH_URL: `http://127.0.0.1:${port}`, ASH_DATA_DIR: data, ASH_MAC_RUNTIME: runtime, ASH_MAC_DOWNLOAD_JOURNAL: journal,
    ASH_MAC_WINDOW_PORT: String(windowPort),
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
  const runtimeAlias = join(temporary, "runtime-alias");
  symlinkSync(runtime, runtimeAlias);
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
    const ours = { id: "inst-1", dataDir: `${dataAlias}/`, codeDir: `${runtimeAlias}/`, localOnly: true, windowPort };
    assert.equal(await probe(200, { ok: true, pid: 1, instance: ours }), "READY",
      "same data root and same bundled code by realpath, local-only");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { ...ours, codeDir: "/repo/" } }), "FOREIGN",
      "a checkout serving the app's data root is not the app's service");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { ...ours, localOnly: false } }), "FOREIGN",
      "the bundled code without local-only mode was not started by the app");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { dataDir: ours.dataDir, codeDir: ours.codeDir } }), "FOREIGN",
      "an ash that does not report its mode is not ours");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { ...ours, id: undefined } }), "FOREIGN",
      "an ash without an instance id cannot be bound to, so it is not ours");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { ...ours, windowPort: null } }), "FOREIGN",
      "our service that could not listen on the window's dedicated port cannot serve the window");
    assert.equal(await probe(200, { ok: true, pid: 1, instance: { ...ours, windowPort: windowPort + 1 } }), "FOREIGN",
      "a dedicated port other than the one the app derives is not this app's");

    // 仓库里的服务指着 app 的数据根：一样不连，说清哪一样对不上。
    healthBody = JSON.stringify({ ok: true, pid: 4343, instance: { ...ours, codeDir: "/Users/someone/code/ash/", localOnly: false } });
    result = await launch(binary, ["start", "2"], env).done;
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /用的是 app 的数据，跑的却不是 app 自带的代码/);

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
  console.log("PASS: own instance is recognised by data root + bundled code + local-only; another ash or a non-ash on the port is reported, never joined");

  // ── 窗口在线之后服务换了人（scripts/macos-client-guard.mjs）──
  await testInstanceGuard({ binary, env, port, windowPort, data, runtime, children, until });
  console.log("PASS: an online window talks only to its service's dedicated port (nothing reaches whoever takes over 4317), binds every request to the confirmed instance, re-checks on navigation and while idle, rebinds after our own restart, and restores the route");

  // ── 空数据根：无窗口那一档不起，首启选了才起 ──
  serviceSource();
  result = await launch(binary, ["start", "3"], env).done;
  assert.equal(result.status, 3, result.output);
  assert.equal(existsSync(marker), false, "an empty data root waits for the first-run choice");

  // 终端配置里给开发实例 export 过数据根、端口、模式，还有 `alias cd=…`：起服务照样用 app 定下的那几样。
  const shellHome = join(temporary, "shell-home");
  mkdirSync(shellHome);
  const rc = `export ASH_DATA_DIR=${join(temporary, "dev-data")} PORT=1 ASH_LOCAL_ONLY=0 ASH_WINDOW_PORT=1\nalias cd=false\n`;
  for (const name of [".zprofile", ".zshrc", ".bash_profile", ".bashrc"]) writeFileSync(join(shellHome, name), rc);
  const shellEnv = { ...env, HOME: shellHome };
  const first = launch(binary, ["start-fresh", "8"], shellEnv);
  const second = launch(binary, ["start-fresh", "8"], shellEnv);
  for (const launched of [first, second]) {
    result = await launched.done;
    assert.equal(result.status, 0, result.output);
  }
  collectServers();
  assert.equal(serverPids.size, 1, "concurrent GUI/headless launch starts one service");
  const serverEnv = JSON.parse(readFileSync(seen, "utf8"));
  assert.equal(serverEnv.dataDir, data, "data root is handed to the server, whatever the shell rc exported");
  assert.equal(serverEnv.localOnly, "1", "the app always starts the local-only mode");
  assert.equal(serverEnv.port, String(port));
  assert.equal(serverEnv.windowPort, String(windowPort), "the window's dedicated port is handed to the server");
  assert.equal(existsSync(join(temporary, "dev-data")), false, "the dev data root from the rc is never touched");
  assert.deepEqual(serverEnv.leaked, [], "launcher variables never reach the server");
  assert.equal(realpathSync(serverEnv.cwd), realpathSync(data), "server runs in the data root, not in some checkout");
  result = await launch(binary, ["start", "3"], env).done;
  assert.equal(result.status, 0, "once initialised and running, the headless path just confirms it");
  collectServers();
  assert.equal(serverPids.size, 1);
  await stopServers();
  console.log("PASS: empty data root waits for first run; one detached service with data root, port, local-only flag fixed at exec and clean env");

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
  result = await launch(binary, ["start", "8"], env).done;
  assert.equal(result.status, 0, result.output);
  await stopServers();
  console.log("PASS: lock timeout is failure, not success; explicit retry recovers");

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

  // ── 构建号：同一秒、时钟回拨、并发构建都拿到严格更大的号 ──
  const book = join(temporary, "build-number");
  writeFileSync(book, "");
  const allocate = (clock) => launch("/usr/bin/lockf", ["-k", book, process.execPath, join(root, "desktop/macos/scripts/build-number.mjs"), book],
    clock ? { ASH_MAC_BUILD_CLOCK: clock } : {}).done.then((r) => { assert.equal(r.status, 0, r.output); return r.output.trim(); });
  const numbers = [await allocate("2026-11-14T09:05:12Z"), await allocate("2026-11-14T09:05:12Z"), await allocate("2026-11-13T23:00:00Z")];
  assert.deepEqual(numbers, ["20261114.090512", "20261114.090513", "20261114.090514"], "same second and a clock gone back still go up");
  numbers.push(...await Promise.all(Array.from({ length: 8 }, () => allocate())));
  const key = (n) => n.split(".").map(Number);
  const ordered = [...numbers].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
  assert.equal(new Set(numbers).size, numbers.length, "concurrent builds never share a number");
  assert.deepEqual(numbers.slice(0, 3), ordered.slice(0, 3));
  assert.equal(readFileSync(book, "utf8").trim(), ordered.at(-1), "the book keeps the largest number handed out");
  console.log("PASS: build numbers strictly increase across same-second, backdated and concurrent builds");

  // ── 安装：旧 bundle 还有进程在用就不换（scripts/macos-client-install.mjs）──
  await testInstall({ root, temporary, launch, children, until, delay });
  console.log("PASS: install refuses while anything still runs from the old bundle (ash entries by the code lock they hold, others by real file identity, whatever path spelling started them); an entry started mid-swap waits on the lock and then runs the whole new bundle; dead holders never block; no lock, no run and no install; keeps the old app on failure, serialises racing installs, still replaces a lockless older bundle");

  // ── 导入旧数据 ──
  // 假的洗副本工具：记下参数，在它拿到的库上留个记号，按约定回一行 JSON；摆了 import-fail 就失败。
  const toolSeen = join(temporary, "import-tool.json");
  writeFileSync(join(runtime, "server/dist/import-snapshot-cli.js"), `const fs=require('node:fs');const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');const [db,target,...sources]=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(toolSeen)},JSON.stringify({db,target,sources}));
if(fs.existsSync(path.join(__dirname,'import-fail'))){console.error('injected import tool failure');process.exit(1);}
const d=new DatabaseSync(db);d.exec("create table washed(by text); insert into washed values('import-tool')");d.close();
console.log(JSON.stringify({held:{tasks:2,schedules:1},relocated:3}));`);
  const source = join(temporary, "old-data");
  mkdirSync(join(source, "runs", "task-1"), { recursive: true });
  mkdirSync(join(source, "uploads"), { recursive: true });
  for (const dir of ["deps/cache", "tmp", "logs", "downloads"]) mkdirSync(join(source, dir), { recursive: true });
  writeFileSync(join(source, "runs", "task-1", "transcript.jsonl"), "line\n");
  writeFileSync(join(source, "uploads", "a.png"), "png");
  writeFileSync(join(source, "logs", "server.log"), "the source's own log");
  writeFileSync(join(source, "ash.db.exits.jsonl"), "{}\n");
  writeFileSync(join(source, "ash.db.ash-online.123.json"), "{}");
  // 源库开着、WAL 模式、最后几笔还在 WAL 里没落进主文件 —— 跟正在跑的那份 server 一样。
  const live = new DatabaseSync(join(source, "ash.db"));
  live.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0;");
  live.exec("create table app_settings (key text primary key, value text); create table tasks (id text primary key)");
  live.exec(`insert into app_settings values ('instanceMode', '"single"')`);
  for (let i = 0; i < 50; i += 1) live.exec(`insert into tasks values ('t${i}')`);
  writeFileSync(join(source, "ash.db.ash.lock"), JSON.stringify({ pid: process.pid, port: 4317, token: "x" }));
  const before = readdirSync(source).sort();
  const listing = () => readdirSync(data).filter((name) => name !== ".mac-launch.lock").sort();
  const stagings = () => readdirSync(data).filter((name) => name.startsWith(".import-staging-"));

  rmSync(data, { recursive: true, force: true });
  mkdirSync(join(data, "logs"), { recursive: true });
  writeFileSync(join(data, "logs", "login.log"), "the app's own log");
  result = await launch(binary, ["import-inspect", source], env).done;
  assert.equal(result.output.trim(), `OK live=${process.pid}`, "a source still opened by a server is reported");

  // 认不出来的东西不碰：数据根里有别的文件就拒绝，一样不动。
  writeFileSync(join(data, "notes.txt"), "someone's file");
  result = await launch(binary, ["import", source], env).done;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /已经有别的东西（notes\.txt）/);
  assert.deepEqual(listing(), ["logs", "notes.txt"], "a refused import leaves nothing behind");
  rmSync(join(data, "notes.txt"));

  // 洗副本失败：整次作罢，数据根里没有库、没有暂存。
  writeFileSync(join(runtime, "server/dist/import-fail"), "");
  result = await launch(binary, ["import", source], env).done;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /injected import tool failure/);
  assert.deepEqual(listing(), ["logs"], "a failed import leaves the data root as it was");
  rmSync(join(runtime, "server/dist/import-fail"));

  // 起服务那一处拿着锁：等不到就作罢。
  const launchLock = join(data, ".mac-launch.lock");
  const lockEntered = join(temporary, "import-lock-entered");
  const holdLock = () => {
    rmSync(lockEntered, { force: true });
    const holder = launch("/usr/bin/lockf", ["-k", launchLock, process.execPath, "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(lockEntered)},String(process.pid));setTimeout(()=>{},60000)`]);
    return holder;
  };
  let holder = holdLock();
  await until(() => existsSync(lockEntered), "import lock fixture did not acquire lock");
  let holderPid = Number(readFileSync(lockEntered, "utf8"));
  fixturePids.add(holderPid);
  result = await launch(binary, ["import", source, "0.5"], env).done;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /等它超时/);
  assert.equal(existsSync(join(data, "ash.db")), false);
  assert.deepEqual(stagings(), [], "the staged copy is cleaned up");

  // 暂存期间另一处「全新开始」先建好了数据：锁里重查，作罢，那份数据一个字节不碰。
  rmSync(toolSeen, { force: true });
  const racing = launch(binary, ["import", source, "20"], env);
  await until(() => existsSync(toolSeen), "import did not reach the publish step");
  writeFileSync(join(data, "ash.db"), "fresh");
  mkdirSync(join(data, "uploads"));
  writeFileSync(join(data, "uploads", "fresh.png"), "fresh upload");
  process.kill(holderPid, "SIGTERM");
  await holder.done;
  fixturePids.delete(holderPid);
  result = await racing.done;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /已经有一份 ash 数据/);
  assert.equal(readFileSync(join(data, "ash.db"), "utf8"), "fresh", "the data a fresh start created is kept");
  assert.deepEqual(readdirSync(join(data, "uploads")), ["fresh.png"], "nothing of the import is mixed into it");
  assert.equal(existsSync(join(data, "runs")), false);
  assert.deepEqual(stagings(), []);
  rmSync(join(data, "ash.db"));
  rmSync(join(data, "uploads"), { recursive: true });

  // 上一次发布到一半（清单在、条目挪了一部分、库没落）和死掉的进程留下的暂存：先收掉再导。
  mkdirSync(join(data, "runs", "other-task"), { recursive: true });
  writeFileSync(join(data, "runs", "other-task", "x"), "from another source, never committed");
  writeFileSync(join(data, ".import-publishing.json"), JSON.stringify(["runs", "../escape"]));
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  const abandoned = join(data, `.import-staging-${dead.stdout.trim()}-old`);
  mkdirSync(abandoned);
  result = await launch(binary, ["import", source], env).done;
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /held=schedules:1,tasks:2 relocated=3/, "what the import held is reported");
  assert.equal(readFileSync(join(data, "runs", "task-1", "transcript.jsonl"), "utf8"), "line\n");
  assert.equal(readFileSync(join(data, "uploads", "a.png"), "utf8"), "png");
  assert.equal(existsSync(join(data, "runs", "other-task")), false, "leftovers of an unfinished publish are not mixed in");
  assert.equal(existsSync(abandoned), false, "staging left by a dead import is collected");
  assert.equal(readFileSync(join(data, "logs", "login.log"), "utf8"), "the app's own log", "the app's own files stay");
  assert.equal(existsSync(join(data, "logs", "server.log")), false, "the source's logs are not carried over");
  for (const skipped of ["deps", "tmp", "downloads", "ash.db.ash.lock", "ash.db.ash-online.123.json", "ash.db-wal", "ash.db-shm",
    ".import-publishing.json"]) {
    assert.equal(existsSync(join(data, skipped)), false, `${skipped} is not in the published data root`);
  }
  assert.deepEqual(stagings(), []);
  const tool = JSON.parse(readFileSync(toolSeen, "utf8"));
  assert.match(tool.db, /\/\.import-staging-\d+-[^/]+\/ash\.db$/, "the copy is washed in staging, before it is published");
  assert.equal(realpathSync(tool.target), realpathSync(data), "paths are relocated to the app's data root");
  assert.ok(tool.sources.includes(source) && tool.sources.includes(realpathSync(source)), "both the chosen and the real source path");
  const copied = new DatabaseSync(join(data, "ash.db"), { readOnly: true });
  assert.equal(copied.prepare("select count(*) as n from tasks").get().n, 50, "writes still in the WAL come along");
  assert.equal(copied.prepare("select by from washed").get().by, "import-tool", "the published database is the washed one");
  assert.equal(copied.prepare("pragma journal_mode").get().journal_mode, "delete", "published as a single file");
  copied.close();
  assert.deepEqual(readdirSync(source).sort(), before, "the source directory is left as it was");
  live.exec("insert into tasks values ('after')");
  assert.equal(live.prepare("select count(*) as n from tasks").get().n, 51, "the source server keeps writing");
  live.close();
  assert.equal(existsSync(join(source, "ash.db-shm")), false, "fixture: the source ash stopped cleanly");
  result = await launch(binary, ["import", source], env).done;
  assert.match(result.output, /已经有一份 ash 数据/, "an initialised data root never takes a second import");
  // 源实例正常停掉（-wal、-shm 都收了）之后也导得了，源目录仍旧不多一个文件。
  const stoppedTarget = join(temporary, "data-from-stopped");
  const stoppedBefore = readdirSync(source).sort();
  result = await launch(binary, ["import", source], { ...env, ASH_DATA_DIR: stoppedTarget }).done;
  assert.equal(result.status, 0, result.output);
  const fromStopped = new DatabaseSync(join(stoppedTarget, "ash.db"), { readOnly: true });
  assert.equal(fromStopped.prepare("select count(*) as n from tasks").get().n, 51, "a stopped source is read whole");
  fromStopped.close();
  assert.deepEqual(readdirSync(source).sort(), stoppedBefore, "reading a stopped source leaves no -shm behind");

  result = await launch(binary, ["import", source], { ...env, ASH_DATA_DIR: source }).done;
  assert.match(result.output, /app 自己的数据目录/);
  result = await launch(binary, ["import-inspect", source], { ...env, ASH_DATA_DIR: join(source, "nested") }).done;
  assert.match(result.output, /一个在另一个里面/, "a data root inside the source is refused");
  result = await launch(binary, ["import-inspect", join(dataAlias, "runs")], env).done;
  assert.match(result.output, /没有 ash\.db/);
  const inner = join(data, "inner-old");
  mkdirSync(inner);
  copyFileSync(join(data, "ash.db"), join(inner, "ash.db"));
  result = await launch(binary, ["import-inspect", inner], env).done;
  assert.match(result.output, /一个在另一个里面/, "a source inside the data root is refused");
  rmSync(inner, { recursive: true });
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
  console.log("PASS: import stages a consistent, washed snapshot and publishes it under the launch lock only into an empty data root; "
    + "failures, a racing fresh start and lock timeouts leave nothing behind; leftovers of an unfinished publish are collected; nested roots, multi-user data refused");
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const pid of fixturePids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await stopServers();
  rmSync(temporary, { recursive: true, force: true });
}
