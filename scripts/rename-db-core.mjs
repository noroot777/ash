// 库改名（ash.db → navi.db）的计划与执行：清点、账本、做、做不完就照原样退回。CLI 在 scripts/rename-db.mjs，
// 操作单在 docs/rename-db.md。
//
// 一次改名 = 一串步骤，全部写进数据目录里的账本（DB_RENAME_JOURNAL）之后才动手：
//   · leftover：上一个服务留下的锁与在线登记（主人已确认不在）挪进 backups/ 下的留底目录，不跟着改名；
//   · move：库文件和跟着库名走的文件逐个改名，库文件本身最后挪；
//   · mark / unmark：在旧名的位置写下（退回时撤掉）路标 —— 改名之前的服务对着它起不来。
//
// 做到哪一步记在账本里（phase + progress），每做完 / 撤完一步先落盘再往下走。**不能光看盘面猜哪步做过**：
// 同一个路径前后被几步用到（退回时先撤掉旧名的路标、最后又把库挪到旧名上；改名时先把库挪走、再在原处写路标），
// 不按顺序拿后一步的结果去判前一步，会把真库当成路标删掉。所以严格按账本的顺序一步一步走，每一步动手之前正面认出
// 它在哪一头（做完 / 没动过 / 路标写到一半），两头都不像就停手、账本留着 —— 不拿「不是做完」当「撤完了」。
// 路标按原始字节认，撤、写之前都核对是这一次的那份；删账本之前再核对一遍整个盘面是该有的样子。
// 账本在，服务就不起（server/src/db/path.ts）。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_CARRIED_SUFFIXES, DB_FILE_NAME, DB_MOVED_MARKER, DB_RENAME_JOURNAL, isRuntimeResidue, legacyDbState } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";

const JOURNAL_VERSION = 2;
const realOps = { rename: renameSync, writeNew: writeDurably, unlink: unlinkSync };

/** 新建 path 写进 text 并刷盘：路标的内容要先于记它做完的那笔账落到盘上，不然断电后旧名位置可能是一份空文件。 */
function writeDurably(path, text) {
  const fd = openSync(path, "wx");
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

/** 这个名字上有没有东西：悬空的软链接也算有（existsSync 会把它当成不在）。 */
const occupied = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

export const journalFile = (dataDir) => join(dataDir, DB_RENAME_JOURNAL);

export function markerText(at) {
  return `${DB_MOVED_MARKER}\n`
    + `这份库已经改名成同一目录里的 ${DB_FILE_NAME}（${at}，scripts/rename-db.mjs）。这里留的是路标，不是库：\n`
    + `改名之前的 Navi 只认 ${LEGACY_DB_FILE}，对着它会报 \"file is not a database\" 起不来，而不是对着一份空库起来。\n`
    + `要换回改名之前的版本：停掉服务，在新版的检出里跑 node scripts/rename-db.mjs --rollback（见 docs/rename-db.md）。\n`;
}

/**
 * 数据目录此刻的样子：
 *  legacy      只有 ash.db（一份库）——可以改名
 *  renamed     有 navi.db，ash.db 不在或是路标 —— 已经是新名（可以退回）
 *  both        两份都是库 —— 不动，交给人认
 *  orphan      只剩路标、navi.db 不见了 —— 不动
 *  empty       两份都没有（新安装，或者不是数据目录）
 *  interrupted 账本在 —— 上次做到一半
 */
export function inspect(dataDir) {
  const navi = join(dataDir, DB_FILE_NAME);
  const legacy = join(dataDir, LEGACY_DB_FILE);
  const old = legacyDbState(legacy);
  const hasNavi = existsSync(navi);
  const state = existsSync(journalFile(dataDir)) ? "interrupted"
    : hasNavi ? (old === "present" ? "both" : "renamed")
    : old === "present" ? "legacy" : old === "moved" ? "orphan" : "empty";
  return { state, navi, legacy, marker: old === "moved" };
}

/**
 * 一份库名下所有的位置：库文件本身和每个跟着库名走的派生文件（DB_CARRIED_SUFFIXES 全集，不看此刻在不在）。
 * 改名的目标名下这些位置都得空着：源头没有 -wal、目标名旁边却剩着一份别的库的 -wal，SQLite 会把它当成刚改过去的
 * 这份库的日志重放进来；身份、访问密钥同理，会被当成这份库的。
 */
export const dbNamespace = (db) => [db, ...DB_CARRIED_SUFFIXES.map((suffix) => `${db}${suffix}`)];

/** 往 from 那个名字改成 to 那个名字要走的步骤。from 是旧名就是改名，反过来就是退回。 */
export function planSteps(dataDir, { direction, stamp, at = new Date().toISOString() }) {
  const [fromName, toName] = direction === "forward" ? [LEGACY_DB_FILE, DB_FILE_NAME] : [DB_FILE_NAME, LEGACY_DB_FILE];
  const from = join(dataDir, fromName);
  const to = join(dataDir, toName);
  const leftovers = join(dataDir, "backups", `db-rename-${stamp}`);
  const steps = [];
  if (direction === "backward" && legacyDbState(to) === "moved") steps.push({ op: "unmark", path: to, text: readFileSync(to, "utf8") });
  for (const name of readdirSync(dataDir).sort()) {
    if (isRuntimeResidue(name, fromName)) steps.push({ op: "move", from: join(dataDir, name), to: join(leftovers, name), leftover: true });
  }
  for (const suffix of DB_CARRIED_SUFFIXES) {
    if (occupied(`${from}${suffix}`)) steps.push({ op: "move", from: `${from}${suffix}`, to: `${to}${suffix}` });
  }
  steps.push({ op: "move", from, to });
  if (direction === "forward") steps.push({ op: "mark", path: from, text: markerText(at) });
  // 目标名下的位置（不只是这次要搬过去的那几个）已经有东西的，一步都不做：哪一份是真的只有人能认。
  // （退回时旧名位置上的路标不算：第一步就是撤掉它。）留底目录里的位置同样得空着。
  const cleared = new Set(steps.filter((s) => s.op === "unmark").map((s) => s.path));
  const targets = new Set([...dbNamespace(to), ...steps.filter((s) => s.leftover).map((s) => s.to)]);
  const taken = [...targets].filter((t) => occupied(t) && !cleared.has(t));
  return { direction, leftovers, steps, taken };
}

/**
 * path 上那份路标此刻的样子，按**原始字节**比（路标里有中文，写到一半可能停在一个字的中间，按 UTF-8 解出来就不是
 * 原文的前缀了）：absent 不在 / full 整份就是这一次的路标 / partial 是它写到一半的那段 / other 别的东西。
 */
function markerState(path, text) {
  const want = Buffer.from(text, "utf8");
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return "absent";
  if (!st.isFile() || st.size > want.length) return "other";
  const bytes = readFileSync(path);
  if (bytes.equals(want)) return "full";
  return want.subarray(0, bytes.length).equals(bytes) ? "partial" : "other";
}

/**
 * 一步此刻在盘上处于哪一头，**两头都要正面证明**，不拿「不是做完」当「撤完了」：
 *  done 做完的样子 / undone 动手之前的样子 / partial 写路标写到一半 / unknown 两头都不像 —— 遇到它就停手、账本留着。
 * 判一步时，它前面的步骤都处在做完的样子、后面的都处在动手之前的样子（做和撤都按顺序一步一步走、每步记账），
 * 所以同一个路径被前后几步用到也不会认错：用到它的另一步此刻是哪一头是确定的。
 */
function stepState(step) {
  if (step.op === "move") {
    const from = occupied(step.from), to = occupied(step.to);
    return !from && to ? "done" : from && !to ? "undone" : "unknown";
  }
  const m = markerState(step.path, step.text);
  if (m === "partial") return "partial";
  if (m === "other") return "unknown";
  if (step.op === "mark") return m === "full" ? "done" : "undone";
  return m === "absent" ? "done" : "undone"; // unmark：撤掉了是做完，路标整份在是没动过
}

const where = (step) => (step.op === "move" ? `${step.from} → ${step.to}` : step.path);
const unknownState = (step) => new Error(`${where(step)} 盘上的样子跟账本对不上（既不像做完、也不像没动过），停手了`);

function doStep(step, ops) {
  const state = stepState(step);
  if (state === "done") return;
  // 写路标写到一半：mark 接着写；unmark 不写东西，盘上却有半份路标 —— 认不准，停手
  if (state === "unknown" || (state === "partial" && step.op !== "mark")) throw unknownState(step);
  if (step.op === "move") ops.rename(step.from, step.to);
  else if (step.op === "mark") writeMarker(step, ops);
  else ops.unlink(step.path);
}

function undoStep(step, ops) {
  const state = stepState(step);
  if (state === "undone") return;
  if (state === "unknown") throw unknownState(step);
  if (step.op === "move") ops.rename(step.to, step.from);
  else if (step.op === "mark") ops.unlink(step.path); // 整份或写到一半的这一次的路标
  else writeMarker(step, ops); // 把撤掉的路标写回去（上次写到一半的重写）
}

/** 在 step.path 写路标。那里有东西的话，只认上次写到一半的这份路标（先删掉重写），别的一律停手。 */
function writeMarker(step, ops) {
  const m = markerState(step.path, step.text);
  if (m === "other" || m === "full") throw new Error(`${step.path} 已经有了，没在那里写路标`);
  if (m === "partial") ops.unlink(step.path);
  ops.writeNew(step.path, step.text);
}

/**
 * 删账本之前核对整个盘面：每个路径都得是「最后动它的那一步」留下的样子（做完时按顺序数，撤完时倒着数、取反）；
 * 新旧两个库名下没被任何一步动到的位置，动手之前是空的（planSteps 拦过），完了也得是空的。
 * 对不上就不删账本 —— 宁可让服务因账本起不来、让人来认，也不报一句「回到原样」。
 */
function verifyFinal(journal, phase) {
  const want = new Map();
  const steps = phase === "do" ? journal.steps : [...journal.steps].reverse();
  for (const s of steps) {
    if (s.op === "move") {
      want.set(phase === "do" ? s.from : s.to, ["absent"]);
      want.set(phase === "do" ? s.to : s.from, ["present"]);
    } else {
      const marked = (s.op === "mark") === (phase === "do");
      want.set(s.path, [marked ? "marker" : "absent", s.text]);
    }
  }
  const main = journal.steps.findLast((s) => s.op === "move" && !s.leftover); // 库文件本身那一步，排在派生文件之后
  for (const path of [...dbNamespace(main.from), ...dbNamespace(main.to)]) if (!want.has(path)) want.set(path, ["absent"]);
  for (const [path, [kind, text]] of want) {
    const ok = kind === "absent" ? !occupied(path) : kind === "present" ? occupied(path) : markerState(path, text) === "full";
    if (!ok) throw new Error(`${phase === "do" ? "做完" : "撤完"}之后 ${path} 不是该有的样子（应当${kind === "absent" ? "不在" : kind === "present" ? "在" : "是路标"}），账本留着`);
  }
}

/**
 * 把 dir 的目录项落盘：改名的先后要比账本的进度先到盘上。Windows 打不开目录、有的文件系统不支持给目录 fsync —— 这两种
 * 跳过；别的错误（EIO 之类）是真的没落盘，照实抛出去，不当成落好了往下记进度。
 */
function syncDir(dir) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function saveJournal(dataDir, journal) {
  const file = journalFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(journal, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  syncDir(dataDir);
}

export function readJournal(dataDir) {
  const journal = JSON.parse(readFileSync(journalFile(dataDir), "utf8"));
  const ok = journal?.version === JOURNAL_VERSION && Array.isArray(journal.steps) && ["do", "undo"].includes(journal.phase)
    && Number.isInteger(journal.progress) && journal.progress >= 0 && journal.progress <= journal.steps.length;
  if (!ok) throw new Error(`${journalFile(dataDir)} 认不出来（不是这一版写的账本）`);
  return journal;
}

/** 把 dir 及缺的上级都建出来，返回新建的那几层（从深到浅）。 */
function ensureDirs(dir) {
  const created = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) created.push(d);
  for (const d of [...created].reverse()) mkdirSync(d);
  return created;
}

/** 删掉账本；这一次新建的目录（从深到浅）还空着就一起收掉。 */
function dropJournal(dataDir, journal) {
  unlinkSync(journalFile(dataDir));
  syncDir(dataDir);
  for (const d of journal.created ?? []) {
    try { rmdirSync(d); } catch { break; /* 不空（留了底）或本来就没建 */ }
  }
}

function synced(dataDir, journal, step) {
  syncDir(dataDir);
  if (step.op === "move" && dirname(step.to) !== dataDir) syncDir(dirname(step.to));
  saveJournal(dataDir, journal);
}

/**
 * 照账本往前做完（上次做到一半的从记到的那一步接着做）。中途失败就照账本倒着撤回去、删掉账本，再把原因抛出去 ——
 * 数据目录回到动手之前的样子；撤也失败的话账本留着（服务因此不起），抛出的错误里说清怎么接着处理。
 */
export function runJournal(dataDir, journal, { ops = realOps, log = () => {} } = {}) {
  if (journal.phase !== "do") throw new Error("上次是在撤回途中停下的，只能接着撤（--rollback）");
  try {
    if (journal.steps.some((s) => s.leftover)) {
      journal.created = [...ensureDirs(journal.leftovers), ...(journal.created ?? [])];
      saveJournal(dataDir, journal);
    }
    for (let i = journal.progress; i < journal.steps.length; i += 1) {
      const step = journal.steps[i];
      doStep(step, ops); // 做完、没来得及记就被杀的那一步，盘上已是做完的样子，这里认出来就跳过
      journal.progress = i + 1;
      synced(dataDir, journal, step);
      log(step);
    }
  } catch (error) {
    try { undoJournal(dataDir, journal, { ops }); }
    catch (undoError) {
      throw new Error(`${error.message}；照账本退回也失败了：${undoError.message}。账本留在 ${journalFile(dataDir)}，修好原因后重跑 --rollback 接着退`);
    }
    throw new Error(`${error.message}（已照账本退回原样）`);
  }
  verifyFinal(journal, "do");
  dropJournal(dataDir, journal);
}

/** 照账本倒着撤回：做过的每一步反着做一遍（每撤一步记一笔），核对盘面回到了动手之前，然后删掉账本。 */
export function undoJournal(dataDir, journal, { ops = realOps } = {}) {
  if (journal.phase === "do") {
    // 记到的那一步可能已经做了（或路标写到一半）：此刻判一次，做过的一起撤；认不出就停手
    const k = journal.progress;
    if (k < journal.steps.length) {
      const state = stepState(journal.steps[k]);
      if (state === "unknown") throw unknownState(journal.steps[k]);
      if (state !== "undone") journal.progress = k + 1;
    }
    journal.phase = "undo";
    saveJournal(dataDir, journal);
  }
  for (let j = journal.progress - 1; j >= 0; j -= 1) {
    const step = journal.steps[j];
    undoStep(step, ops); // 撤完、没来得及记就被杀的那一步，盘上已是动手之前的样子，认出来就跳过
    journal.progress = j;
    synced(dataDir, journal, step);
  }
  verifyFinal(journal, "undo");
  dropJournal(dataDir, journal);
}

/** 先记账本、再动手。 */
export function start(dataDir, plan, opts) {
  const journal = { version: JOURNAL_VERSION, direction: plan.direction, createdAt: new Date().toISOString(), leftovers: plan.leftovers, steps: plan.steps, phase: "do", progress: 0 };
  saveJournal(dataDir, journal);
  runJournal(dataDir, journal, opts);
}
