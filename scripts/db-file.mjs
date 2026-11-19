// 库文件叫什么、一个数据目录里认哪一份 —— `server/src/db/path.ts` 的脚本侧镜像（脚本要在没有构建产物的
// 检出里裸跑，导不了那份 .ts）。两份一致由 `server/scripts/test-db-file.ts` 钉住。各条「为什么」写在那份里。
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_DB_FILE, LEGACY_PRESENCE_PREFIX, LEGACY_RESOURCE_CLAIM_SUFFIX, LEGACY_SINGLETON_LOCK_SUFFIX } from "./legacy-names.mjs";

export const DB_FILE_NAME = "navi.db";
export const DB_MOVED_MARKER = "NAVI-DB-MOVED";
export const DB_RENAME_JOURNAL = `${DB_FILE_NAME}.renaming`;

/**
 * 跟着库文件名走、要随库一起改名的文件（`${库}${后缀}`）：SQLite 自己的 -wal/-shm/-journal，退出账本、卡死判定账本
 * （各带一份轮转出来的 `.1`），接力身份、远程访问密钥、飞书配置。漏一项，改名之后服务就当它从没有过（身份换新、
 * 访问密钥作废）。`server/scripts/test-db-file.ts` 拿服务端各处的后缀常量对这份清单。
 */
export const DB_CARRIED_SUFFIXES = [
  "-wal", "-shm", "-journal",
  ".exits.jsonl", ".exits.jsonl.1", ".stall-verdicts.jsonl", ".stall-verdicts.jsonl.1",
  ".identity.json", ".remote-access.json", ".feishu.json",
];

/**
 * 挂在库名上、只对「那一刻在跑的进程」有意义的文件：单例锁、资源占用锁、在线登记（新旧两代名字）。迁移前已经
 * 确认它们的主人都不在了，改名时不带过去（带过去会被下一个服务当成「上一轮没收干净」），挪进留底目录。
 * 维护锁不在其中：迁移自己正拿着这份库的那一把。
 */
export function isRuntimeResidue(name, db) {
  if (!name.startsWith(db)) return false;
  const rest = name.slice(db.length);
  return [".navi.lock", LEGACY_SINGLETON_LOCK_SUFFIX, ".navi-claim.lock", LEGACY_RESOURCE_CLAIM_SUFFIX].includes(rest)
    || ([".navi-online.", LEGACY_PRESENCE_PREFIX].some((p) => rest.startsWith(p)) && rest.endsWith(".json"));
}

/** 旧名那一份是什么：不在 / 迁移留下的路标 / 一份库（认不出的一律按库算）。 */
export function legacyDbState(file) {
  if (!existsSync(file)) return "absent";
  const head = Buffer.alloc(DB_MOVED_MARKER.length);
  let fd = null;
  try {
    fd = openSync(file, "r");
    const read = readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.toString("latin1") === DB_MOVED_MARKER ? "moved" : "present";
  } catch {
    return "present";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * 只为「找到服务开的是哪一份」（停服务时找它的锁、组预览时拷它、迁目录时清点它），不报错：`navi.db` 在就是它；
 * 不然旧名那份是库就是它；都没有就是 `navi.db`（服务起来会建的那份）。认不准、服务会拒绝启动的那几种情形
 * （两份都是库、账本还在）也照这个顺序给一个，交给服务自己说清楚。
 */
export function dbFileIn(dataDir) {
  const current = join(dataDir, DB_FILE_NAME);
  if (existsSync(current)) return current;
  const legacy = join(dataDir, LEGACY_DB_FILE);
  return legacyDbState(legacy) === "present" ? legacy : current;
}
