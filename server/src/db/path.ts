import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readStorageEnv } from "@navi/shared/env-names";
import { LEGACY_DB_FILE, LEGACY_HARNESS_DB_FILE } from "@navi/shared/legacy-names";
import { DATA_DIR } from "../paths.js";

// 库文件叫什么、一个数据目录里认哪一份。`scripts/db-file.mjs`（脚本要裸跑）与 mac 应用的 `NaviConfig.swift`
// 各有一份同口径的实现，前者由 `server/scripts/test-db-file.ts` 钉住一致。

/** 库文件名。新安装建它；改名之前的安装用 `ash.db`，停机时跑 `npm run rename-db` 改过来。 */
export const DB_FILE_NAME = "navi.db";
/**
 * 改名迁移把 `ash.db` 搬走之后在原地留的路标的开头。它不是 SQLite 库：改名之前的服务只认 `ash.db`，
 * 对着它起来会当场报「file is not a database」退出，而不是悄悄建一份空库接着跑。
 */
export const DB_MOVED_MARKER = "NAVI-DB-MOVED";
/** 改名迁移的账本，就放在数据目录里。它在 = 上次迁移没做完，服务不起（见 chooseDbFileIn）。 */
export const DB_RENAME_JOURNAL = `${DB_FILE_NAME}.renaming`;

const RENAME_COMMAND = "npm run rename-db";

export class DbFileChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbFileChoiceError";
  }
}

/** 旧名那一份是什么：不在 / 迁移留下的路标 / 一份库。认不出的东西一律按库算 —— 替人判它是垃圾的代价是丢数据。 */
export function legacyDbState(file: string): "absent" | "moved" | "present" {
  if (!existsSync(file)) return "absent";
  const head = Buffer.alloc(DB_MOVED_MARKER.length);
  let fd: number | null = null;
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
 * 数据目录里该开哪一份库：`navi.db` 在就是它；不在而 `ash.db` 是一份库，就开 `ash.db`（还没迁的老安装）；
 * 都没有就建 `navi.db`。**运行时不把 `ash.db` 改成 `navi.db`**：改名要连着 `-wal`、`-shm`、身份、访问密钥一起挪，
 * 而「此刻没有别的服务开着它」靠的正是挂在库文件名上的那把锁 —— 在拿锁之前挪，正在跑的另一个服务手里的文件就
 * 被换了名。所以改名只在停机时由 `scripts/rename-db.mjs` 做（它拿维护锁、记账本、做不完就照原样退回）。
 *
 * 认不准的时候不猜，直接不起，并说清怎么办：
 *  · 两份都是库：不知道哪份是真的，开错一份就是在旧数据上接着写、新数据被晾在一边；
 *  · 只剩路标、`navi.db` 不见了：开旧名会对着路标报错，建新库会让人以为数据丢了；
 *  · 账本还在：上次迁移做到一半，两边的文件可能各剩一半。
 *
 * 更早的 `harness.db` 就地改名成 `navi.db`（那一代没有并存的旧版服务，也没有跟着库名走的状态文件）。
 */
function refuseWhileRenaming(dataDir: string) {
  if (existsSync(join(dataDir, DB_RENAME_JOURNAL))) {
    throw new DbFileChoiceError(`${dataDir} 里的库改名（${LEGACY_DB_FILE} → ${DB_FILE_NAME}）上次没做完（${DB_RENAME_JOURNAL} 还在）。`
      + `停着服务跑 \`${RENAME_COMMAND} -- --apply\` 做完它，或 \`${RENAME_COMMAND} -- --rollback\` 退回去，再启动。`);
  }
}

export function chooseDbFileIn(dataDir: string): { file: string; legacy: boolean } {
  const current = join(dataDir, DB_FILE_NAME);
  const legacy = join(dataDir, LEGACY_DB_FILE);
  refuseWhileRenaming(dataDir);
  const old = legacyDbState(legacy);
  if (existsSync(current)) {
    if (old === "present") {
      throw new DbFileChoiceError(`${dataDir} 里 ${DB_FILE_NAME} 和 ${LEGACY_DB_FILE} 都是库，分不清该开哪一份，没有启动。`
        + `确认哪份是在用的数据，把另一份挪出数据目录再启动（跑 \`${RENAME_COMMAND}\` 会列出两边各有什么）。`);
    }
    return { file: current, legacy: false };
  }
  if (old === "present") return { file: legacy, legacy: true };
  if (old === "moved") {
    throw new DbFileChoiceError(`${dataDir} 里的 ${LEGACY_DB_FILE} 是改名迁移留下的路标，说库已经改名成 ${DB_FILE_NAME}，但 ${DB_FILE_NAME} 不在。`
      + "没有启动，免得对着一份空库起来。把库放回来，或者确认不要了就删掉那份路标。");
  }
  migrateLegacyDbFiles(current, join(dataDir, LEGACY_HARNESS_DB_FILE));
  return { file: current, legacy: false };
}

// 一个进程只开一份库，跟着库名走的锁、账本、身份也都得是同一份：选一次就记住，免得中途有人往数据目录里
// 放了一份 `ash.db`，后半程的派生文件指到另一份库上去。
let chosenDefault: string | null = null;

/**
 * 选中那一刻库文件是哪一个（不在就是 null）。改名、退回都是 rename，文件身份（设备号 + inode / 文件号）跟着文件走：
 * 拿锁时还是这个身份，才证明开的是选中时那份数据；原来在、后来不见了，跟「本来就是新安装」不是一回事。
 */
const identityAtChoice = new Map<string, string | null>();

function fileIdentity(file: string): string | null {
  const st = statSync(file, { bigint: true, throwIfNoEntry: false });
  return st ? `${st.dev}:${st.ino}` : null;
}

function remember(file: string): string {
  if (!identityAtChoice.has(file)) identityAtChoice.set(file, fileIdentity(file));
  return file;
}

function defaultDbFile(): string {
  if (chosenDefault) return chosenDefault;
  const { file, legacy } = chooseDbFileIn(DATA_DIR);
  if (legacy) {
    console.warn(`[navi] 库还叫 ${LEGACY_DB_FILE}（${file}）。照常能用；想改成 ${DB_FILE_NAME}，停掉服务后跑 \`${RENAME_COMMAND}\`（docs/rename-db.md）。`);
  }
  chosenDefault = remember(resolve(file));
  return chosenDefault;
}

/**
 * 显式指定的库（`NAVI_DB`，旧名也认）只替我们选了位置，不豁免改名的安全闸：跟着它走的身份、访问密钥就在它旁边，
 * 那个目录里改名做到一半时开它，会把已经挪走的身份当场重建成一台新机器。指着改名留下的路标时也说清楚，
 * 而不是让 SQLite 报一句「file is not a database」。
 */
function checkExplicitDbFile(file: string) {
  refuseWhileRenaming(dirname(file));
  if (legacyDbState(file) === "moved") {
    throw new DbFileChoiceError(`显式指定的库 ${file} 是改名迁移留下的路标，库已经改名成同目录里的 ${DB_FILE_NAME}。`
      + `把 NAVI_DB 改成 ${join(dirname(file), DB_FILE_NAME)}（或去掉它），再启动。`);
  }
}

export function resolveNaviDbFile() {
  const explicit = readStorageEnv(process.env, "NAVI_DB");
  if (explicit) {
    const file = resolve(explicit);
    if (!identityAtChoice.has(file)) { checkExplicitDbFile(file); remember(file); }
    return file;
  }
  return resolve(defaultDbFile());
}

/**
 * 在启动的占有锁里（singleton.ts，跟 `rename-db` 抢的是同一把）证明「选中的还是那份数据」：`resolveNaviDbFile` 选库发生在
 * 拿锁之前，两步之间改名或退回做完了的话，记住的那个名字已经不是那份数据 —— 照它开就是对着一份新建的空库起来。
 * 默认目录和显式路径（三代变量名都走这里）一样：选库那一刻的安全闸再过一遍，文件身份也得跟选中时一致（原来在、
 * 现在不在，原来不在、现在冒出来，或者换成了另一个文件，都不算）。认不准就不起，重启一次会按此刻的样子重选。
 */
export function recheckDbFileChoice(dbFile: string) {
  const file = resolve(dbFile);
  if (readStorageEnv(process.env, "NAVI_DB")) checkExplicitDbFile(file);
  else {
    const now = resolve(chooseDbFileIn(DATA_DIR).file);
    if (now !== file) throw new DbFileChoiceError(`启动途中库文件改了名：先选的是 ${file}，现在该开的是 ${now}。没有启动，重新启动一次即可。`);
  }
  if (!identityAtChoice.has(file)) throw new DbFileChoiceError(`${file} 没经过选库就要开，没有启动。`);
  const then = identityAtChoice.get(file) ?? null;
  const now = fileIdentity(file);
  if (then !== now) {
    const what = then === null ? "选库时不在、现在有了" : now === null ? "选库时在、现在不见了" : "换成了另一个文件";
    throw new DbFileChoiceError(`启动途中库文件 ${file} ${what}（多半是同时在改名或退回）。没有启动，重新启动一次即可。`);
  }
}

export function ensureNaviDbDir(dbFile = resolveNaviDbFile()) {
  mkdirSync(dirname(dbFile), { recursive: true });
}
