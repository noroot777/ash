// 升级在动任何东西之前要回答的几件事:这台机器的 Node/npm 够不够、数据目录认不认得准、端口上那个服务是不是
// 这份检出 + 这份数据起的。每个函数只回答、不改;答不上来的一律当问题报出来,由调用方在停服务之前拦下。
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NPM } from "./npm.mjs";
import { DB_FILE_NAME, DB_RENAME_JOURNAL, legacyDbState } from "./db-file.mjs";
import { readStorageEnv } from "./env.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { IS_WINDOWS, isPidAlive, localJson, runCli } from "./platform.mjs";
import { inspect, planSteps, readJournal } from "./rename-db-core.mjs";
import { satisfiesRange, sqliteUsable } from "./runtime-check.mjs";
import { dataDirFor, isPortQuiet, lockFileFor } from "./server-control.mjs";

/** 新版要的 Node/npm 这台机器给不给得起。pkg 是**要升到的那一版**的 package.json。 */
export function runtimeProblems(pkg) {
  const problems = [];
  const nodeRange = pkg?.engines?.node;
  if (satisfiesRange(process.versions.node, nodeRange) === false) {
    problems.push(`node v${process.versions.node} 不够新,新版要 ${nodeRange}(建议装 24)`);
  } else if (!sqliteUsable()) {
    problems.push(`node v${process.versions.node} 带不动内置的 node:sqlite(Navi 的数据库),换 22.16 以上(建议 24)`);
  }
  const pm = pkg?.devEngines?.packageManager;
  if (pm?.name === "npm" && pm.version) {
    const res = runCli(NPM, ["-v"]);
    const version = res.stdout.trim();
    if (res.status !== 0 || !version) problems.push("找不到 npm(装依赖要用它)");
    else if (satisfiesRange(version, pm.version) === false) problems.push(`npm ${version} 不够新,新版要 ${pm.version}:npm install -g npm@latest`);
  }
  return problems;
}

function describe(file) {
  try {
    const s = statSync(file);
    return `${(s.size / 1024 / 1024).toFixed(1)} MB,最后修改 ${s.mtime.toLocaleString()}`;
  } catch { return "不在"; }
}

/**
 * 数据目录此刻的样子,以及这次升级对库名要做什么(⑨ 的判定原样沿用:rename-db-core 的 inspect)。
 *   rename: done 已经叫 navi.db / todo 要改 / resume 上次改到一半、接着做完 / taken 想改但目标名下已有东西
 *           keep 按 --keep-db-name 不改 / explicit 设了 NAVI_DB、按它的设置走 / none 还没有库
 */
export function inspectData({ repo, env, keepDbName, stamp }) {
  const problems = [];
  const warnings = [];
  let dataDir;
  let explicit;
  try {
    dataDir = dataDirFor(repo, env);
    explicit = readStorageEnv(env, "NAVI_DB");
  } catch (error) {
    return { problems: [error.message], warnings };
  }
  if (explicit) {
    const db = resolve(explicit);
    if (legacyDbState(db) === "moved") problems.push(`NAVI_DB(旧名也算)指着 ${db},那是库改名留下的路标、不是库:把它改成 ${join(dirname(db), DB_FILE_NAME)} 再跑`);
    if (existsSync(join(dirname(db), DB_RENAME_JOURNAL))) problems.push(`${dirname(db)} 里的库改名上次没做完(${DB_RENAME_JOURNAL} 还在):先 node scripts/rename-db.mjs --data ${dirname(db)} 看清楚再处理`);
    return { problems, warnings, dataDir, db, explicit: true, rename: "explicit", backupRoot: dirname(db) };
  }
  const now = inspect(dataDir);
  const out = { problems, warnings, dataDir, db: now.state === "legacy" ? now.legacy : now.navi, explicit: false, backupRoot: dataDir };
  if (now.state === "both") {
    problems.push(`${DB_FILE_NAME} 和 ${LEGACY_DB_FILE} 都是库,分不清哪份是在用的(服务在这种情况下也不起):\n`
      + `       ${now.navi}:${describe(now.navi)}\n       ${now.legacy}:${describe(now.legacy)}\n`
      + "     确认要留哪一份,把另一份(连同它名字开头的 -wal、-shm、.identity.json 等)挪出数据目录再跑");
  } else if (now.state === "orphan") {
    problems.push(`${now.legacy} 是改名留下的路标,但 ${now.navi} 不在。库被挪走了?放回来再跑`);
  } else if (now.state === "interrupted") {
    let journal = null;
    try { journal = readJournal(dataDir); } catch (error) { problems.push(error.message); }
    if (journal && journal.direction === "forward" && journal.phase === "do") out.rename = "resume";
    else if (journal) problems.push(`上次的库退回(或撤销)没做完,先跑 node scripts/rename-db.mjs --data ${dataDir} 看清楚,用 --rollback 处理掉再升级`);
    out.db = now.legacy;
  } else if (now.state === "legacy") {
    if (keepDbName) out.rename = "keep";
    else {
      const { taken } = planSteps(dataDir, { direction: "forward", stamp });
      out.rename = taken.length ? "taken" : "todo";
      if (taken.length) {
        warnings.push(`库名改不了:${taken.join("、")} 已经有东西了(哪一份是真的只有人能认)。这次照旧用 ${LEGACY_DB_FILE},`
          + `其余照常升;收拾好之后再跑一次 npm run upgrade 就会改`);
      }
    }
  } else {
    out.rename = now.state === "renamed" ? "done" : "none";
  }
  return out;
}

/** 不设 PORT 时就按这份库的锁文件里记的端口来(服务就是在那儿起的),再没有才是 4317。 */
export function resolvePort(repo, env) {
  if (env.PORT) return { port: Number(env.PORT), from: "PORT" };
  try {
    const lock = JSON.parse(readFileSync(lockFileFor(repo, env), "utf8"));
    if (Number.isInteger(lock?.port) && lock.port > 0) return { port: lock.port, from: "lock" };
  } catch { /* 没有锁:服务没起过,或者早就停了 */ }
  return { port: 4317, from: "default" };
}

function samePath(a, b) {
  const norm = (p) => {
    let r = resolve(p);
    try { r = realpathSync.native(r); } catch { /* 不在就按字面比 */ }
    return IS_WINDOWS ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function readLock(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * 端口上那个服务是不是**这份检出 + 这份数据**起的。认错的代价是停错一个服务、备份改名另一份数据,所以宁可拦下:
 * 新旧两代服务的 /api/health 对本机直连都报 instance.codeDir / dataDir,先认它;显式 NAVI_DB 或没有 instance 时
 * 再拿单例锁里记的端口、pid 对一遍。没在跑时也看一眼锁:这份库正被别的端口上的服务开着,在这个端口上起一个只会撞锁。
 */
export async function identifyServer({ repo, env, port, dataDir, explicit }) {
  const problems = [];
  const lockFile = lockFileFor(repo, env);
  const lock = readLock(lockFile);
  const health = await localJson(port, "/api/health");
  if (!health) {
    if (!(await isPortQuiet(port))) problems.push(`:${port} 被占着,但应答的不是 Navi(或者它卡住了)。确认端口对不对(PORT),或者先把占着它的程序停掉`);
    else if (lock && Number.isInteger(lock.pid) && isPidAlive(lock.pid) && lock.port && lock.port !== port) {
      problems.push(`这份库正被 :${lock.port} 上的服务(pid ${lock.pid})开着,而这一次按 :${port} 算。照启动服务时那样设好 PORT 再跑`);
    }
    return { running: false, problems, lockFile };
  }
  const hint = "照启动服务时那套环境变量(PORT、NAVI_DATA_DIR、NAVI_DB)再跑";
  const inst = health.instance;
  if (inst?.codeDir && !samePath(inst.codeDir, repo)) {
    problems.push(`:${port} 上的 Navi 是从 ${inst.codeDir} 起的,不是这份检出(${repo})。端口对吗?${hint}`);
  } else if (inst?.dataDir && !samePath(inst.dataDir, dataDir)) {
    problems.push(`:${port} 上的 Navi 用的数据目录是 ${inst.dataDir},这一次按 ${dataDir} 算。${hint}`);
  } else if (!inst || explicit) {
    if (!lock) problems.push(`:${port} 上有 Navi 在应答,但 ${lockFile} 不在 —— 认不出它开的是不是这份库。${hint}`);
    else if (lock.port !== port || (health.pid && lock.pid !== health.pid)) {
      problems.push(`:${port} 上应答的 Navi(pid ${health.pid ?? "?"})不是 ${lockFile} 里记的那个(pid ${lock.pid},端口 ${lock.port})。${hint}`);
    }
  }
  return { running: true, health, problems, lockFile };
}
