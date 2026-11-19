#!/usr/bin/env node
// 回归 upgrade.mjs:在临时目录里造一份「改名之前的安装」(旧版检出 + 带项目/任务/会话的 ash.db + 跑着的旧服务),
// 远端推新版,然后照用户的做法 `git pull && npm run upgrade`,一路钉住:
//   · 停服务之前能拦的都拦下、什么都不改(工作区脏、远端拉不动、两份库并存、有任务在跑);
//   · 一次走完:服务在新代码上起着,库改成 navi.db,升级前的每一条都还在,小结里的数字对得上;
//   · 再跑一次:已是最新、服务没被重启;
//   · 命令会更新自己:拉完代码之后跑的是新版的升级逻辑;
//   · 构建失败、新服务起不来:留下的状态和打印的退回命令,原样照抄能回到能用的状态;修好之后再跑接着做完;
//   · 库改名失败(目标名下已有东西;macOS 上再加一个改到一半失败的)照旧名起服务,其余照常升;
//   · --keep-db-name 升完库还叫 ash.db;
//   · 同一份检出同时只许一次升级;产物少了一个文件照样重建;数据没核对成不算升好、再跑先补核;已是最新也收拾 MCP 登记;
//     停服务之后写不进进度、新服务起得太慢,都给出照抄就能退回的命令。留底快照、核对认人、锁的交错、stop --pid 在 test-upgrade-units.mjs。
// 现场与假 server / 假 npm 在 test-upgrade-fixture.mjs。数据目录用改名之前的变量名 ASH_DATA_DIR 指到检出之外,
// 端口不设 PORT、让升级按锁文件里记的端口找。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_MOVED_MARKER } from "./db-file.mjs";
import { clearEnv } from "./env.mjs";
import { IS_WINDOWS, isPidAlive, localJson, sleep } from "./platform.mjs";
import { satisfiesRange } from "./runtime-check.mjs";
import { fakeCli, fakeNpm, git, publish, seedDb } from "./test-upgrade-fixture.mjs";
import { runTestProcess } from "./test-process.mjs";
import { disposeTestScopesSync, spawnTestFixture, terminateInstance } from "./test-process-scope.mjs";
import { parseUpgradeOptions, userArgs } from "./upgrade-options.mjs";
import { fileDigest } from "./upgrade-data.mjs";
import { rollbackCommands, shellArg } from "./upgrade-report.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PORT = 14361;

// ── 不起进程的几条 ────────────────────────────────────────────────────────────────
assert.equal(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts.upgrade, "node scripts/upgrade.mjs");
assert.equal(satisfiesRange("22.16.0", ">=22.16.0"), true);
assert.equal(satisfiesRange("22.15.9", ">=22.16.0"), false);
assert.equal(satisfiesRange("24.1.0", ">=22.16.0"), true);
assert.equal(satisfiesRange("11.10.0", ">=11.9.0"), true);
assert.equal(satisfiesRange("11.8.3", ">=11.9.0"), false);
assert.equal(satisfiesRange("22.0.0", "^22"), null, "认不出的范围不替人猜");
assert.deepEqual(parseUpgradeOptions([], {}), { force: false, wait: false, keepDbName: false, skipMcp: false, help: false, continue: false, pulledFrom: null });
assert.equal(parseUpgradeOptions(["--keep-db-name", "--wait"], {}).keepDbName, true);
assert.equal(parseUpgradeOptions([], { FORCE: "1", SKIP_MCP: "1" }).force, true);
assert.throws(() => parseUpgradeOptions(["--keep-db"], {}));
assert.throws(() => parseUpgradeOptions(["--pulled-from", "x; rm -rf /"], {}));
assert.deepEqual(userArgs(["--wait", "--continue", "--pulled-from", "abc1234", "--keep-db-name"]), ["--wait", "--keep-db-name"]);
const cmds = rollbackCommands({ from: "a".repeat(40), head: "b".repeat(40), port: 4317, serverRunning: true, renameBack: true, dataDir: "/d d" });
assert.deepEqual(cmds, ["node scripts/stop.mjs", "node scripts/rename-db.mjs --rollback --data '/d d'", `git reset --keep ${"a".repeat(40)}`, "node scripts/restart.mjs"]);
// 照抄进 shell 也还是原样:双引号包不住 `$USER`,单引号才包得住;路径里本身的单引号各按各的 shell 转义。
assert.equal(shellArg("/tmp/data$USER", false), "'/tmp/data$USER'");
assert.equal(shellArg("/it's", false), "'/it'\\''s'");
assert.equal(shellArg("C:\\it's dir", true), "'C:\\it''s dir'");
assert.equal(shellArg("C:\\plain\\dir", true), "C:\\plain\\dir");
assert.equal(shellArg("/a\\b", false), "'/a\\b'", "sh 里裸着的反斜杠会被吃掉");
// 刚起的服务还活着却没应答:stop.mjs 问不到它,按 pid 结束、等它真的退出(stop-pid.mjs;单测在 test-upgrade-units.mjs)。
for (const windows of [false, true]) {
  assert.deepEqual(rollbackCommands({ from: "a", head: "b", port: 4317, serverRunning: false, strayPid: 42, renameBack: false, dataDir: "/d", windows }),
    ["node scripts/stop.mjs --pid 42", "git reset --keep a", "node scripts/restart.mjs"]);
}
console.log("✓ 版本范围、参数、退回命令的形状");

// ── 现场 ──────────────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(realpathSync(tmpdir()), "navi-upgrade-test-"));
const REMOTE = join(TMP, "remote.git");
const DEV = join(TMP, "dev");
const INSTALL = join(TMP, "install");
const DATA = join(TMP, "data");
const NPM_LOG = join(TMP, "npm.log");
const SERVER = join(INSTALL, "server", "dist", "index.js");

/** 现在手上那个 detached 服务的实例凭据(停它只认这个,不按号码裸杀;理由见 test-restart.mjs 的 stopServer)。 */
let current = null;
process.on("exit", () => {
  if (current && isPidAlive(current.pid)) {
    const shot = terminateInstance(current);
    if (shot.error || (!shot.sent && !shot.requested)) { process.exitCode = 1; process.stderr.write(`⚠ 测试服务(${current.pid})没能停掉,请自行确认 :${PORT}\n`); }
    for (let i = 0; i < 50 && isPidAlive(current.pid); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  }
  try { disposeTestScopesSync(); } catch (error) { process.exitCode = 1; process.stderr.write(`${error.stack ?? error}\n`); }
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }); } catch (error) { process.exitCode = 1; process.stderr.write(`${error.stack ?? error}\n`); }
});

const env = { ...process.env };
for (const name of ["NAVI_DATA_DIR", "NAVI_DB", "NAVI_RUNS_DIR", "NAVI_LOG"]) clearEnv(env, name);
for (const name of ["PORT", "FORCE", "WAIT", "WAIT_TIMEOUT", "SERVER_ENTRY", "SERVER_NODE"]) delete env[name];
Object.assign(env, {
  PATH: join(TMP, "bin") + delimiter + process.env.PATH,
  HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "socks5://127.0.0.1:1",
  ASH_DATA_DIR: DATA,
  NAVI_LOG: join(TMP, "navi.log"),
  SKIP_MCP: "1",
  START_TIMEOUT: "10",
});

fakeNpm(join(TMP, "bin"), NPM_LOG);
git(TMP, "init", "-q", "--bare", REMOTE);
git(TMP, "clone", "-q", REMOTE, DEV);
const v1 = publish(DEV, "v1", { legacy: true });
const v2 = publish(DEV, "v2");
git(TMP, "clone", "-q", REMOTE, INSTALL);
git(INSTALL, "reset", "-q", "--hard", v1);
execFileSync(process.execPath, ["build.mjs"], { cwd: INSTALL });
seedDb(DATA);

const health = () => localJson(PORT, "/api/health");
const npmCalls = () => (existsSync(NPM_LOG) ? readFileSync(NPM_LOG, "utf8").split("\n").filter(Boolean) : []);
const head = () => git(INSTALL, "rev-parse", "HEAD");
const isMarker = (f) => existsSync(f) && readFileSync(f).subarray(0, DB_MOVED_MARKER.length).toString("latin1") === DB_MOVED_MARKER;

/** 跑一次升级。起了新服务的话,收下它的实例凭据。 */
async function upgrade(args, expected, extraEnv = {}) {
  const run = await runTestProcess(process.execPath, [join(INSTALL, "scripts", "upgrade.mjs"), ...args], {
    cwd: INSTALL, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 120_000, preserveScripts: [SERVER],
  }, expected);
  adopt(run);
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function adopt(run) {
  const fresh = run.preserved.find((i) => isPidAlive(i.pid));
  if (fresh) current = fresh;
}

/** 把输出里「依次执行:」下面那几行原样跑一遍(用户照抄的就是它们)。 */
async function followRollback(out) {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.includes("依次执行:"));
  assert.ok(at >= 0, `没打印退回命令\n${out}`);
  const commands = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("       ")) break;
    commands.push(l.trim());
  }
  const script = IS_WINDOWS
    ? commands.map((c) => `${c}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`).join("\n")
    : `set -e\n${commands.join("\n")}`;
  const [shell, shellArgs] = IS_WINDOWS
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n${script}`, "utf16le").toString("base64")]]
    : ["/bin/sh", ["-c", script]];
  const run = await runTestProcess(shell, shellArgs, { cwd: INSTALL, env, encoding: "utf8", timeout: 120_000, preserveScripts: [SERVER] });
  adopt(run);
  return { commands, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

// ── 旧服务在跑:改名之前那一代(只写 ash.db.ash.lock) ─────────────────────────────────────
assert.equal((await health()), null, `:${PORT} 被别的东西占着,这条回归没法测`);
spawnTestFixture(process.execPath, [SERVER], { cwd: INSTALL, env: { ...env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 50 && !(await health()); i += 1) await sleep(100);
const oldHealth = await health();
assert.equal(oldHealth?.version, "v1", "旧服务没起来");
assert.ok(existsSync(join(DATA, "ash.db.ash.lock")) && !existsSync(join(DATA, "ash.db.navi.lock")));

/** 拦下之后:代码、服务、库都还是原样。 */
async function untouched(out, label) {
  assert.equal(head(), v1, `${label}:代码动了\n${out}`);
  const h = await health();
  assert.equal(h?.pid, oldHealth.pid, `${label}:旧服务被动了\n${out}`);
  assert.ok(existsSync(join(DATA, "ash.db")) && !isMarker(join(DATA, "ash.db")) && !existsSync(join(DATA, "navi.db.identity.json")), `${label}:库动了`);
  assert.equal(npmCalls().length, 0, `${label}:装过依赖`);
  assert.match(out, /什么都没改/, label);
}

// 工作区脏
writeFileSync(join(INSTALL, "build.mjs"), `${readFileSync(join(INSTALL, "build.mjs"), "utf8")}// 本地改动\n`);
let out = await upgrade([], 2);
assert.match(out, /没提交的改动/, out);
await untouched(out, "工作区脏");
git(INSTALL, "checkout", "--", "build.mjs");
// 远端拉不动
git(INSTALL, "remote", "set-url", "origin", join(TMP, "nowhere.git"));
out = await upgrade([], 2);
assert.match(out, /拉不动/, out);
await untouched(out, "远端拉不动");
git(INSTALL, "remote", "set-url", "origin", REMOTE);
// 两份库并存
writeFileSync(join(DATA, "navi.db"), readFileSync(join(DATA, "ash.db")));
out = await upgrade([], 2);
assert.match(out, /都是库/, out);
rmSync(join(DATA, "navi.db"));
await untouched(out, "两份库并存");
// 有任务在跑(会被接管的也算:升级不在这时候做)
writeFileSync(join(DATA, "impact.json"), JSON.stringify({ survives: [{ pid: 1, title: "在跑的任务" }], resumes: [], interrupted: [], mcpDisrupted: [] }));
out = await upgrade([], 2);
assert.match(out, /有 1 个任务在跑或排队/, out);
assert.match(out, /在跑的任务/, out);
assert.match(out, /--wait/, out);
rmSync(join(DATA, "impact.json"));
await untouched(out, "有任务在跑");
console.log("✓ 工作区脏、远端拉不动、两份库并存、有任务在跑:都在停服务之前拦下,什么都没改");

// ── 第一次:git pull && npm run upgrade ───────────────────────────────────────────
git(INSTALL, "pull", "-q", "--ff-only");
out = await upgrade([], 0);
const firstRun = out;
let h = await health();
assert.equal(h?.version, "v2", `服务不是新代码\n${out}`);
assert.notEqual(h.pid, oldHealth.pid);
assert.ok(!isPidAlive(oldHealth.pid), "旧服务还在");
assert.ok(existsSync(join(DATA, "navi.db")) && isMarker(join(DATA, "ash.db")), `库没改名\n${out}`);
assert.ok(existsSync(join(DATA, "navi.db.identity.json")) && !existsSync(join(DATA, "ash.db.identity.json")), "身份没跟着库名走");
assert.deepEqual(npmCalls(), ["install --no-audit --no-fund", "run build"]);
assert.ok(out.includes(`${v1.slice(0, 9)} → ${v2.slice(0, 9)}`), `小结没写从哪升到哪\n${out}`);
assert.match(out, /项目 2 → 2 · 任务 3 → 3 · 会话 4 → 4,升级前的每一条都还在/, out);
assert.ok(out.includes(`http://localhost:${PORT}`) && out.includes(join(TMP, "navi.log")), out);
const backups = readdirSync(join(DATA, "backups")).filter((n) => n.startsWith("upgrade-"));
assert.equal(backups.length, 1, out);
const firstBackup = join(DATA, "backups", backups[0]);
assert.ok(existsSync(join(firstBackup, "ash.db")) && existsSync(join(firstBackup, "ash.db.identity.json")), "备份里没有库或身份");
assert.ok(out.includes(firstBackup), "小结没写备份在哪");
assert.ok(out.includes(`git reset --keep ${v1}`) && out.includes("rename-db.mjs --rollback"), `退回命令不全\n${out}`);
console.log("✓ 改名之前的安装一次升到新版:服务在新代码上、库是 navi.db、每一条都在、小结对得上");

// ── 再跑一次:已是最新,不重启 ────────────────────────────────────────────────────
out = await upgrade([], 0);
assert.match(out, /已是最新/, out);
assert.equal((await health())?.pid, h.pid, "已是最新却重启了服务");
assert.equal(npmCalls().length, 2);
console.log("✓ 再跑一次:已是最新,服务没被重启");

// ── 照抄小结里的退回命令回到改名之前的 v1,再升回来 ────────────────────────────────────
// 退回时 v1 自己的 restart 把依赖和产物换回了 v1:再升时提交号跟上次构建的对得上,也必须照常重装重建
// (只认提交号的那一版在这里跳过了构建,新代码配旧产物起不来 —— 真机演练撞上过)。
let back = await followRollback(firstRun);
assert.ok(back.commands.includes("node scripts/stop.mjs") && back.commands.some((c) => c.includes("rename-db.mjs --rollback")), back.commands.join("\n"));
h = await health();
assert.equal(h?.version, "v1", `照抄退回命令之后没回到改名之前的 v1\n${back.out}`);
assert.ok(existsSync(join(DATA, "ash.db")) && !isMarker(join(DATA, "ash.db")) && !existsSync(join(DATA, "navi.db")), "库没退回 ash.db");
assert.equal(head(), v1);
const calls = npmCalls().length;
git(INSTALL, "pull", "-q", "--ff-only");
out = await upgrade([], 0, { PORT: String(PORT) });
assert.equal(npmCalls().length, calls + 2, `产物换过了却没重装重建\n${out}`);
assert.equal((await health())?.version, "v2", out);
assert.match(out, /项目 2 → 2 · 任务 3 → 3 · 会话 4 → 4/, out);
console.log("✓ 照抄退回命令回到改名之前的版本(库也退回旧名);再升回来时照常重装重建");

// ── 命令更新自己 + 构建失败 → 照抄退回命令 ───────────────────────────────────────────
const v3 = publish(DEV, "v3", { flags: ["BUILD_FAIL"], upgradeMarker: true });
out = await upgrade([], 1);
assert.match(out, /\[v3 的升级逻辑\]/, `拉完代码跑的不是新版的升级逻辑\n${out}`);
assert.match(out, /构建失败/, out);
assert.equal(await health(), null, "构建失败之后服务应当停着(依赖已经换过)");
assert.equal(head(), v3);
back = await followRollback(out);
assert.ok(back.commands.includes(`git reset --keep ${v2}`), back.commands.join("\n"));
assert.ok(!back.commands.some((c) => c.includes("rename-db")), "v2 认得 navi.db,不该退库名");
h = await health();
assert.equal(h?.version, "v2", `照抄退回命令之后没回到 v2\n${back.out}`);
assert.equal(head(), v2);
console.log("✓ 拉完代码跑的是新版升级逻辑;构建失败后照抄退回命令回到能用的旧版");

// ── 新服务起不来 → 照抄退回命令;接着修好的版本再跑,接着上次做完 ──────────────────────────
publish(DEV, "v4", { flags: ["START_FAIL"] });
const backupCount = () => readdirSync(join(DATA, "backups")).filter((n) => n.startsWith("upgrade-")).length;
const backupsBefore = backupCount();
out = await upgrade([], 1);
assert.match(out, /上次升级\(从 [0-9a-f]+ 起\)没做完,接着做/, out);
assert.match(out, /新服务没起来/, out);
assert.match(out, /start: 这一版故意起不来/, `没把日志末尾打出来\n${out}`);
assert.equal(backupCount(), backupsBefore, "接着做时备份不该重做");
// 服务停着、锁也收了:不给 PORT 再跑一次,得照这份安装的端口接着做,而不是去找 4317。
out = await upgrade([], 1);
assert.ok(out.includes(`起服务 :${PORT}`), `锁收了之后没找回这份安装的端口\n${out}`);
back = await followRollback(out);
assert.equal((await health())?.version, "v2", back.out);
const v5 = publish(DEV, "v5");
out = await upgrade([], 0);
assert.match(out, /接着做/, out);
assert.ok(out.includes(`${v2.slice(0, 9)} → ${v5.slice(0, 9)}`), out);
assert.equal((await health())?.version, "v5");
console.log("✓ 新服务起不来后照抄退回命令回到旧版;修好的版本再跑,接着上次那一次做完");

// ── 库名留着(--keep-db-name)/ 改名失败照旧名起服务 ──────────────────────────────────
const nodeIn = (script, args) => runTestProcess(process.execPath, [join(INSTALL, "scripts", script), ...args], {
  cwd: INSTALL, env: { ...env, PORT: String(PORT) }, encoding: "utf8", timeout: 60_000,
});
await nodeIn("stop.mjs", []);
// 服务停了、锁也收了:从这里起显式给 PORT(不给的话会去找 4317 —— 那里坐着的若不是这份检出,升级会认出来拦下)。
await nodeIn("rename-db.mjs", ["--rollback", "--data", DATA]);
assert.ok(existsSync(join(DATA, "ash.db")) && !existsSync(join(DATA, "navi.db")));
out = await upgrade(["--keep-db-name"], 0, { PORT: String(PORT) });
assert.match(out, /按 --keep-db-name/, out);
assert.ok(existsSync(join(DATA, "ash.db")) && !isMarker(join(DATA, "ash.db")) && !existsSync(join(DATA, "navi.db")), `--keep-db-name 却改了名\n${out}`);
assert.equal((await health())?.db, join(DATA, "ash.db"));
// 改名目标名下已经有东西:库名改不了,照旧名起服务,其余照常升。
writeFileSync(join(DATA, "navi.db.feishu.json"), "{}\n");
publish(DEV, "v6");
out = await upgrade([], 0, { PORT: String(PORT) });
assert.match(out, /库名没改成/, out);
assert.equal((await health())?.version, "v6", out);
assert.equal((await health())?.db, join(DATA, "ash.db"));
rmSync(join(DATA, "navi.db.feishu.json"));
console.log("✓ --keep-db-name 升完库还叫 ash.db;改名目标被占时照旧名起服务、其余照常升");
if (process.platform === "darwin") {
  // 改到一半失败(跟着库名走的身份文件改不动):⑨ 的账本照原样退回,照旧名起服务。
  execFileSync("chflags", ["uchg", join(DATA, "ash.db.identity.json")]);
  try {
    publish(DEV, "v7");
    out = await upgrade([], 0, { PORT: String(PORT) });
  } finally {
    execFileSync("chflags", ["nouchg", join(DATA, "ash.db.identity.json")]);
  }
  assert.match(out, /已照账本退回原样/, out);
  assert.match(out, /库名没改成/, out);
  assert.ok(!existsSync(join(DATA, "navi.db.renaming")) && !existsSync(join(DATA, "navi.db")) && !isMarker(join(DATA, "ash.db")), "没退回原样");
  assert.equal((await health())?.version, "v7", out);
  console.log("✓ 库改名做到一半失败:照账本退回原样,照旧名起服务,其余照常升");
}

// ── 新版要的 Node 不够:第一段就拦下,代码都不拉 ─────────────────────────────────────
const served = (await health())?.pid;
const before = head();
publish(DEV, "v8", { node: ">=99.0.0" });
out = await upgrade([], 2, { PORT: String(PORT) });
assert.match(out, /不够新,新版要 >=99\.0\.0/, out);
assert.equal(head(), before, "版本不够还拉了代码");
assert.equal((await health())?.pid, served);
// 新版自己的核对没过(这里是 workspace 缺一块):第二段在停服务之前把刚拉的代码退回去。
publish(DEV, "v9", { workspaces: ["shared", "ghost"] });
out = await upgrade([], 2, { PORT: String(PORT) });
assert.match(out, /ghost/, out);
assert.match(out, /刚拉的代码已退回/, out);
assert.equal(head(), before, `第二段拦下之后代码没退回\n${out}`);
assert.equal((await health())?.pid, served, "第二段拦下却动了服务");
console.log("✓ 新版要的 Node 不够在拉代码之前拦下;新版自己的核对没过时把刚拉的代码退回去、服务没动");

// ── --wait:等在跑的任务跑完再升 ────────────────────────────────────────────────────
publish(DEV, "v10");
writeFileSync(join(DATA, "impact.json"), JSON.stringify({ survives: [], resumes: [{ title: "调度台" }], interrupted: [], mcpDisrupted: [] }));
const waiting = upgrade(["--wait"], 0, { PORT: String(PORT) });
await sleep(3000);
assert.equal((await health())?.pid, served, "还有任务在跑就动了服务");
rmSync(join(DATA, "impact.json"));
out = await waiting;
assert.match(out, /WAIT:还有 1 个任务升级会被打断/, out);
assert.equal((await health())?.version, "v10", out);
console.log("✓ --wait 等任务跑完才升");

// ── 产物少了一个文件(入口还在):不能算「已是最新」,照常重建 ───────────────────────────────
let pid = (await health())?.pid;
let npmBefore = npmCalls().length;
rmSync(join(INSTALL, "web", "dist", "assets", "app.js"));
out = await upgrade([], 0, { PORT: String(PORT) });
assert.doesNotMatch(out, /已是最新/, out);
assert.equal(npmCalls().length, npmBefore + 2, `产物缺了文件却没重建\n${out}`);
assert.ok(existsSync(join(INSTALL, "web", "dist", "assets", "app.js")));
assert.notEqual((await health())?.pid, pid);
console.log("✓ 产物里少了一个文件(入口还在)照样重建,不说已是最新");

// ── 同一份检出、同一份数据同时只许一次升级 / restart;死掉的登记不算数 ─────────────────────────
// (锁本身的交错 —— 同时到的都退下、读不懂的不删 —— 在 test-upgrade-units.mjs)
const checkoutLocks = join(git(INSTALL, "rev-parse", "--absolute-git-dir"), "navi-upgrade.lock.d");
const dataLocks = join(realpathSync(DATA), ".navi-upgrade.lock.d");
const someone = (lockDir, who) => {
  mkdirSync(lockDir, { recursive: true });
  const file = join(lockDir, `${"ab".repeat(12)}.${who}.json`);
  writeFileSync(file, JSON.stringify({ pid: who, startedAt: "刚才", note: "升级" }));
  return file;
};
pid = (await health())?.pid;
for (const lockDir of [checkoutLocks, dataLocks]) {
  const held = someone(lockDir, process.pid);
  out = await upgrade([], 2, { PORT: String(PORT) });
  assert.match(out, /正被另一次 升级 占着\(pid \d+/, out);
  assert.equal((await health())?.pid, pid, "有升级在跑却动了服务");
  const restartWhile = await runTestProcess(process.execPath, [join(INSTALL, "scripts", "restart.mjs")], { cwd: INSTALL, env: { ...env, PORT: String(PORT) }, encoding: "utf8", timeout: 60_000 }, 2);
  assert.match(`${restartWhile.stdout}${restartWhile.stderr}`, /正被另一次 升级 占着/, "升级进行中 restart 也该让开");
  rmSync(held);
}
const dead = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim());
const crashed = someone(checkoutLocks, dead);
out = await upgrade([], 0, { PORT: String(PORT) });
assert.match(out, /已是最新/, out);
assert.ok(!existsSync(crashed), "死掉的登记没清掉");
assert.deepEqual([...readdirSync(checkoutLocks), ...readdirSync(dataLocks)], [], "升级做完没把锁还回去");
console.log("✓ 同一份检出、同一份数据同时只许一次升级(restart 也让开);死掉的登记不算数");

// ── 数据没核对成:不算升好,再跑先补核(不重启) ─────────────────────────────────────────
const stateFile = join(DATA, "upgrade.json");
const withState = (patch) => writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), ...patch }));
writeFileSync(join(TMP, "garbage.db"), "这不是一份库");
const firstDigest = fileDigest(join(firstBackup, "ash.db"));
// 读不出来的、指纹对不上的、不见了的(审查第 3 轮 R1:不见了的曾被建成一份空库、拿「零条都在」清掉了待核对)。
for (const pending of [
  { backupFile: join(TMP, "garbage.db"), backupDigest: fileDigest(join(TMP, "garbage.db")) },
  { backupFile: join(firstBackup, "ash.db"), backupDigest: "0".repeat(64) },
  { backupFile: join(firstBackup, "gone.db"), backupDigest: firstDigest },
]) {
  withState({ verifyPending: pending });
  out = await upgrade([], 1, { PORT: String(PORT) });
  assert.match(out, /数据核对还是没过/, out);
  assert.equal((await health())?.pid, pid, "补核不该重启服务");
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).verifyPending, pending, "没核对成却清掉了待核对");
}
assert.ok(!existsSync(join(firstBackup, "gone.db")), "补核替不见了的备份建了一份空库");
withState({ verifyPending: { backupFile: join(firstBackup, "ash.db"), backupDigest: firstDigest } });
out = await upgrade([], 0, { PORT: String(PORT) });
assert.match(out, /补核过了:项目 2 → 2/, out);
assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).verifyPending, undefined);
console.log("✓ 数据没核对成不算升好;再跑先补核,过了才清掉,服务不重启");

// ── 已是最新也收拾 MCP 登记:navi 在、旧名 ash 起的也是 Navi 的脚本 → 删掉旧名 ─────────────────────
{
  const home = join(TMP, "home");
  const cliLog = join(TMP, "cli.log");
  const entry = join(INSTALL, "mcp", "dist", "index.js");
  fakeCli(join(TMP, "clibin"), "claude", cliLog, `navi: node ${entry} - ✔ Connected\nash: node ${entry} - ✔ Connected\n`);
  fakeCli(join(TMP, "clibin"), "codex", cliLog, JSON.stringify([{ name: "navi", enabled: true, transport: { type: "stdio", command: "node", args: [entry] } }]));
  mkdirSync(join(home, ".codex"), { recursive: true });
  out = await upgrade([], 0, {
    PORT: String(PORT), SKIP_MCP: "", PATH: join(TMP, "clibin") + delimiter + env.PATH,
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  });
  assert.match(out, /已是最新/, out);
  assert.ok(readFileSync(cliLog, "utf8").includes("claude mcp remove ash --scope user"), `已是最新时没收拾旧名登记\n${out}`);
  assert.equal((await health())?.pid, pid, "收拾登记不该重启服务");
  console.log("✓ 已是最新也收拾 MCP 登记(旧名 ash 删掉),不重启服务");
}

// ── 停服务之后写不进进度:同一个出口,照抄退回命令回到能用的旧版 ──────────────────────────────
const v11Base = head();
publish(DEV, "v11", { flags: ["BREAK_STATE"] });
out = await upgrade([], 1, { PORT: String(PORT) });
assert.match(out, /升级中途出了意外/, out);
assert.match(out, /服务现在没在跑/, out);
rmSync(stateFile, { recursive: true, force: true });
back = await followRollback(out);
assert.ok(back.commands.includes(`git reset --keep ${v11Base}`), back.commands.join("\n"));
assert.equal(head(), v11Base);
const v11BaseVersion = (await health())?.version;
assert.ok(v11BaseVersion && v11BaseVersion !== "v11", `照抄退回命令之后没回到能用的旧版\n${back.out}`);
console.log("✓ 停服务之后写不进进度:照服务此刻的样子给出退回命令,照抄能回到旧版");

// ── 新服务起得太慢(进程活着、没应答):说清它还活着,退回命令先按 pid 结束它 ─────────────────────
const v12 = publish(DEV, "v12");
out = await upgrade([], 0, { PORT: String(PORT) });
assert.equal((await health())?.version, "v12", out);
publish(DEV, "v13", { flags: ["SLOW_START"] });
out = await upgrade([], 1, { PORT: String(PORT), START_TIMEOUT: "2" });
const stray = Number(out.match(/刚起的服务进程\(pid (\d+)\)还活着/)?.[1]);
assert.ok(stray && isPidAlive(stray), `没说清刚起的进程还活着\n${out}`);
back = await followRollback(out);
assert.equal(back.commands[1], `node scripts/stop.mjs --pid ${stray}`, back.commands.join("\n"));
assert.ok(!isPidAlive(stray), "照抄退回命令之后那个慢服务还活着(stop --pid 报成功之前就该等到它退出)");
assert.equal((await health())?.version, "v12", back.out);
assert.equal(head(), v12);
console.log("✓ 新服务起得太慢:说清它还活着,照抄退回命令先结束它再回到旧版");

console.log("✓ upgrade.mjs 回归全部通过");
