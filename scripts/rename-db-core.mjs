// 库改名（ash.db → navi.db）的计划与执行：清点、账本、做、做不完就照原样退回。CLI 在 scripts/rename-db.mjs，
// 操作单在 docs/rename-db.md。
//
// 一次改名 = 一串步骤，全部写进数据目录里的账本（DB_RENAME_JOURNAL）之后才动手：
//   · leftover：上一个服务留下的锁与在线登记（主人已确认不在）挪进 backups/ 下的留底目录，不跟着改名；
//   · move：库文件和跟着库名走的文件逐个改名，库文件本身最后挪；
//   · mark / unmark：在旧名的位置写下（退回时撤掉）路标 —— 改名之前的服务对着它起不来。
// 每一步做没做过都按盘上此刻的样子判断，不靠记忆：所以中途失败时照账本倒着撤得干净，进程被杀之后重跑
// 能接着做（或接着撤）。账本在，服务就不起（server/src/db/path.ts chooseDbFileIn）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_CARRIED_SUFFIXES, DB_FILE_NAME, DB_MOVED_MARKER, DB_RENAME_JOURNAL, isRuntimeResidue, legacyDbState } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";

const JOURNAL_VERSION = 1;
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

/** 这一步按盘上此刻的样子算不算已经做过。 */
function done(step) {
  if (step.op === "move") return !existsSync(step.from) && existsSync(step.to);
  if (step.op === "mark") return legacyDbState(step.path) === "moved";
  return !existsSync(step.path); // unmark
}

function doStep(step, ops) {
  if (done(step)) return;
  if (step.op === "move") {
    if (existsSync(step.to)) throw new Error(`${step.to} 已经有了，没把 ${step.from} 挪过去`);
    ops.rename(step.from, step.to);
  } else if (step.op === "mark") ops.writeNew(step.path, step.text);
  else ops.unlink(step.path);
}

function undoStep(step, ops) {
  if (!done(step)) return;
  if (step.op === "move") ops.rename(step.to, step.from);
  else if (step.op === "mark") ops.unlink(step.path);
  else ops.writeNew(step.path, step.text);
}

function saveJournal(dataDir, journal) {
  const file = journalFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function readJournal(dataDir) {
  const journal = JSON.parse(readFileSync(journalFile(dataDir), "utf8"));
  if (journal?.version !== JOURNAL_VERSION || !Array.isArray(journal.steps)) throw new Error(`${journalFile(dataDir)} 认不出来（不是这一版写的账本）`);
  return journal;
}

/** 删掉账本；留底目录是空的就连它、以及这一次为它新建的上级（created）一起收掉。 */
function dropJournal(dataDir, journal, created = journal.leftovers) {
  unlinkSync(journalFile(dataDir));
  for (let d = journal.leftovers; created && d.startsWith(created); d = dirname(d)) {
    try { rmdirSync(d); } catch { break; /* 不空（留了底）或本来就没建 */ }
  }
}

/**
 * 照账本往前做完。中途失败就照账本倒着撤回去、删掉账本，再把原因抛出去 —— 数据目录回到动手之前的样子；
 * 撤也失败的话账本留着（服务因此不起），抛出的错误里说清怎么接着处理。
 */
export function runJournal(dataDir, journal, { ops = realOps, log = () => {} } = {}) {
  let created;
  try {
    if (journal.steps.some((s) => s.leftover)) created = mkdirSync(journal.leftovers, { recursive: true });
    for (const step of journal.steps) {
      doStep(step, ops);
      log(step);
    }
  } catch (error) {
    try { undoJournal(dataDir, journal, { ops, created }); }
    catch (undoError) {
      throw new Error(`${error.message}；照账本退回也失败了：${undoError.message}。账本留在 ${journalFile(dataDir)}，修好原因后重跑 --rollback 接着退`);
    }
    throw new Error(`${error.message}（已照账本退回原样）`);
  }
  dropJournal(dataDir, journal);
}

/** 照账本倒着撤回：做过的每一步反着做一遍，然后删掉账本。 */
export function undoJournal(dataDir, journal, { ops = realOps, created } = {}) {
  for (const step of [...journal.steps].reverse()) undoStep(step, ops);
  dropJournal(dataDir, journal, created);
}

/** 先记账本、再动手。 */
export function start(dataDir, plan, opts) {
  const journal = { version: JOURNAL_VERSION, direction: plan.direction, createdAt: new Date().toISOString(), leftovers: plan.leftovers, steps: plan.steps };
  saveJournal(dataDir, journal);
  runJournal(dataDir, journal, opts);
}
