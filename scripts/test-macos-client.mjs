import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { macServerLockPath } from "./macos-server-lock.mjs";

assert.equal(process.platform, "darwin", "macOS-only regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "ash-macos-client-"));
const repo = join(temporary, "repo");
const binary = join(temporary, "client-tests");
const children = new Set();
const serverPids = new Set();
const lockPaths = new Set();
const fixturePids = new Set();
const logs = new Set();
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
mkdirSync(join(repo, "scripts"), { recursive: true });
mkdirSync(join(repo, "server/dist"), { recursive: true });
copyFileSync(join(root, "scripts/start-detached.mjs"), join(repo, "scripts/start-detached.mjs"));
copyFileSync(join(root, "scripts/macos-server-lock.mjs"), join(repo, "scripts/macos-server-lock.mjs"));

const build = spawnSync("swiftc", ["-swift-version", "5",
  ...["AshHealth", "DownloadTransaction", "ServerStartLock", "ServerLauncher"].map((name) => join(root, `desktop/macos/Sources/${name}.swift`)),
  join(root, "desktop/macos/Tests/main.swift"), "-o", binary], { encoding: "utf8" });
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
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
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

function serviceSource(body) {
  writeFileSync(join(repo, "server/dist/index.js"), body);
}

function collectServers() {
  const marker = join(repo, "started");
  if (existsSync(marker)) {
    for (const pid of readFileSync(marker, "utf8").trim().split("\n").map(Number)) {
      if (pid > 1) serverPids.add(pid);
    }
  }
}

async function stopServers() {
  collectServers();
  for (const pid of serverPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await delay(150);
  for (const pid of serverPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  serverPids.clear();
  rmSync(join(repo, "started"), { force: true });
}

try {
  const port = await freePort();
  logs.add(`/tmp/ash-${port}.log`);
  const journal = join(temporary, "journal");
  const env = { ASH_TEST_REPO: repo, ASH_TEST_JOURNAL: journal, ASH_URL: `http://127.0.0.1:${port}` };
  const lock = macServerLockPath(repo, port);
  lockPaths.add(lock);
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

  let healthStatus = 200;
  let healthBody = "";
  const fakeHealth = createHttpServer((request, response) => {
    response.statusCode = healthStatus;
    response.end(healthBody);
  });
  fakeHealth.listen(0, "127.0.0.1");
  await once(fakeHealth, "listening");
  const probe = async (status, body) => {
    healthStatus = status;
    healthBody = body;
    const probed = await launch(binary, ["health"], { ...env, ASH_URL: `http://127.0.0.1:${fakeHealth.address().port}` }).done;
    assert.equal(probed.status, 0, probed.output);
    return probed.output.trim();
  };
  try {
    assert.equal(await probe(200, "<h1>Bad Gateway</h1>"), "NOT READY", "an HTTP 200 error page is not a ready ash");
    assert.equal(await probe(200, JSON.stringify({ ok: false, pid: 1 })), "NOT READY", "ok:false is not ready");
    assert.equal(await probe(503, JSON.stringify({ ok: true, pid: 1 })), "NOT READY", "non-200 is not ready");
    assert.equal(await probe(200, JSON.stringify({ ok: true, pid: 1 })), "READY", "any healthy ash is ready, whoever started it");
  } finally {
    fakeHealth.closeAllConnections();
    await new Promise((done) => fakeHealth.close(done));
  }
  console.log("PASS: window recovery uses the launcher's health criterion, not bare HTTP 200");

  result = await launch(binary, ["lock"], env).done;
  assert.equal(result.output.trim(), lock, "Swift and restart use identical lock identity");
  const alias = join(temporary, "repo-alias");
  symlinkSync(repo, alias);
  assert.equal(macServerLockPath(alias, port), lock);
  assert.notEqual(macServerLockPath(repo, port + 1), lock);
  assert.notEqual(macServerLockPath(temporary, port), lock);
  result = await launch(binary, ["lock"], { ...env, ASH_TEST_REPO: alias }).done;
  assert.equal(result.output.trim(), lock, "symlink aliases share lock");

  serviceSource(`const fs=require('node:fs');const http=require('node:http');
fs.appendFileSync('started',process.pid+'\\n');
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,pid:process.pid}));}).listen(Number(process.env.PORT),'127.0.0.1');`);
  const unrelated = launch(process.execPath, ["-e", "setTimeout(()=>{},60000)", "/unrelated/scripts/restart.mjs"]);
  const first = launch(binary, ["start", "5"], env);
  const second = launch(binary, ["start", "5"], env);
  for (const launched of [first, second]) {
    result = await launched.done;
    assert.equal(result.status, 0, result.output);
  }
  collectServers();
  assert.equal(serverPids.size, 1, "concurrent GUI/headless launch starts one service");
  assert.equal((await fetch(`${env.ASH_URL}/api/health`)).status, 200);
  unrelated.child.kill();
  await unrelated.done;
  await stopServers();
  console.log("PASS: unrelated restart ignored; simultaneous launch creates one healthy detached service");

  const restartFixture = join(repo, "scripts/restart.mjs");
  const entered = join(temporary, "restart-entered");
  writeFileSync(restartFixture, `import {coordinateMacRestart} from './macos-server-lock.mjs';
import {writeFileSync} from 'node:fs';
coordinateMacRestart(${JSON.stringify(repo)}, ${port});
writeFileSync(${JSON.stringify(entered)},'entered');
setTimeout(()=>process.exit(1),1200);`);
  const restarting = launch(process.execPath, [restartFixture]);
  await until(() => existsSync(entered), "restart did not acquire lock");
  const duringRestart = launch(binary, ["start", "5"], env);
  await delay(300);
  assert.equal(existsSync(join(repo, "started")), false, "client must not launch while restart owns lock");
  assert.equal((await restarting.done).status, 1);
  result = await duringRestart.done;
  assert.equal(result.status, 0, result.output);
  await stopServers();
  console.log("PASS: failed restart releases coordination; waiting client redecides and starts service");

  const helper = join(repo, "scripts/start-detached.mjs");
  const originalHelper = readFileSync(helper, "utf8");
  const launchEntered = join(temporary, "launch-entered");
  writeFileSync(helper, originalHelper.replace("const log =", `
(await import('node:fs')).writeFileSync(${JSON.stringify(launchEntered)},'entered');
await new Promise(resolveDelay=>setTimeout(resolveDelay,800));
const log =`));
  rmSync(entered, { force: true });
  const clientFirst = launch(binary, ["start", "5"], env);
  await until(() => existsSync(launchEntered), "client did not enter locked launch");
  const restartSecond = launch(process.execPath, [restartFixture]);
  await delay(200);
  assert.equal(existsSync(entered), false, "restart must wait for client's locked launch");
  result = await clientFirst.done;
  assert.equal(result.status, 0, result.output);
  await until(() => existsSync(entered), "restart did not acquire lock after client finished");
  assert.equal((await restartSecond.done).status, 1);
  writeFileSync(helper, originalHelper);
  await stopServers();
  console.log("PASS: reverse ordering also serializes restart after the client's launch");

  rmSync(entered, { force: true });
  const held = launch("/usr/bin/lockf", ["-k", lock, process.execPath, "-e",
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
  result = await launch(binary, ["start", "5"], env).done;
  assert.equal(result.status, 0, result.output);
  await stopServers();
  console.log("PASS: lock timeout is failure, not success; explicit retry recovers");

  serviceSource("require('node:fs').appendFileSync('started',process.pid+'\\n');process.exit(1)");
  result = await launch(binary, ["coalesce"], env).done;
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(join(repo, "started"), "utf8").trim().split("\n").length, 1);
  await stopServers();
  console.log("PASS: repeated launch requests coalesce and all callbacks receive failure");

  serviceSource(`const fs=require('node:fs');const http=require('node:http');
fs.appendFileSync('started',process.pid+'\\n');
http.createServer((req,res)=>res.end(JSON.stringify({ok:true,pid:process.pid+1}))).listen(Number(process.env.PORT),'127.0.0.1');`);
  result = await launch(binary, ["start", "1"], env).done;
  assert.equal(result.status, 1, "health from another PID cannot confirm the launched process");
  await stopServers();
  console.log("PASS: startup readiness checks the launched service PID");

  writeFileSync(join(repo, "scripts/start-detached.mjs"), "console.error('injected launcher diagnostic');process.exit(7)");
  result = await launch(binary, ["start", "1"], env).done;
  assert.equal(result.status, 1);
  assert.match(result.output, /injected launcher diagnostic/);
  const diagnostic = result.output.match(/启动器日志：(\/tmp\/ash-mac-launch-[^\s]+)/)?.[1];
  if (diagnostic) logs.add(diagnostic);
  console.log("PASS: launcher stderr is visible in failure result");
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const pid of fixturePids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await stopServers();
  for (const lock of lockPaths) rmSync(lock, { force: true });
  for (const log of logs) rmSync(log, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
