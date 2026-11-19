// 升级进度(upgrade.json)里跟某份库绑着的那几样 —— 没做完的那次(inProgress)、欠着的核对(verifyPending)—— 归不归这一次
// 选的这份库。进度按数据目录放,一个数据目录底下又能经 NAVI_DB 选不同的库,所以每条都记着 db(upgrade-data 的 dbIdentity)。
//
// 不变量:**进度里的每一条,要么认得出是这份库的(拿这份库补核 / 接着做),要么在停服务之前拦下、等人明确选一条路**。
// 没有第三种「当成别的库、提一句就跳过」—— 身份字符串对不上有太多正当的原因(上一版记的是裸路径、库是这一次才建出来的、
// 库文件被换过 / 恢复过),拿「对不上」当「不归我」,欠着的核对就失联了,少了东西也报升好(审查实测,两轮)。
//
// 认得出 = 同一个文件(file:设备号:文件编号),或者记的是「这个路径上的库」(path:,当时库还不在)而这个路径上现在就是这份库。
// 认不出的两条路,都写进拦下的提示里:
//   --take-over      那就是这份库(换过文件、恢复过、挪过):欠着的拿这份库补核;没做完的那次,它的备份也记成这份库欠的
//                    一次核对、拿这份库补核,这一次照常再给这份库留一份底 —— 认错了也不会拿别人的备份冒充这份库的留底;
//   --forget-others  那是别的库,而那份库已经不在了(或不打算再升它):这些记录挪进 forgotten(备份文件原样留着),不再核对;
//                    这一次从头给这份库留底。
// 还有一条不用参数的:选回那份库(照那次的 NAVI_DB / NAVI_DATA_DIR)再跑一次,在那边补核 / 做完。
import { pathIdentity } from "./upgrade-data.mjs";

const asList = (p) => (Array.isArray(p) ? p : p ? [p] : []);
const KNOWN = /^(file|path):/;

/**
 * 看 state 里的记录归不归这份库(db = dbIdentity,dbPath = 选中的库路径)。返回 { problems, state, changed }:
 * problems 非空 = 得先处理(停服务之前);state = 认领 / 挪走 / 身份更新之后的那一份(调用方拿锁之后再写回)。
 */
export function progressOwnership(saved, { db, dbPath, takeOver = false, forgetOthers = false }) {
  if (takeOver && forgetOthers) return { problems: ["--take-over 和 --forget-others 只能选一个"], state: saved, changed: false };
  const here = pathIdentity(dbPath);
  /** mine / unknown(没记或旧格式:认不出是哪份库的)/ other(明确记着是另一个文件)。 */
  const kind = (id) => (id === db || id === here ? "mine" : !id || !KNOWN.test(id) ? "unknown" : "other");
  const state = structuredClone(saved);
  const problems = [];
  const forgotten = [];
  let changed = false;
  const mine = (r) => { if (r.db !== db || r.dbPath !== dbPath) { Object.assign(r, { db, dbPath }); changed = true; } return r; };

  const run = state.inProgress;
  if (run) {
    const k = kind(run.db);
    if (k === "mine" || !run.backup) mine(run); // 还没给哪份库留过底:里面没有跟库绑着的东西
    else if (takeOver) {
      state.verifyPending = [...asList(state.verifyPending), { backupFile: run.backupFile ?? null, backupDigest: run.backupDigest ?? null, db, dbPath }];
      delete state.inProgress;
      changed = true;
    }
    else if (forgetOthers) { forgotten.push({ ...run, what: "没做完的那次升级" }); delete state.inProgress; changed = true; }
    else {
      const which = k === "unknown" ? `一份没记清是哪份的库(${run.dbPath ?? run.db ?? "旧格式的进度"})`
        : run.dbPath === dbPath ? `${dbPath} 当时指着的那份库,而这个路径现在指着的已经是另一个文件了(换过链接或文件)`
          : `另一份库 ${run.dbPath ?? run.db}`;
      problems.push(`上次没做完的那次升级升的是${which};它的备份在 ${run.backup},这一次选的是 ${dbPath}。`
        + "选回那份库(照那次的 NAVI_DB / NAVI_DATA_DIR)再跑一次把它做完;确认就是这份库(换过文件、恢复过)加 --take-over,那份备份记成这份库欠的一次核对、拿它补核,这一次照常再留一份底;"
        + "那份库已经不在了(或不打算再升它)加 --forget-others,那次的记录挪到一边(备份原样留着),这一次从头给这份库留底");
    }
  }

  const keep = [];
  const stray = [];
  for (const r of asList(state.verifyPending)) {
    const k = kind(r?.db);
    if (k === "mine" || takeOver) keep.push(mine({ ...r }));
    else if (forgetOthers) { forgotten.push({ ...r, what: "欠着的数据核对" }); changed = true; }
    else { keep.push(r); stray.push(r); }
  }
  if (stray.length) {
    problems.push(`升级进度里有 ${stray.length} 条欠着的数据核对认不出是这份库(${dbPath})的:`
      + stray.map((r) => `${r?.dbPath ?? r?.db ?? "没记是哪份库"}(升级前的库在 ${r?.backupFile})`).join("、")
      + "。没核对过就不能算升好:选回那份库再跑一次在那边补核;确认就是这份库加 --take-over,拿它补核;那份库已经不在了加 --forget-others,不再核对它");
  }
  if (keep.length) state.verifyPending = keep;
  else delete state.verifyPending;
  if (forgotten.length) {
    const at = new Date().toISOString();
    state.forgotten = [...asList(state.forgotten), ...forgotten.map((r) => ({ ...r, forgottenAt: at }))];
  }
  return { problems, state: changed ? state : saved, changed };
}
