// 升级进度(upgrade.json)里跟某份库绑着的那几样 —— 没做完的那次(inProgress)、欠着的核对(verifyPending)—— 归不归这一次
// 选的这份库。进度按数据目录放,一个数据目录底下又能经 NAVI_DB 选不同的库,所以每条都记着 db(upgrade-data 的 dbIdentity)。
//
// 对不上的三种,都在停服务之前说清楚,不猜:
//   · 那次没做完的是**别的库**的,而且已经给那份库留了底:它的备份不是这份库的,不能接着用 —— 选回那份库把它做完;那份库
//     不在了(或者不打算再升它)就 --take-over:那次的进度改记成「那份库欠着的一次核对」(备份和指纹原样留着,下次升那份库
//     时补核),这一次从头给这份库留底;
//   · 没记 db 的旧格式记录:认不出是哪份库的。确认就是这份库的,--take-over 认领(没做完的接着用它的备份,欠着的拿这份库
//     补核);不是就先选回那份库再 --take-over;
//   · 欠着的核对明确是别的库的:原样留着、提一句(upgrade.mjs),不拿这份库比 —— 恰好都在也证明不了那份库没少东西。
// 那次没做完的还没给哪份库留过底(backup 为空)时,里面没有跟库绑着的东西,直接归这份库。

const asList = (p) => (Array.isArray(p) ? p : p ? [p] : []);
const where = (r) => r?.dbPath ?? r?.db;

/**
 * 看 state 里的记录归不归 db 这份库(dbPath 是给人看的路径)。返回 { problems, state, changed }:
 * problems 非空 = 得先处理;state = 认领 / 搁置之后的那一份(takeOver 时才会动,调用方拿锁之后再写回)。
 */
export function progressOwnership(saved, { db, dbPath, takeOver }) {
  const state = structuredClone(saved);
  const problems = [];
  let changed = false;
  const run = state.inProgress;
  if (run && run.db !== db) {
    if (!run.backup) {
      Object.assign(run, { db, dbPath });
      changed = true;
    } else if (!run.db) {
      if (takeOver) { Object.assign(run, { db, dbPath }); changed = true; }
      else {
        problems.push(`上次没做完的那次升级是旧格式的进度,没记是哪份库的(它的备份在 ${run.backup})。确认就是这一次选的 ${dbPath}:`
          + `加 --take-over 再跑,接着用那份备份做完;不是:先照那次的 NAVI_DB / NAVI_DATA_DIR 选回那份库,再加 --take-over 跑`);
      }
    } else if (takeOver) {
      // 那份库的备份和指纹记成它欠着的一次核对,下次升它时补核;这一次从头来。
      state.verifyPending = [...asList(state.verifyPending), { backupFile: run.backupFile ?? null, backupDigest: run.backupDigest ?? null, db: run.db, dbPath: run.dbPath }];
      delete state.inProgress;
      changed = true;
    } else {
      // 路径一样、库换了(链接改指、文件被换过)时,两个路径打出来一模一样,得把这件事说出来。
      const which = run.dbPath === dbPath ? `${dbPath} 当时指着的那份库,而这个路径现在指着的已经是另一份了(换过链接或文件)` : `另一份库 ${where(run)},这一次选的是 ${dbPath}`;
      problems.push(`上次没做完的那次升级升的是${which};它的备份(${run.backup})不是这份库的,不能接着用。`
        + `先照那次的 NAVI_DB / NAVI_DATA_DIR 再跑一次 npm run upgrade 把它做完;那份库已经不在了(或不打算再升它)就加 --take-over:`
        + `那次的进度改记成那份库欠着的一次核对(备份原样留着),这一次从头给这份库留底`);
    }
  }
  const owed = asList(state.verifyPending);
  const unknown = owed.filter((x) => !x?.db);
  if (unknown.length) {
    if (takeOver) {
      state.verifyPending = owed.map((x) => (x?.db ? x : { ...x, db, dbPath }));
      changed = true;
    } else {
      problems.push(`升级进度里有 ${unknown.length} 条旧格式的待核对记录,没记是哪份库的(升级前的库在 ${unknown.map((x) => x?.backupFile).join("、")})。`
        + `确认是这一次选的 ${dbPath}:加 --take-over 再跑,拿它补核;不是:先选回那份库再加 --take-over 跑`);
    }
  }
  return { problems, state: changed ? state : saved, changed };
}
