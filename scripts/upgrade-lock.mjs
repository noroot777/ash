// 同一份检出同一时刻只许一次升级。
//
// 升级从拉代码到起服务要好几分钟,中间装依赖、构建、改库名、写进度,两次一起跑就互相踩:两边同时 npm install 进同一个
// node_modules,后到的那次还会把先到那次正在写的进度当成「上次没做完」接着做,最后抢同一个端口(审查实测过)。磁盘上有
// 进度记录推不出「上次那个升级进程已经退了」,所以要一把覆盖整次升级的锁,锁里写着持有者的 pid:
//   · 放在这份检出的 git 目录里(`.git/navi-upgrade.lock`,worktree 各有各的):管的是这份检出的依赖、产物,连同它那份数据;
//   · 第一段拿锁,拉完代码交给第二段时把 token 经环境变量递过去,第二段核对 token 后把 pid 换成自己 —— 第一段被杀了,
//     第二段照样持有;整次结束由第一段删掉;
//   · 持有者死了(断电、被杀)就是过期,下一次升级接手;接手先把旧锁改名挪开再看一眼,挪开的要是刚被别人新拿的,原样挪回去。
// restart.mjs / setup.mjs 也问这把锁:它们同样装依赖、构建、起服务,升级进行中不该插进来。
import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isPidAlive } from "./platform.mjs";
import { git } from "./upgrade-git.mjs";

/** 第一段递给第二段的那把锁的 token。 */
export const UPGRADE_LOCK_ENV = "NAVI_UPGRADE_LOCK_TOKEN";

/** 锁文件的位置;不是 git 检出就是 null(那样的检出升级第一步就拦下了)。 */
export function upgradeLockFile(repo) {
  const dir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok || !dir.out || !isAbsolute(dir.out)) return null;
  return join(dir.out, "navi-upgrade.lock");
}

function readLock(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** 正在进行的那次升级(持有者还活着):{ pid, startedAt, file };没有就是 null。 */
export function liveUpgrade(repo) {
  const file = upgradeLockFile(repo);
  const lock = file && readLock(file);
  return lock && isPidAlive(lock.pid) && lock.pid !== process.pid ? { ...lock, file } : null;
}

/** 有升级在跑时 restart / setup 说的那句话;没有就是 null。 */
export function upgradeInProgressLine(repo) {
  const held = liveUpgrade(repo);
  return held
    ? `这份检出正在升级(pid ${held.pid},${held.startedAt} 开始),等它做完再来。确定没有升级在跑(那个 pid 是别的程序)就删掉 ${held.file}`
    : null;
}

/**
 * 拿锁。返回 { ok:true, token, release } 或 { ok:false, why }(有人持有着;或者锁的位置写不进去)。
 * token = 第一段递来的那个:核对是同一把,把 pid 换成自己(第二段)。
 */
export function acquireUpgradeLock(repo, { token = null, startedAt = new Date().toISOString() } = {}) {
  const file = upgradeLockFile(repo);
  if (!file) return { ok: false, why: `${repo} 不是 git 检出,拿不到升级锁` };
  const mine = (t) => ({ ok: true, token: t, release: () => { if (readLock(file)?.token === t) rmSync(file, { force: true }); } });
  if (token) {
    const lock = readLock(file);
    if (lock?.token !== token) return { ok: false, why: "第一段交过来的升级锁不见了或换了人" };
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ ...lock, pid: process.pid }));
    renameSync(`${file}.${process.pid}.tmp`, file);
    return mine(token);
  }
  const fresh = randomBytes(12).toString("hex");
  const body = JSON.stringify({ pid: process.pid, token: fresh, startedAt });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(file, body, { flag: "wx" });
      return mine(fresh);
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, why: `升级锁 ${file} 写不进去:${error.message}` };
    }
    const held = readLock(file);
    if (held && isPidAlive(held.pid)) {
      return { ok: false, why: `这份检出已经有一次升级在跑(pid ${held.pid},${held.startedAt} 开始),等它做完;确定没有(那个 pid 是别的程序)就删掉 ${file} 再跑` };
    }
    // 持有者死了:挪开再认一眼。挪开的要是别人刚新拿的(活着),原样挪回去、按「有人在跑」算。
    const aside = `${file}.stale-${process.pid}-${attempt}`;
    try { renameSync(file, aside); } catch { continue; }
    const moved = readLock(aside);
    if (moved && isPidAlive(moved.pid)) {
      try { linkSync(aside, file); } catch { /* 那个位置又被人拿了:两把都活着说不通,下一轮照实报 */ }
      rmSync(aside, { force: true });
      continue;
    }
    rmSync(aside, { force: true });
  }
  return { ok: false, why: `升级锁 ${file} 一直在变,像是有几次升级同时在抢;等一下再跑` };
}
