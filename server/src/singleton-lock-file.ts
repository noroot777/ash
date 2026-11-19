// 单例锁文件本身：格式、读、心跳、陈旧判定。取锁/放锁的流程在 singleton.ts。
//
// 判据（pid 存活 + 命令形状 + 启动时刻）跨版本不变：改名前后的服务写的是同一种锁，彼此认得出
// 对方的锁是不是活的 —— 新版同时持有新旧两个名字的锁（见 singleton.ts `writeOwnLock`），靠的就是这一点。
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isPidAlive } from "./platform.js";
import { inspectProcess as inspectProcessInfo, type ProcessInfo } from "./proc.js";

const START_TIME_TOLERANCE_MS = 10_000;

export type LockFile = {
  version: number;
  pid: number;
  processStartedAt: string;
  processStartedAtMs: number;
  acquiredAt: string;
  port: number | null;
  dbFile: string;
  cwd: string;
  argv: string[];
  token: string;
  /** 最近一次心跳(见 HEARTBEAT_MS)。旧版本写的锁没有这两个字段。 */
  heartbeatAt?: string;
  heartbeatAtMs?: number;
};

/**
 * 刷一次心跳。
 *
 * 必须**原子换**(临时文件 + rename):这把锁同时被另一个启动流程和 scripts/restart.mjs
 * 读,就地改写会让读到半行的那一方 JSON 解析失败,进而把「不可读」当成陈旧锁覆盖掉 ——
 * 代价是两个 server 调度同一份库。rename 前再认一次 pid+token,是为了别把一把已经被
 * 人工删掉、或已被别的实例接走的锁又写回来。
 */
export function beat(lockFile: string, lock: LockFile): void {
  const now = Date.now();
  // 固定名(而不是按 token 取名):实例被 SIGKILL 在 rename 之前时,留下的是**同一个**
  // 临时文件,下一拍直接覆盖;按 token 取名的话每次强杀都在数据目录里多留一份垃圾。
  const temp = `${lockFile}.beat`;
  try {
    const next: LockFile = { ...lock, heartbeatAtMs: now, heartbeatAt: new Date(now).toISOString() };
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    const current = readLock(lockFile);
    if (current?.pid === lock.pid && current.token === lock.token) {
      renameSync(temp, lockFile);
      lock.heartbeatAtMs = next.heartbeatAtMs;
      lock.heartbeatAt = next.heartbeatAt;
    } else {
      rmSync(temp, { force: true });
    }
  } catch {
    // 心跳失败只损失「死亡时刻」的分辨率,不值得让服务为它崩。
    try { rmSync(temp, { force: true }); } catch { /* 清不掉就留着,下一拍覆盖 */ }
  }
}

export function staleLockReason(lock: Partial<LockFile> | null): string | null {
  if (!lock) return "lock file is unreadable";
  const pid = lock.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "lock file has no valid PID";
  if (!isPidAlive(pid)) return `PID ${pid} is not running`;

  const info = inspectProcess(pid);
  if (!info) return `PID ${pid} is alive but cannot be inspected`;
  if (!isNaviServerCommand(info.command)) {
    return `PID ${pid} is not a Navi server process (${info.command ?? "unknown command"})`;
  }
  if (typeof lock.processStartedAtMs === "number" && info.startedAtMs !== null) {
    const delta = Math.abs(info.startedAtMs - lock.processStartedAtMs);
    if (delta > START_TIME_TOLERANCE_MS) {
      return `PID ${pid} was reused (lock start ${lock.processStartedAt}, current start ${info.startedAt})`;
    }
  }
  return null;
}

export function holderFromLock(lockFile: string) {
  const lock = readLock(lockFile);
  const pid = typeof lock?.pid === "number" && Number.isInteger(lock.pid) ? lock.pid : -1;
  const info = pid > 0 ? inspectProcess(pid) : null;
  return {
    pid,
    startedAt: lock?.processStartedAt ?? info?.startedAt ?? null,
    port: lock?.port ?? null,
    command: info?.command ?? lock?.argv?.join(" ") ?? null,
  };
}

export function readLock(lockFile: string): Partial<LockFile> | null {
  const result = readLockResult(lockFile);
  return "error" in result ? null : result.lock;
}

/**
 * 同一次读取,但把「读不到」和「读到了、不是我的」分开。
 *
 * `readLock` 那个吞掉异常的版本给陈旧检测用没问题(读不出来本身就是一条陈旧理由),
 * 但 `release()` 不能用它:那里把 null 当成「锁不是自己的」,等于把一次 EACCES
 * 说成身份已变(第 2 轮审查)。
 */
export function readLockResult(lockFile: string): { lock: Partial<LockFile> } | { error: unknown } {
  let text: string;
  try {
    text = readFileSync(lockFile, "utf8");
  } catch (e) {
    return { error: e };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { error: new Error("lock file is not an object") };
    return { lock: parsed as Partial<LockFile> };
  } catch (e) {
    return { error: e };
  }
}

export function errnoOf(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? String(e);
}

export function inspectProcess(pid: number): ProcessInfo | null {
  return inspectProcessInfo(pid);
}

// 命令行长什么样两个平台差很远,分隔符、`.exe` 后缀、带空格路径的引号全不一样:
//   POSIX:   /opt/homebrew/bin/node /Users/example/code/navi/server/dist/index.js
//   Windows: "C:\Program Files\nodejs\node.exe" C:\Users\example\navi\server\dist\index.js
// 所以路径分隔符两种都认,可执行名允许 `.exe` 和前置引号。宁可放宽也不能收窄 ——
// 认不出来的后果是「把活着的 server 判成陈旧锁然后覆盖掉」,那就双实例了。
export function isNaviServerCommand(command: string | null) {
  if (!command) return false;
  return (
    /(?:^|[\s"'])(?:[^\s"']*[\\/])?(?:node|tsx)(?:\.exe|\.cmd)?(?:[\s"']|$)/i.test(command) &&
    /(?:server[\\/])?(?:dist|src)[\\/]index\.(?:js|ts)\b/i.test(command)
  );
}

export function isAlreadyExists(e: any) {
  return e?.code === "EEXIST";
}

export function isNotFound(e: any) {
  return e?.code === "ENOENT";
}
