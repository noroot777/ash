import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolveAshDbFile, ensureAshDbDir } from "./db/path.js";
import { IS_WINDOWS, isPidAlive, killPidsCommand } from "./platform.js";
import { inspectProcess as inspectProcessInfo, type ProcessInfo } from "./proc.js";

const LOCK_VERSION = 1;
const LOCK_SUFFIX = ".ash.lock";
const START_TIME_TOLERANCE_MS = 10_000;

/** 本进程拿到锁时写进去的 token（见 liveLockToken）。没拿到锁就一直是 null。 */
let ownLockToken: string | null = null;

type LockFile = {
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
};

export class SingletonConflictError extends Error {
  constructor(
    public readonly dbFile: string,
    public readonly lockFile: string,
    public readonly holder: {
      pid: number;
      startedAt: string | null;
      port: number | null;
      command: string | null;
    },
    reason = "database is already owned by another live ash server",
  ) {
    super(formatConflictMessage(dbFile, lockFile, holder, reason));
    this.name = "SingletonConflictError";
  }
}

export type SingletonLock = {
  dbFile: string;
  lockFile: string;
  release: () => void;
};

export function singletonLockFileForDb(dbFile = resolveAshDbFile()) {
  return `${dbFile}${LOCK_SUFFIX}`;
}

/**
 * 本进程写进锁文件的那串随机 token。
 *
 * 它顺带是**宿主机运维者**的凭证:锁文件按 0600 落盘(见 `writeOwnLock` 的 `openSync`),
 * 读得到它 = 读得到 ash 的数据目录 = 本来就能直接读库。多人模式下 `scripts/restart.mjs`
 * 拿它去打 `/api/restart-impact` —— 那个脚本跑在宿主机上,手里没有任何网页登录态,而
 * 那条端点被鉴权闸挡住时它只会把「会被打断的任务数」算成 0,安全闸静默失效
 * (第 1 轮审查 P1)。
 *
 * 没拿到锁(`ASH_ALLOW_MULTI=1`)时是 null:那种情况下这条凭证不存在,端点该拒就拒。
 */
export function liveLockToken(): string | null {
  return ownLockToken;
}

export function acquireDbSingletonLock(options: { port?: number | null } = {}): SingletonLock | null {
  const dbFile = resolveAshDbFile();
  const lockFile = singletonLockFileForDb(dbFile);
  const port = options.port ?? null;

  if (process.env.ASH_ALLOW_MULTI === "1") {
    console.warn(
      `[ash] WARNING: ASH_ALLOW_MULTI=1 set; skipping single-instance guard for DB ${dbFile}`,
    );
    return null;
  }

  ensureAshDbDir(dbFile);
  const ownLock = writeOwnLock(dbFile, lockFile, port);

  try {
    const holders = findLiveAshDbHolders(dbFile).filter((p) => p.pid !== process.pid);
    if (holders.length > 0) {
      ownLock.release();
      const holder = holders[0]!;
      throw new SingletonConflictError(
        dbFile,
        lockFile,
        {
          pid: holder.pid,
          startedAt: holder.startedAt,
          port: null,
          command: holder.command,
        },
        "database is already open in another live ash process",
      );
    }
  } catch (e) {
    if (e instanceof SingletonConflictError) throw e;
    ownLock.release();
    throw e;
  }

  installCleanup(ownLock);
  return ownLock;
}

function writeOwnLock(dbFile: string, lockFile: string, port: number | null): SingletonLock {
  const processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  const lock: LockFile = {
    version: LOCK_VERSION,
    pid: process.pid,
    processStartedAt: new Date(processStartedAtMs).toISOString(),
    processStartedAtMs,
    acquiredAt: new Date().toISOString(),
    port,
    dbFile,
    cwd: process.cwd(),
    argv: process.argv,
    token: randomUUID(),
  };
  ownLockToken = lock.token;

  for (;;) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      const staleReason = staleLockReason(lockFile);
      if (!staleReason) {
        const holder = holderFromLock(lockFile);
        throw new SingletonConflictError(dbFile, lockFile, holder);
      }
      console.warn(`[ash] stale singleton lock at ${lockFile}: ${staleReason}; overwriting`);
      try {
        unlinkSync(lockFile);
      } catch (unlinkError) {
        if (!isNotFound(unlinkError)) throw unlinkError;
      }
    }
  }

  let released = false;
  return {
    dbFile,
    lockFile,
    release: () => {
      if (released) return;
      released = true;
      try {
        const current = readLock(lockFile);
        if (current?.pid === lock.pid && current.token === lock.token) unlinkSync(lockFile);
      } catch (e) {
        if (!isNotFound(e)) console.warn(`[ash] failed to release singleton lock ${lockFile}:`, e);
      }
    },
  };
}

function staleLockReason(lockFile: string): string | null {
  const lock = readLock(lockFile);
  if (!lock) return "lock file is unreadable";
  const pid = lock.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "lock file has no valid PID";
  if (!isPidAlive(pid)) return `PID ${pid} is not running`;

  const info = inspectProcess(pid);
  if (!info) return `PID ${pid} is alive but cannot be inspected`;
  if (!isAshServerCommand(info.command)) {
    return `PID ${pid} is not a ash server process (${info.command ?? "unknown command"})`;
  }
  if (typeof lock.processStartedAtMs === "number" && info.startedAtMs !== null) {
    const delta = Math.abs(info.startedAtMs - lock.processStartedAtMs);
    if (delta > START_TIME_TOLERANCE_MS) {
      return `PID ${pid} was reused (lock start ${lock.processStartedAt}, current start ${info.startedAt})`;
    }
  }
  return null;
}

function holderFromLock(lockFile: string) {
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

function readLock(lockFile: string): Partial<LockFile> | null {
  try {
    return JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function inspectProcess(pid: number): ProcessInfo | null {
  return inspectProcessInfo(pid);
}

// 锁文件之外的**第二道网**:锁文件可能被人手删、可能被别的工具覆盖,而「谁把这个
// DB 文件打开着」是操作系统的事实,骗不了。
//
// **Windows 上这道网是空的**:没有零依赖的 `lsof -t <file>` 等价物 —— Sysinternals
// 的 handle.exe 要单独装且要管理员权限,不能当成必备依赖。所以 Windows 上单实例保护
// 只剩锁文件那一道(pid + 进程启动时间 + token,足以识别 pid 复用和陈旧锁),失去的是
// 「锁文件被删掉之后还能兜住」这一层。如实降级,不假装有覆盖。
function findLiveAshDbHolders(dbFile: string): ProcessInfo[] {
  if (IS_WINDOWS) return [];
  if (!existsSync(dbFile)) return [];
  let out = "";
  try {
    out = execFileSync("lsof", ["-t", "--", dbFile], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const pids = [...new Set(out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return pids
    .map((pid) => inspectProcess(pid))
    .filter((info): info is ProcessInfo => Boolean(info && isAshServerCommand(info.command)));
}

// 命令行长什么样两个平台差很远,分隔符、`.exe` 后缀、带空格路径的引号全不一样:
//   POSIX:   /opt/homebrew/bin/node /Users/fjh/code/ash/server/dist/index.js
//   Windows: "C:\Program Files\nodejs\node.exe" C:\Users\fjh\ash\server\dist\index.js
// 所以路径分隔符两种都认,可执行名允许 `.exe` 和前置引号。宁可放宽也不能收窄 ——
// 认不出来的后果是「把活着的 server 判成陈旧锁然后覆盖掉」,那就双实例了。
function isAshServerCommand(command: string | null) {
  if (!command) return false;
  return (
    /(?:^|[\s"'])(?:[^\s"']*[\\/])?(?:node|tsx)(?:\.exe|\.cmd)?(?:[\s"']|$)/i.test(command) &&
    /(?:server[\\/])?(?:dist|src)[\\/]index\.(?:js|ts)\b/i.test(command)
  );
}

// Windows 不投递 SIGTERM(注册了也永远不会触发,留着无害);Ctrl+C 会有 SIGINT,
// Ctrl+Break 是 SIGBREAK,关掉控制台窗口是 SIGHUP。三条都接上,否则关窗口会留下
// 一把不会被清掉的锁,下次启动只能靠陈旧检测兜。
const EXIT_SIGNALS = (IS_WINDOWS
  ? ["SIGINT", "SIGBREAK", "SIGHUP"]
  : ["SIGINT", "SIGTERM"]) as readonly NodeJS.Signals[];

function installCleanup(lock: SingletonLock) {
  process.once("exit", lock.release);
  for (const signal of EXIT_SIGNALS) {
    process.once(signal, () => {
      lock.release();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function formatConflictMessage(
  dbFile: string,
  lockFile: string,
  holder: { pid: number; startedAt: string | null; port: number | null; command: string | null },
  reason: string,
) {
  const lines = [
    `[ash] Refusing to start: ${reason}.`,
    `  DB: ${dbFile}`,
    `  Lock: ${lockFile}`,
    `  PID: ${holder.pid}`,
    `  Started: ${holder.startedAt ?? "unknown"}`,
    `  Port: ${holder.port ?? "unknown"}`,
    `  Command: ${holder.command ?? "unknown"}`,
    "Stop the existing ash server first, then retry:",
    `  ${killPidsCommand([holder.pid])}`,
    ...(IS_WINDOWS
      ? []
      : ["If it does not exit, use:", `  kill -9 ${holder.pid}`]),
    "Emergency bypass: ASH_ALLOW_MULTI=1 (this can create duplicate schedulers for the same DB).",
  ];
  return lines.join("\n");
}

function isAlreadyExists(e: any) {
  return e?.code === "EEXIST";
}

function isNotFound(e: any) {
  return e?.code === "ENOENT";
}
