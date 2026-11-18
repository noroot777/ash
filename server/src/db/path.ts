import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readEnv } from "@ash/shared/env-names";
import { LEGACY_DB_FILE, LEGACY_HARNESS_DB_FILE } from "@ash/shared/legacy-names";
import { DATA_DIR } from "../paths.js";

/** 新安装的库文件名。 */
export const DB_FILE_NAME = "navi.db";

const DEFAULT_DB = join(DATA_DIR, DB_FILE_NAME);
const LEGACY_DEFAULT_DB = join(DATA_DIR, LEGACY_DB_FILE);
const HARNESS_DEFAULT_DB = join(DATA_DIR, LEGACY_HARNESS_DB_FILE);

export function migrateLegacyDbFiles(defaultDb: string, legacyDb: string) {
  if (existsSync(defaultDb) || !existsSync(legacyDb)) return;
  mkdirSync(dirname(defaultDb), { recursive: true });
  const moves = ["-wal", "-shm", ""]
    .map((suffix) => ({ source: `${legacyDb}${suffix}`, target: `${defaultDb}${suffix}` }))
    .filter(({ source }) => existsSync(source));
  const occupied = moves.find(({ target }) => existsSync(target));
  if (occupied) throw new Error(`无法迁移旧数据库：目标已存在 ${occupied.target}`);
  for (const { source, target } of moves) renameSync(source, target);
}

/**
 * 没显式指定库文件时用哪一份。**改名之前的安装继续用 `ash.db`，运行时不改它的名字**：
 *
 *  · 改名要连着 `-wal`、`-shm`、单例锁、退出账本一起挪，而判断「此刻没有别的服务开着它」靠的
 *    正是挂在库文件名上的那把锁 —— 在拿锁之前挪，正在跑的旧版服务手里的文件就被换了名；
 *  · 旧版服务只认 `ash.db`。新版一旦改了名，回退到旧版就会对着一份空库起来。
 *
 * 所以：`navi.db` 在就用它；不在而 `ash.db` 在，就接着用 `ash.db`（改名交给停机状态下跑的本地
 * 目录迁移脚本）；都不在才是新安装。更早的 `harness.db` 照旧就地改名（那一代没有并存的旧版服务）。
 */
function defaultDbFile(): string {
  if (existsSync(DEFAULT_DB)) return DEFAULT_DB;
  if (existsSync(LEGACY_DEFAULT_DB)) return LEGACY_DEFAULT_DB;
  migrateLegacyDbFiles(DEFAULT_DB, HARNESS_DEFAULT_DB);
  return DEFAULT_DB;
}

export function resolveAshDbFile() {
  const explicit = readEnv(process.env, "NAVI_DB");
  if (explicit) return resolve(explicit);
  return resolve(defaultDbFile());
}

export function ensureAshDbDir(dbFile = resolveAshDbFile()) {
  mkdirSync(dirname(dbFile), { recursive: true });
}
