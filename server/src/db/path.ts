import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readStorageEnv } from "@navi/shared/env-names";
import { LEGACY_DB_FILE, LEGACY_HARNESS_DB_FILE } from "@navi/shared/legacy-names";
import { DATA_DIR } from "../paths.js";

/** 改名之后的库文件名。在就用它（停机时跑本地目录迁移脚本改过名的安装）。 */
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
 * 没显式指定库文件时用哪一份：`navi.db` 在就用它，不然是 `ash.db`。**运行时不改库的名字**：
 *
 *  · 改名要连着 `-wal`、`-shm`、单例锁、退出账本一起挪，而判断「此刻没有别的服务开着它」靠的
 *    正是挂在库文件名上的那把锁 —— 在拿锁之前挪，正在跑的旧版服务手里的文件就被换了名；
 *  · 旧版服务只认 `ash.db`。新版一旦改了名，回退到旧版就会对着一份空库起来。
 *
 * **新安装暂时也建 `ash.db`**：mac 应用（`desktop/macos`）判断数据目录用没用过、升级前给库留底、
 * 导入数据，都按 `ash.db` 这个名字找 —— 建成 `navi.db` 的话，它每次启动都当这是第一次用，导入的
 * 库也会被晾在一边。拆：mac 应用认得 `navi.db` 之后，新安装改建 `navi.db`。
 *
 * 更早的 `harness.db` 照旧就地改名成 `ash.db`（那一代没有并存的旧版服务）。
 */
function defaultDbFile(): string {
  if (existsSync(DEFAULT_DB)) return DEFAULT_DB;
  migrateLegacyDbFiles(LEGACY_DEFAULT_DB, HARNESS_DEFAULT_DB);
  return LEGACY_DEFAULT_DB;
}

export function resolveNaviDbFile() {
  const explicit = readStorageEnv(process.env, "NAVI_DB");
  if (explicit) return resolve(explicit);
  return resolve(defaultDbFile());
}

export function ensureNaviDbDir(dbFile = resolveNaviDbFile()) {
  mkdirSync(dirname(dbFile), { recursive: true });
}
