// 离线维护锁：**一把真锁**，不是一次探活。
//
// 历史回填那类脚本会直接改 `sessions`、`usage_cumulative_snapshots` 和 data/runs 里的
// trace 文件。只在动手之前「看一眼有没有活着的 ash」是不够的 —— 看完到写完之间服务可以
// 起来，另一份迁移也可以同时开跑，两边各写一半同一条 CLI 线程的账（第 2 轮审查 F2 并发面）。
//
// 锁**按资源键**配，一套资源有几个可写资源就取几把：历史回填传的是「库文件 + 它的 runs
// 目录」两个键。只锁库文件是不够的 —— 要改的文件在 runs 里，而别的库路径（副本、软链、
// 父目录别名）也可能落到同一份 runs 上，那时按库命名的锁根本不是同一把（第 1 轮审查 F1）。
//
// 两个方向都挡：
// ① 维护脚本之间：原子建锁文件，已经有活着的持有者就直接拒。
// ② 维护脚本和 ash 服务之间：`acquireDbSingletonLock` 起手会查这些锁（见 singleton.ts），
//    迁移跑着的时候服务起不来；反方向则由**占有锁里的在线复查**负责 —— 下面取锁时会在
//    claim 内重新查一遍 ash 的在线登记（ash-presence.ts）。
//
// **两边的「查对方 + 登记自己」必须都在同一把占有锁里**（resource-claim.ts）。只有一边
// 包起来是不够的：第 3 轮审查 F2 用真实服务实测了剩下那条交错 —— 迁移在 claim 之外探了
// 一次「没有 ash」，服务随后拿到 claim 起来并写下自己的锁，迁移再拿到 claim 写维护锁，
// 两边同时活着（`BOTH_LIVE`，服务 /api/health 仍返回 200）。所以探活不能留在 claim 外面。
//
// **为什么不复用 ash 自己那把单例锁**：`staleLockReason` 要求持有者的命令行长得像
// `node server/dist/index.js`，脚本的命令行对不上，于是服务会把脚本的锁判成陈旧锁直接
// 覆盖 —— 看着锁住了，其实谁都没挡住。
//
// 陈旧判据故意只认两条硬事实（pid 还活着 + 进程启动时刻对得上），**不认命令行形状**：
// 脚本被强杀之后那把锁必须自动失效，否则 ash 就永远起不来了。读不出来的锁一律按陈旧算
// （宁可少挡一次，也不能把服务永久挡在外面）—— 锁文件是**带着内容原子出现**的
// （`atomicCreateWithContent`），所以「读不懂」不再可能是「刚建好还没写完」那一瞬。
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { resolveAshDbFile } from "./db/path.js";
import { isPidAlive } from "./platform.js";
import { inspectProcess } from "./proc.js";
import { atomicCreateWithContent, withResourceClaim } from "./resource-claim.js";
import { AshPresenceUnknownError, describeAshPresence, liveAshPresenceForAny } from "./ash-presence.js";

const SUFFIX = ".maintenance.lock";
/** 进程启动时刻的比对容差，跟 singleton.ts 同一个量级。 */
const START_TIME_TOLERANCE_MS = 10_000;

/** 资源键 → 锁文件。键可以是库文件路径，也可以是 runs 目录路径（锁落在它旁边，不落在里面）。 */
export function maintenanceLockFileFor(key: string): string {
  return `${key}${SUFFIX}`;
}
export function maintenanceLockFileForDb(dbFile = resolveAshDbFile()): string {
  return maintenanceLockFileFor(dbFile);
}

type LockFile = {
  pid: number;
  processStartedAt: string | null;
  processStartedAtMs: number | null;
  acquiredAt: string;
  note: string;
  token: string;
  /** 这把锁锁的是哪个资源键。 */
  key: string;
};

export type MaintenanceHolder = {
  pid: number;
  startedAt: string | null;
  acquiredAt: string | null;
  note: string;
};

/** 取锁时在 claim 内发现这套资源上还有活着的 ash。 */
export class AshOnlineError extends Error {
  constructor(public readonly detail: string) {
    super(`拒绝动手：这套资源上还有活着的 ash —— ${detail}\n`
      + "先停掉它再回填 —— 跑着的回合会跟回填抢同一条线程的累计快照和同一份 trace 文件。");
    this.name = "AshOnlineError";
  }
}

export class MaintenanceLockError extends Error {
  constructor(public readonly holder: MaintenanceHolder, public readonly lockFile: string) {
    super(
      `这套资源正被另一个维护进程占着（PID ${holder.pid}，起于 ${holder.startedAt ?? "不详"}）：`
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
export function liveMaintenanceHolderFor(key: string): MaintenanceHolder | null {
  const lockFile = maintenanceLockFileFor(key);
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

export function liveMaintenanceHolderForDb(dbFile = resolveAshDbFile()): MaintenanceHolder | null {
  return liveMaintenanceHolderFor(dbFile);
}

/** 这一组资源键里，第一个还被别人占着的键。全空就是没人占。 */
export function liveMaintenanceHolderForAny(keys: readonly string[]):
{ key: string; holder: MaintenanceHolder } | null {
  for (const key of keys) {
    const holder = liveMaintenanceHolderFor(key);
    if (holder) return { key, holder };
  }
  return null;
}

export type MaintenanceLock = { lockFiles: string[]; release: () => void };

/**
 * 取锁。已经有活着的持有者就抛 `MaintenanceLockError`（**不等待、不抢**：维护是人按下的
 * 动作，排队只会让两个人以为自己在独占）。
 *
 * `keys` 是这次要写的**全部可写资源**的键，一个都不能少：少一个就等于那份资源没被锁住。
 * 取的过程包在 `withResourceClaim` 里，所以「查对方 + 建自己」对服务启动那一侧也是原子的。
 */
export function acquireMaintenanceLocks(
  keys: readonly string[],
  note = process.argv.slice(1).join(" "),
  options: {
    /**
     * 额外的在线探测，**在 claim 里**跑。默认那条只认新版的在线登记；老 build 起的服务
     * 只写单例锁，调用方（CLI）把 `liveAshHolderForDb` 从这里补进来。返回非空 = 拒绝。
     */
    onlineProbe?: () => string | null;
  } = {},
): MaintenanceLock {
  const unique = [...new Set(keys)];
  return withResourceClaim(unique, `维护取锁：${note}`, () => {
    // ── claim 内复查在线服务 ────────────────────────────────────────────────
    // claim 之外探一次只能证明「那一刻没有」。真正的互斥要求「查对方」和「登记自己」在
    // 同一个临界区里，所以这一查必须在这儿，不能留在调用方的 claim 外面。
    // 「证明不了没人在线」和「有人在线」在这里是同一个结论:维护会改 sessions 和 trace,跟一个还活着
    // 的写入者抢同一条线程就互相覆盖,所以这一关只接受**证明得了的否**。
    let online;
    try {
      online = liveAshPresenceForAny(unique);
    } catch (error) {
      if (error instanceof AshPresenceUnknownError) throw new AshOnlineError(error.message);
      throw error;
    }
    if (online) throw new AshOnlineError(describeAshPresence(online));
    const extra = options.onlineProbe?.();
    if (extra) throw new AshOnlineError(extra);

    const taken: { file: string; token: string }[] = [];
    const rollback = () => {
      for (const item of [...taken].reverse()) releaseLock(item.file, item.token);
    };
    try {
      return takeAll(unique, note, taken);
    } catch (error) {
      // **任何**出口都要把已经取到的那几把放回去，不只是冲突那一条分支:第二个键的
      // mkdir/write/link 抛个普通异常，第一把锁留在盘上会以活 PID 把服务挡在外面
      // （第 3 轮审查 N2）。
      rollback();
      throw error;
    }
  });
}

/** 逐个键把长命锁落下来。已取到的都 push 进 `taken`，失败时由调用方统一回滚。 */
function takeAll(
  unique: string[],
  note: string,
  taken: { file: string; token: string }[],
): MaintenanceLock {
  for (const key of unique) {
    const lockFile = maintenanceLockFileFor(key);
    mkdirSync(dirname(lockFile), { recursive: true });
    const processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
    const lock: LockFile = {
      pid: process.pid,
      processStartedAt: new Date(processStartedAtMs).toISOString(),
      processStartedAtMs,
      acquiredAt: new Date().toISOString(),
      note,
      token: randomUUID(),
      key,
    };
    // 一次就够:占有锁已经把并发挡在外面了,这里剩下的只有「上一次留下的陈旧锁」。
    if (!atomicCreateWithContent(lockFile, JSON.stringify(lock, null, 2))) {
      const holder = liveMaintenanceHolderFor(key);
      if (holder) throw new MaintenanceLockError(holder, lockFile);
      try {
        unlinkSync(lockFile); // 陈旧锁，清掉再来
      } catch { /* 别人同时清了 */ }
      if (!atomicCreateWithContent(lockFile, JSON.stringify(lock, null, 2))) {
        throw new MaintenanceLockError(
          liveMaintenanceHolderFor(key)
            ?? { pid: -1, startedAt: null, acquiredAt: null, note: "锁文件反复被占" },
          lockFile,
        );
      }
    }
    taken.push({ file: lockFile, token: lock.token });
  }
  return {
    lockFiles: taken.map((item) => item.file),
    release: () => {
      for (const item of [...taken].reverse()) releaseLock(item.file, item.token);
    },
  };
}

/** 单键的便捷入口（测试和只改库的场景用）。 */
export function acquireMaintenanceLock(
  dbFile: string = resolveAshDbFile(),
  note = process.argv.slice(1).join(" "),
): MaintenanceLock {
  return acquireMaintenanceLocks([dbFile], note);
}

function releaseLock(lockFile: string, token: string): void {
  // 只删自己那把：锁文件可能已经被别人换过（我们被判成陈旧之后）。
  if (readLock(lockFile)?.token !== token) return;
  try {
    unlinkSync(lockFile);
  } catch (error) {
    console.warn(`[ash] 维护锁没删掉 ${lockFile}:`, error);
  }
}
