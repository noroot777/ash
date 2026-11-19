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
// 锁两处:这份检出的 git 目录(依赖、产物;worktree 各有各的;解包装的没有 git 目录,放安装目录下)、库所在的目录(两份检出可以经 NAVI_DATA_DIR / NAVI_DB 指到同一份
// 数据)。升级第一段拿到锁,拉完代码交给第二段时把 token 经环境变量递过去,第二段用同一个 token 放自己的登记 —— 同一次操作。
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { alive, atomicCreate, selfStartedAtMs } from "./relocate-checkout-lock.mjs";
import { git } from "./upgrade-git.mjs";

/** 第一段递给第二段的那个 token。 */
export const UPGRADE_LOCK_ENV = "NAVI_UPGRADE_LOCK_TOKEN";

const ENTRY = /^([0-9a-f]+)\.(\d+)\.json$/;

/** 这份检出的锁目录:git 目录里(不进工作区);不是 git 检出(解包装的,setup / restart 照样要互斥)就放在安装目录下。 */
export function checkoutLockDir(repo) {
  const dir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  return dir.ok && dir.out && isAbsolute(dir.out) ? join(dir.out, "navi-upgrade.lock.d") : join(resolve(repo), ".navi-upgrade.lock.d");
}

/** 库所在目录的锁目录(按真实落点:软链、`..` 过来的同一份数据是同一把)。 */
export function dataLockDir(dbFile) {
  const dir = resolve(dirname(dbFile));
  let real = dir;
  try { real = realpathSync(dir); } catch { /* 还不存在(新安装):就用这个名字,第一次放登记时建出来 */ }
  return join(real, ".navi-upgrade.lock.d");
}

/** 目录里别人那几份还算数的登记:{ file, token, pid, note, startedAt }。 */
function othersIn(dir, token) {
  let names;
  try { names = readdirSync(dir); } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [{ file: dir, note: `锁目录读不了(${error.code ?? error.message})` }];
  }
  const out = [];
  for (const name of names) {
    const m = ENTRY.exec(name);
    if (!m || m[1] === token) continue;
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
 * 环境变量里带着 token 的(从某次升级里被叫起来的),算同一次操作。
 */
export function holdOrExit({ repo, dbFile = null, note, env = process.env }) {
  const dirs = [checkoutLockDir(repo), ...(dbFile ? [dataLockDir(dbFile)] : [])];
  const lock = acquireUpgradeLock(dirs, { token: env[UPGRADE_LOCK_ENV] || null, note });
  if (!lock.ok) {
    process.stderr.write(`✕ ${lock.why}\n`);
    process.exit(2);
  }
  process.on("exit", lock.release);
  return lock;
}
