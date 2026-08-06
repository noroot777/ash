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
import { resolveHarnessDbFile, ensureHarnessDbDir } from "./db/path.js";
import { inspectProcess as inspectProcessInfo, type ProcessInfo } from "./proc.js";

const LOCK_VERSION = 1;
const LOCK_SUFFIX = ".harness.lock";
const START_TIME_TOLERANCE_MS = 10_000;

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
    reason = "database is already owned by another live harness server",
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

export function singletonLockFileForDb(dbFile = resolveHarnessDbFile()) {
  return `${dbFile}${LOCK_SUFFIX}`;
}

export function acquireDbSingletonLock(options: { port?: number | null } = {}): SingletonLock | null {
  const dbFile = resolveHarnessDbFile();
  const lockFile = singletonLockFileForDb(dbFile);
  const port = options.port ?? null;

  if (process.env.HARNESS_ALLOW_MULTI === "1") {
    console.warn(
      `[harness] WARNING: HARNESS_ALLOW_MULTI=1 set; skipping single-instance guard for DB ${dbFile}`,
    );
    return null;
  }

  ensureHarnessDbDir(dbFile);
  const ownLock = writeOwnLock(dbFile, lockFile, port);

  try {
    const holders = findLiveHarnessDbHolders(dbFile).filter((p) => p.pid !== process.pid);
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
        "database is already open in another live harness process",
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
      console.warn(`[harness] stale singleton lock at ${lockFile}: ${staleReason}; overwriting`);
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
        if (!isNotFound(e)) console.warn(`[harness] failed to release singleton lock ${lockFile}:`, e);
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
  if (!isHarnessServerCommand(info.command)) {
    return `PID ${pid} is not a harness server process (${info.command ?? "unknown command"})`;
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

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function inspectProcess(pid: number): ProcessInfo | null {
  return inspectProcessInfo(pid);
}

function findLiveHarnessDbHolders(dbFile: string): ProcessInfo[] {
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
    .filter((info): info is ProcessInfo => Boolean(info && isHarnessServerCommand(info.command)));
}

function isHarnessServerCommand(command: string | null) {
  if (!command) return false;
  return (
    /(?:^|\s)(?:\S*\/)?(?:node|tsx)(?:\s|$)/.test(command) &&
    /(?:server\/)?(?:dist|src)\/index\.(?:js|ts)\b/.test(command)
  );
}

function installCleanup(lock: SingletonLock) {
  process.once("exit", lock.release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
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
    `[harness] Refusing to start: ${reason}.`,
    `  DB: ${dbFile}`,
    `  Lock: ${lockFile}`,
    `  PID: ${holder.pid}`,
    `  Started: ${holder.startedAt ?? "unknown"}`,
    `  Port: ${holder.port ?? "unknown"}`,
    `  Command: ${holder.command ?? "unknown"}`,
    "Stop the existing harness server first, then retry:",
    `  kill ${holder.pid}`,
    "If it does not exit, use:",
    `  kill -9 ${holder.pid}`,
    "Emergency bypass: HARNESS_ALLOW_MULTI=1 (this can create duplicate schedulers for the same DB).",
  ];
  return lines.join("\n");
}

function isAlreadyExists(e: any) {
  return e?.code === "EEXIST";
}

function isNotFound(e: any) {
  return e?.code === "ENOENT";
}
