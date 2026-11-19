// 升级 / restart / setup 之间的互斥:同一份检出、同一份数据,同一时刻只许其中一个在装依赖、构建、停起服务、动库。
//
// 为什么要锁:升级从拉代码到起服务要好几分钟,两次一起跑就两边同时 npm install 进同一个 node_modules,后到的那次还会把
// 先到那次正在写的进度当成「上次没做完」接着做,最后抢同一个端口;restart / setup 插进来是同一回事(审查实测过)。
//
// 为什么不是「一个锁文件 + 持有者死了就回收」(上两版,两轮审查都复现了双持有):回收要证明「主人已经不在」,而「读到那份
// 锁 → 判它死了 → 删掉它」这三步之间别人可以刚建好一份新的 —— 删的就是活人的锁;先建空文件再写内容,中间那一瞬读到的
// 半份锁也会被当成死锁删掉。这里换成**谁都不删别人**的形状:
//   · 每个进程在锁目录里放一份自己的登记 `<token>.<pid>.json`,内容随文件原子出现(link 一份写好的临时文件);
//   · 放下之后再看目录:还有别的 token 的登记、而它的主人活着(pid + 进程启动时刻对得上,查不准按活着算)⇒ 撤掉自己那份、
//     不做。两个同时到的会互相看见、都退下 —— 只会「都没拿到」,不会「都拿到了」;
//   · 主人已死的登记不算数,顺手删掉(它的主人不会再回来写它,删它跟谁都不冲突);读不懂的按活着算,交给人删。
// 锁两处:这份检出的 git 目录(依赖、产物;worktree 各有各的;解包装的没有 git 目录,放安装目录下)、库和 runs 的真实落点所在的目录
// (两份检出可以经 NAVI_DATA_DIR / NAVI_DB / 软链指到同一份数据,见 dataLockDirs)。升级第一段拿到锁,拉完代码交给第二段时把 token 经环境变量递过去,第二段用同一个 token 放自己的登记 —— 同一次操作;
// 认的是「父进程放的那份」,不是字符串本身(othersIn)。第二段一接到就把它从环境里抹掉,不往装依赖、起服务那些子进程里传。
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readStorageEnv } from "./env.mjs";
import { alive, atomicCreate, resourceKeys, selfStartedAtMs } from "./relocate-checkout-lock.mjs";
import { git } from "./upgrade-git.mjs";

/** 第一段递给第二段的那个 token(只在这一对父子之间有效,见 othersIn)。 */
export const UPGRADE_LOCK_ENV = "NAVI_UPGRADE_LOCK_TOKEN";

const ENTRY = /^([0-9a-f]+)\.(\d+)\.json$/;

/** 这份检出的锁目录:git 目录里(不进工作区);不是 git 检出(解包装的,setup / restart 照样要互斥)就放在安装目录下。 */
export function checkoutLockDir(repo) {
  const dir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  return dir.ok && dir.out && isAbsolute(dir.out) ? join(dir.out, "navi-upgrade.lock.d") : join(resolve(repo), ".navi-upgrade.lock.d");
}

/**
 * 数据那一头的锁目录:按**资源的真实落点**定,跟离线维护锁同一套资源键(relocate-checkout-lock 的 resourceKeys:库文件和 runs
 * 目录各取 realpath)—— 库文件本身是软链时,两份安装的数据目录不同、指着的却是同一份库,只按数据目录(链接所在的地方)上锁就
 * 各锁各的(审查第 4 轮实测)。每个键的真实所在目录放一把,去重;库改名(ash.db → navi.db)不挪目录,锁不跟着变。
 * 解析不了真实落点(权限、链接成环)就抛出去:证明不了是哪份资源,不凭字面路径放行。
 */
export function dataLockDirs(dbFile, env = process.env) {
  const runs = readStorageEnv(env, "NAVI_RUNS_DIR");
  const keys = resourceKeys(resolve(dbFile), [runs ? resolve(runs) : join(dirname(resolve(dbFile)), "runs")]);
  return [...new Set(keys.map((k) => join(dirname(k), ".navi-upgrade.lock.d")))].sort();
}

/**
 * 目录里别人那几份还算数的登记:{ file, token, pid, note, startedAt }。同一个 token 只放过**父进程**那一份(升级第一段把锁递给
 * 它 spawn 的第二段)—— token 只是一串字,会顺着环境变量漏进常驻服务、再被内置终端继承;只比字符串,两个毫不相干的维护进程
 * 拿着同一串字就互相放行了(审查实测)。
 */
function othersIn(dir, token) {
  let names;
  try { names = readdirSync(dir); } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [{ file: dir, note: `锁目录读不了(${error.code ?? error.message})` }];
  }
  const out = [];
  for (const name of names) {
    const m = ENTRY.exec(name);
    if (!m) continue;
    const pid = Number(m[2]);
    if (m[1] === token && (pid === process.pid || pid === process.ppid)) continue;
    const file = join(dir, name);
    let body = null;
    try { body = JSON.parse(readFileSync(file, "utf8")); } catch { /* 下面按读不懂处理 */ }
    if (!body || !Number.isInteger(body.pid)) { out.push({ file, note: "这份登记读不懂" }); continue; }
    if (!alive(body.pid, body.startedAtMs)) { rmSync(file, { force: true }); continue; }
    out.push({ file, token: m[1], pid: body.pid, note: body.note, startedAt: body.startedAt });
  }
  return out;
}

const describe = (h) => (h.pid
  ? `这份检出(或它的数据)正被另一次 ${h.note ?? "维护"} 占着(pid ${h.pid},${h.startedAt} 开始),等它做完再来;`
    + `确定没有(那个 pid 是别的程序)就删掉 ${h.file}`
  : `${h.file}:${h.note},分不清有没有别的升级 / restart / setup 在跑;确定没有就删掉它再来`);

/**
 * 在 dirs 这几个锁目录里放下自己的登记。返回 { ok:true, token, release } 或 { ok:false, why }(有人在做;或者锁的位置写不进去)。
 * token = 同一次操作里上一段递来的那个(升级第二段);缺省新开一个。release 只撤自己这个进程放的那几份。
 */
export function acquireUpgradeLock(dirs, { token = null, note }) {
  const mine = [];
  const release = () => { for (const f of mine.splice(0)) rmSync(f, { force: true }); };
  const t = token || randomBytes(12).toString("hex");
  const body = JSON.stringify({ pid: process.pid, startedAtMs: selfStartedAtMs(), startedAt: new Date().toISOString(), note, token: t });
  for (const dir of dirs) {
    const file = join(dir, `${t}.${process.pid}.json`);
    try {
      mkdirSync(dir, { recursive: true });
      if (!atomicCreate(file, body)) { release(); return { ok: false, why: `${file} 已经在了(同一个进程拿了两次锁)` }; }
    } catch (error) {
      release();
      return { ok: false, why: `升级锁 ${dir} 写不进去:${error.message}` };
    }
    mine.push(file);
  }
  for (const dir of dirs) {
    const [held] = othersIn(dir, t);
    if (held) { release(); return { ok: false, why: describe(held) }; }
  }
  return { ok: true, token: t, release };
}

/**
 * restart / setup 用:拿这份检出(和数据)的锁,拿不到就说清楚退出 2。进程退出时自动放掉。
 * 一律现开 token:升级不会叫它们,环境里带着的 token 只可能是漏出来的(老版本升级起的服务、它的终端)。
 */
export function holdOrExit({ repo, dbFile = null, note, env = process.env }) {
  let lock;
  try {
    const dirs = [checkoutLockDir(repo), ...(dbFile ? dataLockDirs(dbFile, env) : [])];
    lock = acquireUpgradeLock(dirs, { note });
  } catch (error) {
    lock = { ok: false, why: error.message };
  }
  if (!lock.ok) {
    process.stderr.write(`✕ ${lock.why}\n`);
    process.exit(2);
  }
  process.on("exit", lock.release);
  return lock;
}
