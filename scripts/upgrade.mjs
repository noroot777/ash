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
// 不让这一项作废整次升级。做到哪记在数据目录的 upgrade.json(upgrade-data.mjs),再跑接着做;已是最新就说一句,不重启服务。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FILE_NAME } from "./db-file.mjs";
import { readEnv } from "./env.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { registerNaviMcp } from "./mcp-register.mjs";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { IS_WINDOWS } from "./platform.mjs";
import { inspect } from "./rename-db-core.mjs";
import { restartCommand } from "./restart-options.mjs";
import { dbFileFor, lockFileFor, takeDown } from "./server-control.mjs";
import { launchServer, refreshMcp } from "./server-start.mjs";
import { identifyServer, inspectData, resolvePort, runtimeProblems } from "./upgrade-checks.mjs";
import { backupDb, compareIds, dbInBackup, readIds, readState, renameDb, writeState } from "./upgrade-data.mjs";
import {
  beforeLastPull, countBetween, fastForward, fetchRemote, inspectCheckout, isAncestor, relation, resetKeep, revParse, short,
  showFile, untrackedCollisions,
} from "./upgrade-git.mjs";
import { parseUpgradeOptions, upgradeCommand, UPGRADE_USAGE, userArgs } from "./upgrade-options.mjs";
import { printRollback, printSummary, rollbackCommands } from "./upgrade-report.mjs";
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
  const { port, from: portFrom } = data.problems.length ? { port: 0 } : resolvePort(REPO, env);
  const server = data.problems.length ? null : await identifyServer({ repo: REPO, env, port, dataDir: data.dataDir, explicit: data.explicit });
  if (server) problems.push(...server.problems);
  if (problems.length) {
    say("");
    for (const p of problems) say(`  ✕ ${p}`);
    return abort(2);
  }
  for (const w of data.warnings) say(`  ⚠ ${w}`);
  return { data, port, portFrom, server };
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
    stdio: "inherit", env: { ...env, PORT: String(ctx.port) },
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
  dataDir = data.dataDir;
  state = readState(dataDir);
  const log = logFor(port);
  const resumed = state.inProgress ?? null;
  const lastTo = state.last?.to && state.last.to !== head && isAncestor(REPO, state.last.to, head) ? state.last.to : null;
  const from = resumed?.from ?? pulledFrom ?? lastTo ?? beforeLastPull(REPO) ?? head;
  const entry = isAbsolute(SERVER_ENTRY) ? SERVER_ENTRY : join(REPO, SERVER_ENTRY);
  const built = state.built === head && [entry, join(REPO, "mcp", "dist", "index.js"), join(REPO, "web", "dist", "index.html")].every(existsSync);
  const renameNow = ["todo", "resume"].includes(data.rename);
  const serving = ctx.server.running && state.servedPid && ctx.server.health?.pid === state.servedPid;
  if (!resumed && built && !renameNow && serving) {
    say(`✓ 已是最新:代码 ${short(head)},库 ${data.db},服务 http://localhost:${port}(pid ${state.servedPid})在跑。什么都没动。`);
    process.exit(0);
  }
  if (resumed) say(`  · 上次升级(从 ${short(resumed.from)} 起)没做完,接着做`);
  state.inProgress = { ...(resumed ?? { from, startedAt: new Date().toISOString() }), to: head };
  createdProgress = !resumed;
  writeState(dataDir, state);
  const save = () => writeState(dataDir, state);

  /** 停服务之后失败:停在这一步,给两条路。 */
  const fail = (reason, extra = []) => {
    say("");
    say(`✕ ${reason}。服务现在没在跑。`);
    for (const line of extra) say(`  ${line}`);
    say(`  · 修好原因后再跑一次 npm run upgrade(或 ${upgradeCommand()}):从这一步接着做,库备份不会重做。`);
    printRollback(say, rollbackFor(false));
    process.exit(1);
  };
  /** 退回 from 那一版的命令。库现在叫 navi.db、那一版又认不得它,就先(用新版)退回旧名。 */
  const rollbackFor = (serverRunning) => {
    // 那一版的服务开不开得了 navi.db:看它自己选库的那份代码(改名之前的版本里没有这个名字)。
    const fromKnowsNavi = (showFile(REPO, from, "server/src/db/path.ts") ?? "").includes(JSON.stringify(DB_FILE_NAME));
    const renameBack = !data.explicit && !fromKnowsNavi && inspect(dataDir).state === "renamed";
    return { repo: REPO, backup: state.inProgress?.backup ?? state.last?.backup, cmds: rollbackCommands({ from, head, port, serverRunning, renameBack, dataDir }) };
  };

  say(`▶ 1/6 停服务 :${port}…`);
  const down = await takeDown(takeDownArgs(ctx, { abort: undoPull }));
  createdProgress = false; // 服务动过了,往后不再退回代码
  say(down.running ? `  ✓ :${port} 已停` : `  · :${port} 本来就没在跑`);

  say("▶ 2/6 给库留底…");
  if (!state.inProgress.backup) {
    let b;
    try {
      b = backupDb({ backupRoot: data.backupRoot, db: data.db, explicit: data.explicit, stamp });
    } catch (error) {
      // 依赖、构建产物都还是原来的:把原来的服务原样起回来,升级这次不做。
      say(`  ✕ 留底没成:${error.message}`);
      delete state.inProgress;
      try { save(); } catch { /* 磁盘满时这里也写不进去;下次再跑会重新判断 */ }
      if (pulledFrom) resetKeep(REPO, pulledFrom);
      if (down.running) {
        const back = await launchServer({ port, log, serverNode: SERVER_NODE, serverEntry: SERVER_ENTRY, startTimeout: START_TIMEOUT, env: { ...env, PORT: String(port) } });
        say(back.ok ? `  ↩ 原来的服务已经照原样起回来了(pid ${back.pid})` : `  ✕ 原来的服务也没起回来,看 ${log};手工起:${restartCommand()}`);
      }
      say("✕ 没有升级:库留不了底就不往下做。腾出空间(或修好权限)再跑一次。");
      process.exit(1);
    }
    state.inProgress.backup = b?.dir ?? null;
    save();
  }
  say(state.inProgress.backup ? `  ✓ ${state.inProgress.backup}` : "  · 还没有库(新安装),不用留底");
  let before = null;
  const backupFile = state.inProgress.backup && dbInBackup(state.inProgress.backup, data.db, data.explicit);
  if (backupFile) {
    try { before = readIds(backupFile, { readOnly: false }); }
    catch (error) { say(`  ⚠ 备份里的库读不出来(${error.message}),升完没法逐条核对`); }
  }

  if (built) {
    say("▶ 3/6 依赖和构建已经是这一版的,跳过");
  } else {
    say("▶ 3/6 装依赖、构建(shared → web → server → mcp)…");
    const npm = (args) => spawnSync(NPM, args, { stdio: "inherit", ...NPM_SPAWN_OPTS }).status;
    if (npm(["install", "--no-audit", "--no-fund"]) !== 0) fail("依赖没装上(npm install 失败,报错在上面)");
    if (npm(["run", "build"]) !== 0) fail("构建失败(报错在上面)");
    state.built = head;
    save();
  }

  say("▶ 4/6 库改名…");
  let dbOutcome = data.rename;
  if (["todo", "resume", "taken"].includes(data.rename)) {
    const r = renameDb({ dataDir, env, say });
    if (r.code === 0) dbOutcome = "renamed";
    else if (r.journalLeft) {
      fail("库改名中途失败,而且没能照账本退回,账本还在,服务在它处理掉之前起不来", [
        `· 先看清现状:node scripts/rename-db.mjs --data ${dataDir}`,
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
  const launched = await launchServer({ port, log, serverNode: SERVER_NODE, serverEntry: SERVER_ENTRY, startTimeout: START_TIMEOUT, env: { ...env, PORT: String(port) } });
  if (!launched.ok) {
    const why = { spawn: "启动命令拉不起来", impostor: `端口上应答的是 pid ${launched.impostor},不是刚起的那个`, timeout: `等了 ${START_TIMEOUT}s 还没就绪`, exited: "新服务一起来就退出了" }[launched.why];
    let tail = [];
    try { tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-12); } catch { /* 没有日志 */ }
    if (tail.length) { say(`  日志 ${log} 最后几行:`); for (const l of tail) say(`     │ ${l}`); }
    fail(`新服务没起来:${why}`);
  }
  state.servedPid = launched.pid;
  save();
  say(`  ✓ :${port} 已就绪(pid ${launched.pid},日志 ${log})`);

  say("▶ 6/6 核对数据、收尾…");
  let ok = true;
  let check = "没核对(升级前没有库)";
  if (before) {
    try {
      const rows = compareIds(before, readIds(dbFileFor(REPO, env), { readOnly: true }));
      const missing = rows.filter((r) => r.missing.length);
      check = rows.map((r) => `${r.label} ${r.before} → ${r.after}`).join(" · ");
      if (missing.length) {
        ok = false;
        for (const r of missing) say(`  ✕ ${r.label}少了 ${r.missing.length} 条(id ${r.missing.slice(0, 5).join("、")}${r.missing.length > 5 ? " …" : ""})。先别动库备份,照下面的办法退回再查`);
        check += ",有缺(见上面)";
      } else {
        check += ",升级前的每一条都还在";
        say(`  ✓ ${check}`);
      }
    } catch (error) {
      check = `没核对成:${error.message}`;
      say(`  ⚠ ${check}`);
    }
  } else if (backupFile) {
    check = "没核对成(备份读不出来)";
  }
  await refreshMcp({ repo: REPO, port, lockFile: lockFileFor(REPO, env), skip: options.skipMcp, force: false, say, command: restartCommand });
  if (!options.skipMcp) {
    // 迁不了不算升级失败:说一句就行(setup 那份逻辑,各家各报各的)。
    try {
      registerNaviMcp({ repo: REPO, port, ok: (l) => say(`  ✓ ${l}`), warn: (l) => say(`  ⚠ ${l}`), say });
    } catch (error) {
      say(`  ⚠ MCP 登记没迁成:${error.message}(不影响服务;之后跑一次 npm run setup 再试)`);
    }
  }

  const backup = state.inProgress.backup;
  state.last = { from, to: head, at: new Date().toISOString(), backup };
  delete state.inProgress;
  save();
  const branch = inspectCheckout(REPO).branch ?? "?";
  printSummary(say, {
    ok, from, head, branch, commits: from === head ? 0 : countBetween(REPO, from, head),
    db: dbFileFor(REPO, env), dbOutcome, backup, check, port, pid: launched.pid, log,
    rollback: from !== head ? rollbackFor(true) : null,
  });
  process.exit(ok ? 0 : 1);
}

if (options.continue) await apply();
else await prepare();
