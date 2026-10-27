// 离线维护锁：**一把真锁**，不是一次探活。
//
// 历史回填那类脚本会直接改 `sessions`、`usage_cumulative_snapshots` 和 data/runs 里的
// trace 文件。只在动手之前「看一眼有没有活着的 ash」是不够的 —— 看完到写完之间服务可以
// 起来，另一份迁移也可以同时开跑，两边各写一半同一条 CLI 线程的账（第 2 轮审查 F2 并发面）。
//
// 所以这里给**库文件**配一把独立的锁，两个方向都挡：
// ① 维护脚本之间：`O_EXCL` 建锁文件，已经有活着的持有者就直接拒。
// ② 维护脚本和 ash 服务之间：`acquireDbSingletonLock` 起手会查这把锁（见 singleton.ts），
//    迁移跑着的时候服务起不来，而服务跑着的时候脚本那边的 `liveAshHolderForDb` 会拒。
//
// **为什么不复用 ash 自己那把单例锁**：`staleLockReason` 要求持有者的命令行长得像
// `node server/dist/index.js`，脚本的命令行对不上，于是服务会把脚本的锁判成陈旧锁直接
// 覆盖 —— 看着锁住了，其实谁都没挡住。
//
// 陈旧判据故意只认两条硬事实（pid 还活着 + 进程启动时刻对得上），**不认命令行形状**：
// 脚本被强杀之后那把锁必须自动失效，否则 ash 就永远起不来了。读不出来的锁一律按陈旧算
// （宁可少挡一次，也不能把服务永久挡在外面）—— 真有并发时另一侧还有 ash 自己那把锁兜着。
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveAshDbFile, ensureAshDbDir } from "./db/path.js";
import { isPidAlive } from "./platform.js";
import { inspectProcess } from "./proc.js";

const SUFFIX = ".maintenance.lock";
/** 进程启动时刻的比对容差，跟 singleton.ts 同一个量级。 */
const START_TIME_TOLERANCE_MS = 10_000;

export function maintenanceLockFileForDb(dbFile = resolveAshDbFile()): string {
  return `${dbFile}${SUFFIX}`;
}

type LockFile = {
  pid: number;
  processStartedAt: string | null;
  processStartedAtMs: number | null;
  acquiredAt: string;
  note: string;
  token: string;
  dbFile: string;
};

export type MaintenanceHolder = {
  pid: number;
  startedAt: string | null;
  acquiredAt: string | null;
  note: string;
};

export class MaintenanceLockError extends Error {
  constructor(public readonly holder: MaintenanceHolder, public readonly lockFile: string) {
    super(
      `这份库正被另一个维护进程占着（PID ${holder.pid}，起于 ${holder.startedAt ?? "不详"}）：`
      + `${holder.note}\n锁文件：${lockFile}\n`
      + "等它结束，或者确认那个进程已经不在之后删掉锁文件。",
    );
    this.name = "MaintenanceLockError";
  }
}

function readLock(lockFile: string): LockFile | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, "utf8")) as Partial<LockFile>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed as LockFile;
  } catch {
    return null;
  }
}

/** 这把锁现在有没有活着的持有者。读不出来、pid 已死、pid 被复用都算没有。 */
export function liveMaintenanceHolderForDb(dbFile = resolveAshDbFile()): MaintenanceHolder | null {
  const lockFile = maintenanceLockFileForDb(dbFile);
  if (!existsSync(lockFile)) return null;
  const lock = readLock(lockFile);
  if (!lock || !isPidAlive(lock.pid)) return null;
  const info = inspectProcess(lock.pid);
  if (
    typeof lock.processStartedAtMs === "number" && info?.startedAtMs !== null && info?.startedAtMs !== undefined
    && Math.abs(info.startedAtMs - lock.processStartedAtMs) > START_TIME_TOLERANCE_MS
  ) {
    return null; // pid 被复用了，这把锁早就没主
  }
  return {
    pid: lock.pid,
    startedAt: lock.processStartedAt ?? info?.startedAt ?? null,
    acquiredAt: lock.acquiredAt ?? null,
    note: lock.note || (info?.command ?? "维护进程"),
  };
}

export type MaintenanceLock = { lockFile: string; release: () => void };

/**
 * 取锁。已经有活着的持有者就抛 `MaintenanceLockError`（**不等待、不抢**：维护是人按下的
 * 动作，排队只会让两个人以为自己在独占）。
 */
export function acquireMaintenanceLock(
  dbFile: string = resolveAshDbFile(),
  note = process.argv.slice(1).join(" "),
): MaintenanceLock {
  const lockFile = maintenanceLockFileForDb(dbFile);
  ensureAshDbDir(dbFile);
  const processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  const lock: LockFile = {
    pid: process.pid,
    processStartedAt: new Date(processStartedAtMs).toISOString(),
    processStartedAtMs,
    acquiredAt: new Date().toISOString(),
    note,
    token: randomUUID(),
    dbFile,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(lock, null, 2));
      } finally {
        closeSync(fd);
      }
      return {
        lockFile,
        release: () => {
          // 只删自己那把：锁文件可能已经被别人换过（我们被判成陈旧之后）。
          if (readLock(lockFile)?.token !== lock.token) return;
          try {
            unlinkSync(lockFile);
          } catch (error) {
            console.warn(`[ash] 维护锁没删掉 ${lockFile}:`, error);
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = liveMaintenanceHolderForDb(dbFile);
      if (holder) throw new MaintenanceLockError(holder, lockFile);
      try {
        unlinkSync(lockFile); // 陈旧锁，清掉再试一次
      } catch { /* 别人同时清了，下一轮 wx 会说话 */ }
    }
  }
  throw new MaintenanceLockError(
    { pid: -1, startedAt: null, acquiredAt: null, note: "锁文件反复被占，可能有另一个维护进程正在起手" },
    lockFile,
  );
}
