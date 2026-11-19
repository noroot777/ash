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
// 拿后一步的结果去判前一步，会把真库当成路标删掉。所以盘面只用来判**账本记到的那一步**（它做了、进度还没来得及
// 落盘的那一刻被杀）：那一刻前面的步骤都做完了、后面的都没动，单看这一步的源和目标就判得准。
// 撤路标、撤自己写的路标之前都核对内容是这一次的那份路标，对不上就停手 —— 不凭「有个文件在」就删。
// 账本在，服务就不起（server/src/db/path.ts）。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_CARRIED_SUFFIXES, DB_FILE_NAME, DB_MOVED_MARKER, DB_RENAME_JOURNAL, isRuntimeResidue, legacyDbState } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";

const JOURNAL_VERSION = 2;
const realOps = { rename: renameSync, writeNew: (path, text) => writeFileSync(path, text, { flag: "wx" }), unlink: unlinkSync };

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
    if (existsSync(`${from}${suffix}`)) steps.push({ op: "move", from: `${from}${suffix}`, to: `${to}${suffix}` });
  }
  steps.push({ op: "move", from, to });
  if (direction === "forward") steps.push({ op: "mark", path: from, text: markerText(at) });
  // 目标位置已经有东西的，一步都不做：哪一份是真的只有人能认。
  // （退回时旧名位置上的路标不算：第一步就是撤掉它。）
  const cleared = new Set(steps.filter((s) => s.op === "unmark").map((s) => s.path));
  const taken = steps.filter((s) => s.op === "move" && existsSync(s.to) && !cleared.has(s.to)).map((s) => s.to);
  return { direction, leftovers, steps, taken };
}

/** path 上是不是这一次的那份路标（整份内容逐字一致）；pending=true 时连写到一半的那种也算。 */
function isMarker(path, text, { pending = false } = {}) {
  let size;
  try { size = statSync(path).size; } catch { return false; }
  if (size > Buffer.byteLength(text)) return false;
  const now = readFileSync(path, "utf8");
  return pending ? text.startsWith(now) : now === text;
}

/**
 * 这一步按盘上此刻的样子算不算已经做过。**只对账本记到的那一步用**：前面的都做完了、后面的都还没动（或撤到这一步时，
 * 后面的都撤完了、前面的都还在），这一步的源和目标此刻只可能被它自己动过。
 */
function done(step) {
  if (step.op === "move") return !existsSync(step.from) && existsSync(step.to);
  if (step.op === "mark") return isMarker(step.path, step.text);
  return !existsSync(step.path); // unmark：路标撤掉了
}

/**
 * 撤回时同样只对记到的那一步用：这一步此刻还算不算「做过、要撤」。写到一半的路标也算自己写的（要撤）；
 * 退回时撤掉的路标没有逐字写回去之前都算还撤着。
 */
function stillDone(step) {
  if (step.op === "mark") return isMarker(step.path, step.text, { pending: true });
  if (step.op === "unmark") return !isMarker(step.path, step.text);
  return done(step);
}

function doStep(step, ops) {
  if (step.op === "move") {
    if (existsSync(step.to)) throw new Error(`${step.to} 已经有了，没把 ${step.from} 挪过去`);
    ops.rename(step.from, step.to);
  } else if (step.op === "mark") writeMarker(step, ops);
  else {
    if (!isMarker(step.path, step.text)) throw new Error(`${step.path} 不是这一次要撤的那份路标，没删它`);
    ops.unlink(step.path);
  }
}

function undoStep(step, ops) {
  if (step.op === "move") {
    if (existsSync(step.from)) throw new Error(`${step.from} 已经有了，没把 ${step.to} 挪回去`);
    ops.rename(step.to, step.from);
  } else if (step.op === "mark") {
    if (!isMarker(step.path, step.text, { pending: true })) throw new Error(`${step.path} 不是这一次写的路标，没删它`);
    ops.unlink(step.path);
  } else writeMarker(step, ops);
}

/** 在 step.path 写路标。那里有东西的话，只认上次写到一半的这份路标（先删掉重写），别的一律停手。 */
function writeMarker(step, ops) {
  if (existsSync(step.path)) {
    if (!isMarker(step.path, step.text, { pending: true })) throw new Error(`${step.path} 已经有了，没在那里写路标`);
    ops.unlink(step.path);
  }
  ops.writeNew(step.path, step.text);
}

/** 把 dir 的目录项落盘（POSIX；Windows 打不开目录，跳过）：改名的先后要比账本的进度先到盘上。 */
function syncDir(dir) {
  let fd;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* Windows / 不支持 */ } finally { if (fd !== undefined) closeSync(fd); }
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
      // 只有接着上次做时，记到的这一步才可能已经做了（做完、没来得及记就被杀）
      if (!(i === journal.progress && done(step))) doStep(step, ops);
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
  dropJournal(dataDir, journal);
}

/** 照账本倒着撤回：做过的每一步反着做一遍（每撤一步记一笔），然后删掉账本。 */
export function undoJournal(dataDir, journal, { ops = realOps } = {}) {
  if (journal.phase === "do") {
    // 记到的那一步可能已经做了：此刻判一次，记成「做过」就一起撤
    const k = journal.progress;
    journal.progress = k < journal.steps.length && stillDone(journal.steps[k]) ? k + 1 : k;
    journal.phase = "undo";
    saveJournal(dataDir, journal);
  }
  for (let j = journal.progress - 1; j >= 0; j -= 1) {
    const step = journal.steps[j];
    // 接着上次撤时，记到的这一步可能已经撤了（撤完、没来得及记就被杀）
    if (!(j === journal.progress - 1 && !stillDone(step))) undoStep(step, ops);
    journal.progress = j;
    synced(dataDir, journal, step);
  }
  dropJournal(dataDir, journal);
}

/** 先记账本、再动手。 */
export function start(dataDir, plan, opts) {
  const journal = { version: JOURNAL_VERSION, direction: plan.direction, createdAt: new Date().toISOString(), leftovers: plan.leftovers, steps: plan.steps, phase: "do", progress: 0 };
  saveJournal(dataDir, journal);
  runJournal(dataDir, journal, opts);
}
