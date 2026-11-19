// 升级里碰数据的那几步:停着服务时给库留底、核对升级前后每一条都还在、把库改名交给 ⑨ 的改名命令、记下升级做到哪。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
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

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0");
const JOURNAL_SUFFIXES = ["-wal", "-shm", "-journal"];

/** 文件头是不是 SQLite 库(旧名位置上也可能是改名留下的路标文本)。 */
function isSqlite(file) {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = openSync(file, "r");
  try { return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_MAGIC); } finally { closeSync(fd); }
}

/** 文件内容的指纹:核对「升级前」的数字之前,先认准读的还是留底那一刻那份。 */
export function fileDigest(file) {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(file, "r");
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

/**
 * 一份库的一致快照,交给 SQLite 自己做(在线备份,逐页拷):-wal 里已经提交、还没合回主库的那些都在里面。不能自己按文件名拷
 * 库和 -wal —— 库是软链时 SQLite 把 -wal 放在**它指着的那份**旁边、叫那份的名字(审查第 2、3 轮实测:按链接名找,备份里就少了
 * 最近写的那些)。源库只读打开(不在留底这一步替它合并日志);做完把快照换成不带 -wal 的写法,它自己就是完整的一份,只读也打得开。
 */
async function snapshotDb(src, dest) {
  const { DatabaseSync, backup } = createRequire(import.meta.url)("node:sqlite");
  const source = new DatabaseSync(src, { readOnly: true });
  try { await backup(source, dest); } finally { source.close(); }
  const out = new DatabaseSync(dest);
  try { out.exec("PRAGMA journal_mode = DELETE"); } finally { out.close(); }
}

/**
 * 服务停着的时候给库留底,放进 `<数据目录>/backups/upgrade-<时间>/`:
 *   · 库本身(新旧名下是 SQLite 的那份)做一致快照(snapshotDb),它的 -wal / -shm / -journal 不另拷 —— 快照里都有了;
 *   · 其余跟着库名走的文件(身份、访问密钥、账本、旧名位置的路标)和改名账本原样拷(软链照它指向的内容拷),逐个核对大小。
 * 返回 { dir, files, baseline:{ file, digest } | null }(baseline = 核对「升级前」认的那份库和它的指纹);一个都没有返回 null;
 * 认不准、拷不全就抛出去(调用方把原来的服务起回来,这次不升)。
 */
export async function backupDb({ backupRoot, db, explicit, stamp }) {
  const { files, problems } = backupSources({ backupRoot, db, explicit });
  if (problems.length) throw new Error(problems.join(";"));
  if (!files.length) return null;
  let dir = join(backupRoot, "backups", `upgrade-${stamp}`);
  for (let n = 2; existsSync(dir); n += 1) dir = join(backupRoot, "backups", `upgrade-${stamp}-${n}`);
  mkdirSync(dir, { recursive: true });
  const dbs = new Set(files.filter((f) => !JOURNAL_SUFFIXES.some((x) => f.endsWith(x)) && isSqlite(f)));
  const out = [];
  for (const f of files) {
    if (JOURNAL_SUFFIXES.some((x) => f.endsWith(x) && dbs.has(f.slice(0, -x.length)))) continue;
    const to = join(dir, basename(f));
    if (dbs.has(f)) {
      await snapshotDb(f, to);
    } else {
      copyFileSync(f, to, constants.COPYFILE_EXCL);
      if (statSync(to).size !== statSync(f).size) throw new Error(`${f} 拷进备份之后大小对不上`);
    }
    out.push(basename(f));
  }
  const file = dbInBackup(dir, db, explicit);
  return { dir, files: out, baseline: file && existsSync(file) ? { file, digest: fileDigest(file) } : null };
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
 * 三张表的 id,只读打开(备份那份是不带 -wal 的快照;服务起着时的真库同样只读)—— 文件不在就打不开、抛出去,不会替它建一份空库。
 * 表还不存在(全新的库)算空;读不了就抛出去,由调用方如实说「没核对成」。
 */
export function readIds(file) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
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
 * 升级前后核对:备份里那份(停服务那一刻的一致快照)跟现在的库比,每一条都还在没有。baseline = { file, digest }(留底时记下的)。
 * 返回 { state: "ok" | "missing" | "unverified", line, rows }。「升级前」那份先认人:在、是个非空文件、指纹还是留底那一刻的 ——
 * 不见了、被换过、没记指纹都是 unverified,不拿一份空库或别的库当基线(「零条都在」证明不了任何事)。读不出来同样是 unverified ——
 * 「没发现少」不等于「核对过了」,调用方不能拿它宣布升好了。
 */
export function verifyData(baseline, liveFile) {
  const unverified = (why) => ({ state: "unverified", line: `没核对成:${why}`, rows: [] });
  const file = baseline?.file;
  const st = file ? statSync(file, { throwIfNoEntry: false }) : null;
  if (!st?.isFile() || st.size === 0) return unverified(`升级前那份库 ${file ?? "(没记下来)"} 不在了或是空的,拿什么比都证明不了数据都在`);
  if (!baseline.digest) return unverified(`${file} 留底时没记指纹,认不出它还是不是升级前那一份`);
  let rows;
  try {
    if (fileDigest(file) !== baseline.digest) return unverified(`${file} 跟留底那一刻不一样了(被改过或换过),不能拿它当升级前的数字`);
    rows = compareIds(readIds(file), readIds(liveFile));
  } catch (error) {
    return unverified(error.message);
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
 *   verifyPending [{ backupFile, backupDigest, db }] 数据核对还没过的那几份基线(读不出来、或者有缺;老格式是单个对象):往后每一次
 *              升级这份库(db,见 dbIdentity)的成功出口都得先把它们亲自补核过(pendingBaselines),后来留的底顶替不了
 *   servedDb   servedPid 那个服务开的是哪份库(dbIdentity)
 *   servedPid  最后一次起好的服务            port       这份安装的服务端口(锁收了之后再跑也找得到)
 *   inProgress { from, to, db, backup, backupFile, backupDigest } 有它 = 上次没做完,再跑接着做(from 和备份沿用那一次的;
 *              db = 那一次升的是哪份库,换了一份库不许接着用它的备份;backupFile / backupDigest = 备份里那份库和它留底时的指纹)
 *   last       上一次升好的那次:{ from, to, at, db, backup }
 *
 * 文件按数据目录放,而一个数据目录底下可以经 NAVI_DB 选不同的库 —— 所以凡是跟某一份库绑着的(进度、备份、欠着的核对、起着的服务)
 * 都记上 db(dbIdentity)和人看的 dbPath,读的时候只认这份库自己的(审查实测:A 库升到一半失败,换 B 库再跑接着用了 A 的备份,
 * B 少了任务还报都在);没记 db 的旧记录和别的库那次没做完的,怎么认领见 upgrade-ownership.mjs。
 * built / port 是检出和端口的事,不分库。读改写整段在数据锁里(upgrade-lock 的 dataLockDirs 锁着这份文件所在的目录)。
 */
export const stateFile = (dataDir) => join(dataDir, "upgrade.json");

/**
 * 没有这份文件 = 头一回升级,返回 {};有却读不懂就抛出去 —— 里面可能记着还没核对过的数据(verifyPending),当成 {} 就把
 * 那笔账悄悄抹了。
 */
export function readState(dataDir) {
  const file = stateFile(dataDir);
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`升级进度 ${file} 读不了(${error.code ?? error.message})`);
  }
  let state;
  try { state = JSON.parse(text); } catch (error) { state = error; }
  if (!state || typeof state !== "object" || Array.isArray(state) || state instanceof Error) {
    throw new Error(`升级进度 ${file} 读不懂(不是一份 JSON 对象);里面可能记着上次没核对过的数据 —— 先看一眼,确定没用再挪走它`);
  }
  return state;
}

/**
 * 还欠着的数据核对(verifyPending 老格式是单个对象),按库分开:mine = 这份库(db)自己的 [{ file, digest }],拿现在的库补核;
 * others = 别的库的(没记是哪份库的也算别人的 —— 拿谁比都证明不了),原样留着。
 */
export function pendingBaselines(state, db) {
  const p = state.verifyPending;
  const all = Array.isArray(p) ? p : p ? [p] : [];
  return {
    mine: all.filter((x) => x?.db && x.db === db).map((x) => ({ file: x.backupFile ?? null, digest: x.backupDigest ?? null })),
    others: all.filter((x) => !x?.db || x.db !== db),
  };
}

/** 真实落点;路径还不存在就取最近一级存在的祖先的真实落点再接上剩下那段。 */
function canonical(p) {
  try { return realpathSync(p); } catch {
    const up = dirname(p);
    return up === p ? p : join(canonical(up), basename(p));
  }
}

/**
 * 一份库是谁(升级进度里 db 记的就是它):**文件本身** —— 设备号 + 文件编号(stat 跟着软链走)。按路径认靠不住(审查实测):
 * 同一份库经软链、经 NAVI_DB、经默认选法是几个不同的路径,链接改指另一份库路径却不变。文件编号这几种都认得对,库改名
 * (rename-db 用的是 rename,ash.db → navi.db)也不变。库还不在(新装)就退到路径的真实落点,前缀不同,不会跟哪份库撞上。
 */
export function dbIdentity(file) {
  const abs = resolve(file);
  try {
    const st = statSync(abs, { bigint: true });
    if (st.isFile() && st.ino > 0n) return `file:${st.dev}:${st.ino}`;
  } catch { /* 不在:按路径 */ }
  return `path:${canonical(abs)}`;
}

export function writeState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  const file = stateFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}
