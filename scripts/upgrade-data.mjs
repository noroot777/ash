// 升级里碰数据的那几步:停着服务时给库留底、核对升级前后每一条都还在、把库改名交给 ⑨ 的改名命令、记下升级做到哪。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FILE_NAME, DB_RENAME_JOURNAL, legacyDbState } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";
import { dbNamespace } from "./rename-db-core.mjs";

const RENAME_DB = fileURLToPath(new URL("./rename-db.mjs", import.meta.url));

/** 升级前后要一条不少的那三张表。 */
export const CHECKED_TABLES = [["projects", "项目"], ["tasks", "任务"], ["sessions", "会话"]];

/**
 * 要留底的那几个文件:库连同跟着库名走的文件(身份、访问密钥、账本、-wal/-shm),新旧两个库名下的都算(上次改名做到一半时
 * 两边各有一些),改名账本也算。软链照它指向的那份拷(库放在别的盘上、拿软链接过来是正经装法);在、却拷不了的(软链指着
 * 的东西不在、是个目录)就是认不准这份库长什么样 —— 记成 problems,升级在停服务之前拦下,不能把它当「没有库」跳过留底。
 * 返回 { files, problems }。
 */
export function backupSources({ backupRoot, db, explicit }) {
  const sources = explicit ? dbNamespace(db)
    : [...dbNamespace(join(backupRoot, LEGACY_DB_FILE)), ...dbNamespace(join(backupRoot, DB_FILE_NAME)), join(backupRoot, DB_RENAME_JOURNAL)];
  const files = [];
  const problems = [];
  for (const f of sources) {
    const link = lstatSync(f, { throwIfNoEntry: false });
    if (!link) continue;
    if (statSync(f, { throwIfNoEntry: false })?.isFile()) files.push(f);
    else problems.push(`${f} 在,却不是能拷的文件(${link.isSymbolicLink() ? "软链指着的东西不在了" : "是个目录或别的东西"}),认不准这份库长什么样,没法留底;先收拾好它再跑`);
  }
  return { files, problems };
}

/**
 * 服务停着的时候把 backupSources 列出来的文件原样拷进 `<数据目录>/backups/upgrade-<时间>/`,拷完逐个核对大小。
 * 返回 { dir, files };一个都没有返回 null;认不准、拷不全就抛出去(调用方把原来的服务起回来,这次不升)。
 */
export function backupDb({ backupRoot, db, explicit, stamp }) {
  const { files, problems } = backupSources({ backupRoot, db, explicit });
  if (problems.length) throw new Error(problems.join(";"));
  if (!files.length) return null;
  let dir = join(backupRoot, "backups", `upgrade-${stamp}`);
  for (let n = 2; existsSync(dir); n += 1) dir = join(backupRoot, "backups", `upgrade-${stamp}-${n}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const to = join(dir, basename(f));
    copyFileSync(f, to, constants.COPYFILE_EXCL);
    if (statSync(to).size !== statSync(f).size) throw new Error(`${f} 拷进备份之后大小对不上`);
  }
  return { dir, files: files.map((f) => basename(f)) };
}

/** 备份里那份库(核对「升级前」的数字就读它:停服务那一刻的一致快照,读它也不碰真库)。 */
export function dbInBackup(dir, db, explicit) {
  if (explicit) return join(dir, basename(db));
  const navi = join(dir, DB_FILE_NAME);
  if (existsSync(navi)) return navi;
  const legacy = join(dir, LEGACY_DB_FILE);
  return legacyDbState(legacy) === "present" ? legacy : null;
}

/**
 * 三张表的 id。备份那份用读写打开(是我们自己的拷贝,让 SQLite 把 -wal 合进来);服务起着时的真库只读打开。
 * 表还不存在(全新的库)算空;读不了就抛出去,由调用方如实说「没核对成」。
 */
export function readIds(file, { readOnly }) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(file, { readOnly });
  try {
    const out = {};
    for (const [table] of CHECKED_TABLES) {
      const exists = db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table);
      out[table] = exists ? db.prepare(`select id from ${table}`).all().map((r) => String(r.id)) : [];
    }
    return out;
  } finally {
    db.close();
  }
}

/** 升级前的每一条升级后还在不在:逐表报前后各多少、少了哪几条。 */
export function compareIds(before, after) {
  return CHECKED_TABLES.map(([table, label]) => {
    const have = new Set(after[table]);
    return { table, label, before: before[table].length, after: after[table].length, missing: before[table].filter((id) => !have.has(id)) };
  });
}

/**
 * 库改名直接跑 ⑨ 的改名命令(scripts/rename-db.mjs --apply):演练、维护锁、账本、做不完照原样退回、上次做到一半
 * 接着做完,全在那里。它的输出缩进一格原样转给人看。返回它的退出码(0 做完 / 2 拦下了、一步没做 / 3 失败)和
 * 账本还在不在 —— 账本在,服务就起不来。
 */
export function renameDb({ dataDir, env, say }) {
  const res = spawnSync(process.execPath, [RENAME_DB, "--apply", "--data", dataDir], { env, encoding: "utf8", windowsHide: true });
  for (const line of `${res.stdout ?? ""}${res.stderr ?? ""}`.split("\n")) if (line.trim()) say(`     │ ${line}`);
  return { code: res.status ?? 3, journalLeft: existsSync(join(dataDir, DB_RENAME_JOURNAL)) };
}

/**
 * 依赖和构建产物此刻的指纹:各产物目录里**每个文件**的相对路径 + 内容,加上 npm 自己记的已装依赖清单(node_modules/.package-lock.json,
 * npm 判断「装好了没有」认的也是它)。「这一版构建过」不能只认提交号:中间有人跑了别的版本的 restart / build(比如照抄
 * 退回命令回到旧版),产物就换了,提交号却对得上 —— 实测过,新代码配旧产物起不来。也不能只看几个入口文件:server / mcp
 * 是多文件输出、网页的脚本在 assets 里,删掉其中一个入口照样在,服务却在用到它时才坏。
 */
export function buildStamp(paths) {
  const hash = createHash("sha256");
  const add = (path, rel) => {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return hash.update(`${rel}\0-\0`);
    if (st.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(join(path, name), `${rel}/${name}`);
      return undefined;
    }
    hash.update(`${rel}\0${st.size}\0`);
    return hash.update(readFileSync(path));
  };
  for (const p of paths) add(p, p);
  return hash.digest("hex");
}

/**
 * 升级前后核对:备份里那份(停服务那一刻的一致快照)跟现在的库比,每一条都还在没有。
 * 返回 { state: "ok" | "missing" | "unverified", line, rows }。读不出来就是 unverified —— 「没发现少」不等于「核对过了」,
 * 调用方不能拿它宣布升好了。
 */
export function verifyData(backupFile, liveFile) {
  let rows;
  try {
    rows = compareIds(readIds(backupFile, { readOnly: false }), readIds(liveFile, { readOnly: true }));
  } catch (error) {
    return { state: "unverified", line: `没核对成:${error.message}`, rows: [] };
  }
  const counts = rows.map((r) => `${r.label} ${r.before} → ${r.after}`).join(" · ");
  const missing = rows.filter((r) => r.missing.length);
  return missing.length
    ? { state: "missing", line: `${counts},有缺(见上面)`, rows }
    : { state: "ok", line: `${counts},升级前的每一条都还在`, rows };
}

/**
 * 升级做到哪了,记在数据目录里(跟着这份数据走;不进 git):
 *   built      最后一次构建成功时的 { commit, stamp }(stamp 见 buildStamp)
 *   verifyPending { backupFile }          数据核对还没过(读不出来、或者有缺):再跑会先补核,过了才清掉
 *   servedPid  最后一次起好的服务            port       这份安装的服务端口(锁收了之后再跑也找得到)
 *   inProgress { from, to, backup, backupFile } 有它 = 上次没做完,再跑接着做(from 和备份沿用那一次的;backupFile = 备份里那份库)
 *   last       上一次升好的那次:{ from, to, at, backup }
 */
export const stateFile = (dataDir) => join(dataDir, "upgrade.json");

export function readState(dataDir) {
  try { return JSON.parse(readFileSync(stateFile(dataDir), "utf8")) ?? {}; } catch { return {}; }
}

export function writeState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  const file = stateFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}
