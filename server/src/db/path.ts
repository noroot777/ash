import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "../paths.js";

const DEFAULT_DB = join(DATA_DIR, "ash.db");
const LEGACY_DEFAULT_DB = join(DATA_DIR, "harness.db");

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

function migrateLegacyDefaultDb() {
  migrateLegacyDbFiles(DEFAULT_DB, LEGACY_DEFAULT_DB);
}

export function resolveAshDbFile() {
  if (process.env.ASH_DB) return resolve(process.env.ASH_DB);
  migrateLegacyDefaultDb();
  return resolve(DEFAULT_DB);
}

export function ensureAshDbDir(dbFile = resolveAshDbFile()) {
  mkdirSync(dirname(dbFile), { recursive: true });
}
