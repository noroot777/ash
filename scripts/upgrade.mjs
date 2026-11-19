#!/usr/bin/env node
// 一条命令把源码安装升到远端最新:拉代码 → 停服务 → 给库留底 → 装依赖、构建 → 库改名成 navi.db → 起服务 → 核对数据。
//
//   git pull && npm run upgrade      第一次(改名之前的版本还没有这条命令)
//   npm run upgrade                  以后
//   npm run upgrade -- --wait        有任务在跑就等它们跑完再升
//   npm run upgrade -- --keep-db-name   库留着叫 ash.db(想随时退回改名之前的版本)
//   完整选项:node scripts/upgrade.mjs --help(upgrade-options.mjs)
//
// 两段跑:
//  - 第一段(下面的 prepare)什么都不改,把能拦的都拦在停服务之前:工作区脏、不在能快进的分支上、远端拉不动、
//    新版要的 Node/npm 这台机器给不起、数据目录认不准(⑨ 的判定原样沿用)、端口上的服务不是这份检出 + 这份数据起的、
//    有任务在跑或排队(判据跟 stop/restart 是同一条 /api/restart-impact,但升级挡得更严:升级那一刻在跑的任务被新版
//    接管,这条路没在真机上验过)。都过了才快进代码。
//  - 第二段(apply)用**磁盘上刚拉下来的那份**升级脚本接着跑(内存里这份是旧的):新版自己再核对一遍,没过就把刚拉的代码
//    退回去;过了才停服务。**先停再装**:改名把工作区包从 @ash/* 换成了 @navi/*,旧服务开着时 npm install 换掉链接,
//    它之后再懒加载模块就找不到。
//
// 失败时的去向:停服务之前失败 = 什么都没改;留底失败 = 把原来的服务原样起回来;装依赖/构建/起服务失败 = 停在那一步,
// 打出两条路(修好再跑一次接着做;或原样照抄就能退回升级前版本的几行命令)。库改名失败按 ⑨ 的账本退回原样,照旧名起服务,
// 不让这一项作废整次升级;停服务之后出了别的意外(写不进进度、磁盘满)一样停下、打出那两条路。做到哪记在数据目录的
// upgrade.json(upgrade-data.mjs),再跑接着做;已是最新就说一句,不重启服务(但 MCP 登记照样收拾、上次没核对过的数据照样补核)。
// 同一份检出、同一份数据同一时刻只许一次升级 / restart / setup(upgrade-lock.mjs)。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FILE_NAME } from "./db-file.mjs";
import { envNameGenerations, readEnv, readStorageEnv } from "./env.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { registerNaviMcp } from "./mcp-register.mjs";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { IS_WINDOWS, isPidAlive, localJson } from "./platform.mjs";
import { inspect } from "./rename-db-core.mjs";
import { restartCommand } from "./restart-options.mjs";
import { dataDirFor, dbFileFor, lockFileFor, takeDown } from "./server-control.mjs";
import { processBirth } from "./process-birth.mjs";
import { launchServer, refreshMcp } from "./server-start.mjs";
import { identifyServer, inspectData, resolvePort, runtimeProblems } from "./upgrade-checks.mjs";
import { backupDb, backupSources, buildStamp, dbIdentity, dbInBackup, pendingBaselines, readState, renameDb, verifyData, writeState } from "./upgrade-data.mjs";
import {
  beforeLastPull, countBetween, fastForward, fetchRemote, inspectCheckout, isAncestor, relation, resetKeep, revParse, short,
  showFile, untrackedCollisions,
} from "./upgrade-git.mjs";
import { acquireUpgradeLock, checkoutLockDir, dataLockDirs, UPGRADE_LOCK_ENV } from "./upgrade-lock.mjs";
import { progressOwnership } from "./upgrade-ownership.mjs";
import { parseUpgradeOptions, upgradeCommand, UPGRADE_USAGE, userArgs } from "./upgrade-options.mjs";
import { checkDataCommand, envLines, printRollback, printSummary, rollbackCommands, shellArg } from "./upgrade-report.mjs";
import { WORKSPACE_FAIL_HINT, inspectNpmConfig, inspectWorkspaces } from "./workspace-check.mjs";
import { repairEmptyWorkspaces } from "./workspace-repair.mjs";

let options;
try {
  options = parseUpgradeOptions();
} catch (error) {
  process.stderr.write(`✕ ${error.message}\n运行 ${upgradeCommand("--help")} 查看用法。\n`);
  process.exit(2);
}
if (options.help) {
  process.stdout.write(`${UPGRADE_USAGE}\n`);
  process.exit(0);
}

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(REPO);
const env = process.env;
const say = (line = "") => process.stdout.write(`${line}\n`);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const WAIT_TIMEOUT = env.WAIT_TIMEOUT ? Number(env.WAIT_TIMEOUT) : null;
// 起哪个入口、等多久:同 restart.mjs(留口子给回归拿假 server 跑完整条流程)。升级后第一次起要补列迁移,多给一点时间。
const SERVER_ENTRY = env.SERVER_ENTRY || "server/dist/index.js";
const SERVER_NODE = env.SERVER_NODE || process.execPath;
const START_TIMEOUT = Number(env.START_TIMEOUT || 60);
const logFor = (port) => readEnv(env, "NAVI_LOG") || join(IS_WINDOWS ? (env.TEMP || ".") : "/tmp", `navi-${port}.log`);

/** 第一段拦下:说清原因,什么都没改。 */
function block(problems, code = 2) {
  say("");
  for (const p of problems) say(`  ✕ ${p}`);
  stopHere(code);
}

function stopHere(code) {
  say("✕ 没有升级:上面这些先处理掉再跑。什么都没改(代码、依赖、库、服务都是原样)。");
  process.exit(code);
}

/** 升级挡下的任务:一切在跑、在排队的(stop/restart 只挡接管不了的那些)。 */
const gate = {
  verb: "升级",
  held: (d) => ["interrupted", "survives", "resumes"].flatMap((k) => (Array.isArray(d[k]) ? d[k] : [])),
  heldLine: (n) => `有 ${n} 个任务在跑或排队,升级不在这时候做(升级那一刻在跑的任务交给新版接管,这条路没在真机上验过)`,
  tail: "什么都没改。",
  command: upgradeCommand,
  passLine: (safe, lead) => `  ⚠ --force:${safe} 个在跑的任务交给新版接管、${lead} 个调度台由新版接回 —— 这条路没在真机上验过,升完留意它们。`,
};

/** 两段都要过的核对:Node/npm、数据目录、端口上的服务。有问题就交给 abort(不返回)。 */
async function preflight(pkg, abort) {
  const data = inspectData({ repo: REPO, env, keepDbName: options.keepDbName, stamp });
  const problems = [...runtimeProblems(pkg), ...data.problems];
  let saved = {};
  const db = data.problems.length ? null : dbIdentity(data.db);
  if (!data.problems.length) {
    try { saved = readState(data.dataDir); } catch (error) { problems.push(error.message); }
  }
  // 进度里跟库绑着的记录归不归这份库(别的库没做完的、没记是哪份库的旧记录):对不上就在这里拦下(upgrade-ownership.mjs)。
  if (db) problems.push(...progressOwnership(saved, { db, dbPath: data.db, takeOver: options.takeOver }).problems);
  // 库留不了底的(软链指着的东西不在了之类),在停服务之前就拦下。
  if (!data.problems.length) problems.push(...backupSources({ backupRoot: data.backupRoot, db: data.db, explicit: data.explicit }).problems);
  // 库改名做到一半(账本在)、而这次升级之前没留过底:那一刻库和它的 -wal 可能分在新旧两个名字下,做不出一份可靠的快照。
  if (data.rename === "resume" && !saved.inProgress?.backup) {
    problems.push(`库改名上次做到一半(账本还在),而且之前没留过底:先 node scripts/rename-db.mjs --apply --data ${shellArg(data.dataDir)} 做完(或 --rollback 退回),再升级`);
  }
  const { port, from: portFrom } = data.problems.length ? { port: 0 } : resolvePort(REPO, env, saved.port);
  const server = data.problems.length ? null : await identifyServer({ repo: REPO, env, port, dataDir: data.dataDir, explicit: data.explicit });
  if (server) problems.push(...server.problems);
  if (problems.length) {
    say("");
    for (const p of problems) say(`  ✕ ${p}`);
    return abort(2);
  }
  for (const w of data.warnings) say(`  ⚠ ${w}`);
  return { data, db, dbPath: data.db, port, portFrom, server };
}

/** 核对出来少了的那几张表,逐张说清少了哪几条。 */
function reportMissing(v) {
  for (const r of v.rows ?? []) {
    if (!r.missing.length) continue;
    say(`  ✕ ${r.label}少了 ${r.missing.length} 条(id ${r.missing.slice(0, 5).join("、")}${r.missing.length > 5 ? " …" : ""})。先别动库备份,照下面的办法退回再查`);
  }
}

/**
 * 核对数据:之前欠着的每一份(verifyPending)加上这一次的基线(有的话),全过才算数。欠着的必须亲自过,不能拿后来留的底
 * 顶替 —— 后来那份是从已经少了东西的库留的,拿它比只能证明「没再少」(审查实测:第一次少了一条,第二次改口说都在)。
 * 返回 { ok, line, left }:left = 还没过的那几份(照 verifyPending 的格式记回去)。
 */
function settleChecks(owed, current, live, { db, dbPath }) {
  const left = [];
  const lines = [];
  for (const b of [...owed, ...(current && !owed.some((o) => o.file === current.file) ? [current] : [])]) {
    const v = verifyData(b, live);
    lines.push({ ok: v.state === "ok", text: b === current ? v.line : `上次升级欠着的核对:${v.line}` });
    reportMissing(v);
    if (b === current) {
      if (v.state !== "missing") say(`  ${v.state === "ok" ? "✓" : "⚠"} ${v.line}`);
    } else if (v.state === "ok") {
      say(`  ✓ 上次没核对成的数据补核过了:${v.line}`);
    } else {
      say(`  ⚠ 上次升级的数据核对还是没过:${v.line}。升级前的库在 ${b.file},先别删它。`);
    }
    if (v.state !== "ok") left.push({ backupFile: b.file, backupDigest: b.digest, db, dbPath });
  }
  // 小结里那一行:有没过的说头一份没过的,都过了说最后一份(这一次的基线排在最后)。
  const line = (lines.find((l) => !l.ok) ?? lines.at(-1))?.text ?? "没核对(升级前没有库)";
  return { ok: !left.length, line, left };
}

/** 数据那一头的锁(upgrade-lock.mjs 的 dataLockDirs:库、runs、升级进度各自的真实落点);落点解析不了也算没拿到。 */
function lockData(data, token) {
  try { return acquireUpgradeLock(dataLockDirs(data.db, data.dataDir, env), { token, note: "升级" }); } catch (error) { return { ok: false, why: error.message }; }
}

const takeDownArgs = (ctx, extra) => ({
  port: ctx.port, lockFile: ctx.server.lockFile, log: logFor(ctx.port), force: options.force, wait: options.wait,
  waitTimeout: WAIT_TIMEOUT, say, gate, ...extra,
});

// ── 第一段:核对、拉代码(什么都不改,除了最后那一下快进) ──────────────────────────────
async function prepare() {
  say("▶ 升级之前先核对一遍(这一段不改任何东西)…");
  const co = inspectCheckout(REPO);
  if (co.problems.length) block(co.problems);
  const lock = acquireUpgradeLock([checkoutLockDir(REPO)], { note: "升级" });
  if (!lock.ok) block([lock.why]);
  process.on("exit", lock.release);
  const fetched = fetchRemote(REPO, co.remote);
  if (!fetched.ok) {
    block([`从 ${co.remote} 拉不动:${fetched.err.split("\n").slice(-3).join(" / ")}`, "     网络、代理或凭证的问题;先让 git fetch 能过,再跑一次"]);
  }
  const target = revParse(REPO, co.upstream);
  const rel = relation(REPO, co.head, target);
  if (rel === "diverged") {
    block([`本地 ${co.branch} 跟 ${co.upstream} 分叉了(本地多 ${countBetween(REPO, target, co.head)} 个提交,远端多 ${countBetween(REPO, co.head, target)} 个),快进不过去。`
      + "先 git pull --rebase(或合并)收拾好再跑"]);
  }
  if (rel === "behind") {
    const collide = untrackedCollisions(REPO, co.head, target);
    if (collide.length) block([`这几个没跟踪的文件挡着新版里的同名文件,拉不下来:${collide.slice(0, 8).join("、")}。挪走或删掉再跑`]);
    say(`  · ${co.upstream} 有 ${countBetween(REPO, co.head, target)} 个新提交:${short(co.head)} → ${short(target)}`);
  } else {
    say(rel === "ahead" ? `  · 本地比 ${co.upstream} 多 ${countBetween(REPO, target, co.head)} 个提交,不用拉` : `  · 代码已经是 ${co.upstream} 的最新(${short(co.head)})`);
  }
  let pkg;
  try { pkg = JSON.parse(rel === "behind" ? showFile(REPO, target, "package.json") : readFileSync(join(REPO, "package.json"), "utf8")); }
  catch { block(["新版的 package.json 读不出来,不知道它要什么版本的 Node/npm"]); }
  const ctx = await preflight(pkg, stopHere);
  // 数据那一头也锁上(别的检出可以经 NAVI_DATA_DIR / NAVI_DB 指到同一份数据)。
  const dataLock = lockData(ctx.data, lock.token);
  if (!dataLock.ok) block([dataLock.why]);
  process.on("exit", dataLock.release);
  // 有任务在跑就在这里拦下(--wait 在这里等):还没拉代码,什么都没变。
  if (ctx.server.running) await takeDown(takeDownArgs(ctx, { check: true }));
  let pulled = null;
  if (rel === "behind") {
    const ff = fastForward(REPO, target);
    if (!ff.ok) block([`快进到 ${short(target)} 没成:${ff.err}`]);
    pulled = co.head;
    say(`  ✓ 代码拉到 ${short(target)}`);
  }
  // 接着跑刚拉下来的那份升级脚本 —— 新版自己的升级逻辑,不是内存里这份旧的。
  const next = spawnSync(process.execPath, [join(REPO, "scripts", "upgrade.mjs"), ...userArgs(), "--continue", ...(pulled ? ["--pulled-from", pulled] : [])], {
    stdio: "inherit", env: { ...env, PORT: String(ctx.port), [UPGRADE_LOCK_ENV]: lock.token },
  });
  process.exit(next.status ?? 1);
}

// ── 第二段:停、留底、装、建、改名、起、核对 ─────────────────────────────────────────
async function apply() {
  const pulledFrom = options.pulledFrom;
  const head = revParse(REPO, "HEAD");
  let state = {};
  let dataDir = null;
  let createdProgress = false;
  /** 停服务之前被拦下:这一次刚拉的代码退回去,这一次记的进度抹掉 —— 回到什么都没改。 */
  const undoPull = (code) => {
    if (createdProgress) { delete state.inProgress; writeState(dataDir, state); }
    const r = pulledFrom ? resetKeep(REPO, pulledFrom) : { ok: true };
    if (r.ok) {
      if (pulledFrom) say(`  ↩ 刚拉的代码已退回 ${short(pulledFrom)}。`);
      stopHere(code);
    }
    say(`✕ 没有升级,但没能把刚拉的代码退回 ${short(pulledFrom)}:${r.err}。服务没动过,照常跑着原来的版本;`);
    say(`  手工退回:git reset --keep ${pulledFrom}`);
    process.exit(code);
  };

  // 第一段把锁递过来了就用同一个 token 放自己的登记(同一次升级);直接跑 --continue 的现拿一把。
  // 接到就从环境里抹掉:往后装依赖、构建、起服务都继承 process.env,带下去就漏进常驻服务和它的终端了。
  const relayed = env[UPGRADE_LOCK_ENV] || null;
  delete env[UPGRADE_LOCK_ENV];
  const lock = acquireUpgradeLock([checkoutLockDir(REPO)], { token: relayed, note: "升级" });
  if (!lock.ok) { say(`  ✕ ${lock.why}`); undoPull(2); }
  process.on("exit", lock.release);

  let ws = inspectWorkspaces(REPO);
  if (!ws.ok && repairEmptyWorkspaces(REPO).restored.length) ws = inspectWorkspaces(REPO);
  const npmCfg = inspectNpmConfig();
  for (const w of npmCfg.warnings) say(`  ⚠ ${w}`);
  if (!ws.ok || npmCfg.blockers.length) {
    for (const p of [...ws.problems, ...npmCfg.blockers]) say(`  ✕ ${p}`);
    if (!ws.ok) for (const line of [...WORKSPACE_FAIL_HINT, ...ws.fix]) say(`     ${line}`);
    undoPull(2);
  }
  const ctx = await preflight(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")), undoPull);
  const { data, port } = ctx;
  const dataLock = lockData(data, lock.token);
  if (!dataLock.ok) { say(`  ✕ ${dataLock.why}`); undoPull(2); }
  process.on("exit", dataLock.release);
  dataDir = data.dataDir;
  // 进度在锁里重读、重认一遍归属(preflight 那一眼是拿锁之前看的);--take-over 认领 / 搁置的结果在动服务之前先写下。
  try { state = readState(dataDir); } catch (error) { say(`  ✕ ${error.message}`); undoPull(2); }
  const own = progressOwnership(state, { db: ctx.db, dbPath: ctx.dbPath, takeOver: options.takeOver });
  if (own.problems.length) { for (const p of own.problems) say(`  ✕ ${p}`); undoPull(2); }
  if (own.changed) {
    state = own.state;
    try { writeState(dataDir, state); } catch (error) { say(`  ✕ 升级进度写不进 ${dataDir}(${error.message})`); undoPull(2); }
    say("  · --take-over:进度里对不上的记录已经认领 / 搁置好了");
  }
  const log = logFor(port);
  const resumed = state.inProgress ?? null;
  const lastTo = state.last?.to && state.last.to !== head && isAncestor(REPO, state.last.to, head) ? state.last.to : null;
  const from = resumed?.from ?? pulledFrom ?? lastTo ?? beforeLastPull(REPO) ?? head;
  const entry = isAbsolute(SERVER_ENTRY) ? SERVER_ENTRY : join(REPO, SERVER_ENTRY);
  // 构建产物整棵树 + npm 记的已装依赖清单(buildStamp);几个入口文件得在,是起服务的前提。
  const products = [dirname(entry), ...["shared", "mcp", "web"].map((ws) => join(REPO, ws, "dist")), join(REPO, "node_modules", ".package-lock.json")];
  const entries = [entry, join(REPO, "mcp", "dist", "index.js"), join(REPO, "web", "dist", "index.html")];
  const built = state.built?.commit === head && entries.every(existsSync) && state.built.stamp === buildStamp(products);
  const renameNow = ["todo", "resume"].includes(data.rename);
  const serving = ctx.server.running && state.servedPid && ctx.server.health?.pid === state.servedPid && state.servedDb === ctx.db;
  const debts = pendingBaselines(state, ctx.db);
  /** 欠着的核对记回去:这份库还没过的 + 别的库的原样。 */
  const keepDebts = (left) => {
    const all = [...debts.others, ...left];
    if (all.length) state.verifyPending = all;
    else delete state.verifyPending;
  };
  for (const o of debts.others) {
    say(`  ⚠ ${o?.db ? `另一份库 ${o.dbPath ?? o.db} ` : "一份没记是哪份的库"}还欠着一次数据核对(升级前的库在 ${o?.backupFile}):选它再跑一次 npm run upgrade 补核;这一次只核对 ${data.db}`);
  }
  /** MCP 登记收拾成只有 navi(setup 那份逻辑):幂等,迁不了不算升级失败,说一句就行。 */
  const registerMcp = () => {
    if (options.skipMcp) return;
    try {
      registerNaviMcp({ repo: REPO, port, ok: (l) => say(`  ✓ ${l}`), warn: (l) => say(`  ⚠ ${l}`), say });
    } catch (error) {
      say(`  ⚠ MCP 登记没迁成:${error.message}(不影响服务;之后再跑一次 npm run upgrade 或 npm run setup)`);
    }
  };
  if (!resumed && built && !renameNow && serving) {
    say(`✓ 已是最新:代码 ${short(head)},库 ${data.db},服务 http://localhost:${port}(pid ${state.servedPid})在跑。代码、依赖、服务都没动。`);
    // 上次升级没核对过的数据补核一次(只读现在的库,不重启)。
    const v = settleChecks(debts.mine, null, dbFileFor(REPO, env), ctx);
    if (v.left.length !== debts.mine.length) {
      keepDebts(v.left);
      try { writeState(dataDir, state); } catch { /* 记不下来,下次再补核一遍而已 */ }
    }
    registerMcp();
    process.exit(v.ok ? 0 : 1);
  }
  if (resumed) say(`  · 上次升级(从 ${short(resumed.from)} 起)没做完,接着做`);
  state.inProgress = { ...(resumed ?? { from, db: ctx.db, dbPath: ctx.dbPath, startedAt: new Date().toISOString() }), to: head };
  state.port = port;
  createdProgress = !resumed;
  try {
    writeState(dataDir, state);
  } catch (error) {
    say(`  ✕ 升级进度写不进 ${dataDir}(${error.message}),停服务之前就不往下做了`);
    createdProgress = false;
    undoPull(2);
  }
  const save = () => writeState(dataDir, state);
  // 这一次选数据的环境变量(各代名字设成同一个值):退回 / 手工重起的命令开头原样设回去(upgrade-report.mjs 的 envLines)。
  const dataEnv = {};
  for (const name of ["NAVI_DATA_DIR", "NAVI_DB", "NAVI_RUNS_DIR"]) {
    const value = readStorageEnv(env, name);
    if (value) for (const key of envNameGenerations(name)) dataEnv[key] = resolve(REPO, value);
  }

  // 起过的服务进程都记下来(起回原来的那个、起新的那个):没应答的那种 stop.mjs 问不到,退回命令得按 pid 结束、等它真退。
  let launchedProc = null; // { pid, born }:pid 会被复用,退回命令按 pid + 出生时刻认人(process-birth.mjs)
  const launch = async () => {
    const r = await launchServer({ port, log, serverNode: SERVER_NODE, serverEntry: SERVER_ENTRY, startTimeout: START_TIMEOUT, env: { ...env, PORT: String(port) } });
    if (r.pid) launchedProc = { pid: r.pid, born: processBirth(r.pid) };
    return r;
  };
  /**
   * 服务此刻到底什么样,退回命令照它写:端口上有服务应答(stop.mjs 停得了);刚起的进程还活着却没应答(起得慢、卡在迁移里 ——
   * stop.mjs 问不到它,得按 pid 结束);都没有。
   */
  const serviceNow = async () => {
    const h = await localJson(port, "/api/health");
    if (h) return { serverRunning: true, line: `:${port} 上有服务在应答(pid ${h.pid ?? "?"})` };
    if (launchedProc && isPidAlive(launchedProc.pid)) {
      const line = `刚起的服务进程(pid ${launchedProc.pid})还活着、只是没应答 —— 可能只是起得慢(看 ${log});等它起来了再跑一次 npm run upgrade 收尾就算升好`;
      // 出生时刻没读出来就认不准它(stop --pid 不肯动它),只能如实说、让人自己处理。
      const known = /^w?\d+$/.test(launchedProc.born ?? "");
      return { serverRunning: false, stray: known ? launchedProc : null, line: known ? line : `${line}(没读出它的出生时刻,退回之前先自己结束它)` };
    }
    return { serverRunning: false, line: "服务现在没在跑" };
  };
  /** 停服务之后失败:停在这一步,给两条路。退回命令只用内存里的东西拼(进度可能正是写不进去的那个)。 */
  const fail = async (reason, extra = []) => {
    const now = await serviceNow();
    say("");
    say(`✕ ${reason}。${now.line}。`);
    for (const line of extra) say(`  ${line}`);
    say(`  · 修好原因后再跑一次 npm run upgrade(或 ${upgradeCommand()}):从这一步接着做。`);
    printRollback(say, rollbackFor(now));
    process.exit(1);
  };
  /** 退回 from 那一版的命令。库现在叫 navi.db、那一版又认不得它,就先(用新版)退回旧名。 */
  const rollbackFor = ({ serverRunning, stray = null }) => {
    let renameBack = false;
    try {
      // 那一版的服务开不开得了 navi.db:看它自己选库的那份代码(改名之前的版本里没有这个名字)。
      const fromKnowsNavi = (showFile(REPO, from, "server/src/db/path.ts") ?? "").includes(JSON.stringify(DB_FILE_NAME));
      renameBack = !data.explicit && !fromKnowsNavi && inspect(dataDir).state === "renamed";
    } catch { /* 认不出来:退库名那一步不写,rename-db 自己会在旧版起不来时说清楚 */ }
    const cmds = rollbackCommands({ from, head, port, serverRunning, stray, renameBack, dataDir: dataDirFor(REPO, env), dataEnv });
    return { repo: REPO, backup: state.inProgress?.backup ?? state.last?.backup, cmds };
  };

  say(`▶ 1/6 停服务 :${port}…`);
  const down = await takeDown(takeDownArgs(ctx, { abort: undoPull }));
  createdProgress = false; // 服务动过了,往后不再退回代码
  say(down.running ? `  ✓ :${port} 已停` : `  · :${port} 本来就没在跑`);
  // 往后任何一步抛出来的意外(写不进进度、磁盘满、读不动文件)都落到同一个出口:停下、照服务此刻的样子给两条路。
  try {
    say("▶ 2/6 给库留底…");
    if (!state.inProgress.backup) {
      let b;
      try {
        b = await backupDb({ backupRoot: data.backupRoot, db: data.db, explicit: data.explicit, stamp });
      } catch (error) {
        // 依赖、构建产物都还是原来的:把原来的服务原样起回来,升级这次不做。
        say(`  ✕ 留底没成:${error.message}`);
        delete state.inProgress;
        try { save(); } catch { /* 磁盘满时这里也写不进去;下次再跑会重新判断 */ }
        const reset = pulledFrom ? resetKeep(REPO, pulledFrom) : { ok: true };
        if (!reset.ok) say(`  ✕ 刚拉的代码没退回 ${short(pulledFrom)}(${reset.err});手工退回:git reset --keep ${pulledFrom}`);
        if (down.running) {
          const back = await launch();
          if (back.ok) say(`  ↩ 原来的服务已经照原样起回来了(pid ${back.pid})`);
          else {
            const now = await serviceNow();
            say(`  ✕ 原来的服务也没起回来(${now.line})。`);
            const tail = [...envLines(dataEnv), restartCommand(), checkDataCommand(port, dataDirFor(REPO, env))];
            if (now.stray) say(`    要手工重来,先结束它、等它真退,再起(依次执行):`);
            else say("    手工起(依次执行):");
            for (const c of [...(now.stray ? [`node scripts/stop.mjs --pid ${now.stray.pid} --born ${now.stray.born}`] : []), ...tail]) say(`       ${c}`);
          }
        }
        say("✕ 没有升级:库留不了底就不往下做。腾出空间(或修好权限)再跑一次。");
        process.exit(1);
      }
      state.inProgress.backup = b?.dir ?? null;
      // 备份里那份库和它的指纹记下来:核对认的就是它,它后来不见了、被换过、读不动 = 没核对成,不是「升级前没有库」。
      state.inProgress.backupFile = b?.baseline?.file ?? null;
      state.inProgress.backupDigest = b?.baseline?.digest ?? null;
      save();
    }
    say(state.inProgress.backup ? `  ✓ ${state.inProgress.backup}` : "  · 还没有库(新安装),不用留底");
    // 老格式的进度(没记 backupFile)照目录认出那份库,但没有指纹 —— 核对会如实说认不准,不当成升级前没有库。
    const baseline = state.inProgress.backupFile ? { file: state.inProgress.backupFile, digest: state.inProgress.backupDigest }
      : state.inProgress.backup && state.inProgress.backupFile === undefined
        ? { file: dbInBackup(state.inProgress.backup, data.db, data.explicit), digest: null } : null;

    if (built) {
      say("▶ 3/6 依赖和构建已经是这一版的,跳过");
    } else {
      say("▶ 3/6 装依赖、构建(shared → web → server → mcp)…");
      const npm = (args) => spawnSync(NPM, args, { stdio: "inherit", ...NPM_SPAWN_OPTS }).status;
      if (npm(["install", "--no-audit", "--no-fund"]) !== 0) await fail("依赖没装上(npm install 失败,报错在上面)");
      if (npm(["run", "build"]) !== 0) await fail("构建失败(报错在上面)");
      state.built = { commit: head, stamp: buildStamp(products) };
      save();
    }

    say("▶ 4/6 库改名…");
    let dbOutcome = data.rename;
    if (["todo", "resume", "taken"].includes(data.rename)) {
      const r = renameDb({ dataDir, env, say });
      if (r.code === 0) dbOutcome = "renamed";
      else if (r.journalLeft) {
        await fail("库改名中途失败,而且没能照账本退回,账本还在,服务在它处理掉之前起不来", [
          `· 先看清现状:node scripts/rename-db.mjs --data ${shellArg(dataDir)}`,
          "  再 --apply 接着做完、或 --rollback 退回;然后再跑一次 npm run upgrade。",
        ]);
      } else {
        dbOutcome = "failed";
        say(`  ⚠ 库名没改成(原因在上面),照旧用 ${LEGACY_DB_FILE} 起服务,其余照常升。`);
      }
    }
    if (dbOutcome !== "failed" && dbOutcome !== "renamed") {
      say({
        keep: `  · 按 --keep-db-name 留着 ${LEGACY_DB_FILE}`, explicit: "  · 设了 NAVI_DB:库在哪、叫什么都按它,不改名",
        done: `  · 库已经叫 ${DB_FILE_NAME}`, none: `  · 还没有库,服务起来会直接建 ${DB_FILE_NAME}`,
      }[dbOutcome]);
    }

    say(`▶ 5/6 起服务 :${port}…`);
    const launched = await launch();
    if (!launched.ok) {
      const why = { spawn: "启动命令拉不起来", impostor: `端口上应答的是 pid ${launched.impostor},不是刚起的那个`, timeout: `等了 ${START_TIMEOUT}s 还没就绪`, exited: "新服务一起来就退出了" }[launched.why];
      let tail = [];
      try { tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-12); } catch { /* 没有日志 */ }
      if (tail.length) { say(`  日志 ${log} 最后几行:`); for (const l of tail) say(`     │ ${l}`); }
      await fail(`新服务没起来:${why}`);
    }
    state.servedPid = launched.pid;
    state.servedDb = dbIdentity(dbFileFor(REPO, env)); // 新装的库是服务刚建的:这时候才有它
    save();
    say(`  ✓ :${port} 已就绪(pid ${launched.pid},日志 ${log})`);

    say("▶ 6/6 核对数据、收尾…");
    // 核对有三种结局:都在 / 有缺 / 没核对成。后两种都不算升好:记进 verifyPending,往后每次升级都先补核它(settleChecks)。
    const v = settleChecks(debts.mine, baseline, dbFileFor(REPO, env), ctx);
    keepDebts(v.left);
    await refreshMcp({ repo: REPO, port, lockFile: lockFileFor(REPO, env), skip: options.skipMcp, force: false, say, command: restartCommand });
    registerMcp();

    const backup = state.inProgress.backup;
    state.last = { from, to: head, at: new Date().toISOString(), db: state.servedDb, backup };
    delete state.inProgress;
    save();
    const branch = inspectCheckout(REPO).branch ?? "?";
    const ok = v.ok;
    printSummary(say, {
      ok, from, head, branch, commits: from === head ? 0 : countBetween(REPO, from, head),
      db: dbFileFor(REPO, env), dbOutcome, backup, check: v.line, port, pid: launched.pid, log,
      rollback: from !== head ? rollbackFor({ serverRunning: true }) : null,
    });
    process.exit(ok ? 0 : 1);
  } catch (error) {
    await fail(`升级中途出了意外:${error.message}`);
  }
}

if (options.continue) await apply();
else await prepare();
