// 升级里碰数据的那几步:停着服务时给库留底、核对升级前后每一条都还在、把库改名交给 ⑨ 的改名命令、记下升级做到哪。
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * 服务停着的时候把库连同跟着库名走的文件(身份、访问密钥、账本、-wal/-shm)原样拷进 `<数据目录>/backups/upgrade-<时间>/`。
 * 新旧两个库名下的都拷(上次改名做到一半时两边各有一些),改名账本也拷。返回 { dir, files };一个都没有返回 null。
 */
export function backupDb({ backupRoot, db, explicit, stamp }) {
  const sources = explicit ? dbNamespace(db)
    : [...dbNamespace(join(backupRoot, LEGACY_DB_FILE)), ...dbNamespace(join(backupRoot, DB_FILE_NAME)), join(backupRoot, DB_RENAME_JOURNAL)];
  const files = sources.filter((f) => lstatSync(f, { throwIfNoEntry: false })?.isFile());
  if (!files.length) return null;
  let dir = join(backupRoot, "backups", `upgrade-${stamp}`);
  for (let n = 2; existsSync(dir); n += 1) dir = join(backupRoot, "backups", `upgrade-${stamp}-${n}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) copyFileSync(f, join(dir, basename(f)), constants.COPYFILE_EXCL);
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
 * 升级做到哪了,记在数据目录里(跟着这份数据走;不进 git):
 *   built      最后一次构建成功时的提交      servedPid  最后一次起好的服务
 *   inProgress { from, to, backup }        有它 = 上次没做完,再跑接着做(from 和备份沿用那一次的)
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
