import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolveAshDbFile, ensureAshDbDir } from "./db/path.js";
import { IS_WINDOWS, isPidAlive, killPidsCommand } from "./platform.js";
import { inspectProcess as inspectProcessInfo, type ProcessInfo } from "./proc.js";
import {
  exitLedgerFileForDb,
  findExitByRunId,
  humanDuration,
  publicExitSummary,
  recordExit,
  runIdOfToken,
  trimExitLedger,
  type ExitRecord,
  type PublicExitSummary,
  type ResidualDiagnosis,
} from "./exit-ledger.js";

const LOCK_VERSION = 1;
const LOCK_SUFFIX = ".ash.lock";
const START_TIME_TOLERANCE_MS = 10_000;
/**
 * 心跳周期:锁文件每这么久被原子换一次(临时文件 + rename)。
 *
 * 它给的是「死亡时刻」的分辨率,**不是存活判据** —— 事件循环被同步活儿堵住时心跳也会
 * 停,拿它判陈旧就会把一个还活着的 server 判死、然后双实例跑同一份库。存活判据始终是
 * pid + 进程启动时间 + 命令形状那三条(见 staleLockReason)。
 */
const HEARTBEAT_MS = 10_000;

/** 本进程拿到锁时写进去的 token（见 liveLockToken）。没拿到锁就一直是 null。 */
let ownLockToken: string | null = null;

/**
 * 启动时发现的「上一轮的锁还留在原地」这件事,算一次。
 *
 * 要让人看得见才有用:/api/health 带上它,`npm run restart` 在确认就绪那一步就能把
 * 「上次不是正常停的」摔在用户脸上,而不是让他下次再从 /tmp 日志 + 系统日志里拼。
 *
 * **只导出白名单投影**(`previousResidualLockPublic`),不导出这条全量记录:它的
 * `note` 可能含别的进程的完整命令行(PID 复用时),而健康端点是免登录的。想让公开
 * 响应多带一个字段,就去 `publicExitSummary` 里显式加 —— 那一步是故意设成手工的。
 */
let previousResidualRecord: ExitRecord | null = null;

export function previousResidualLockPublic(): PublicExitSummary | null {
  return publicExitSummary(previousResidualRecord);
}

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
  /** 最近一次心跳(见 HEARTBEAT_MS)。旧版本写的锁没有这两个字段。 */
  heartbeatAt?: string;
  heartbeatAtMs?: number;
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

/**
 * 释放锁的真实结果。
 *
 * 以前 `release()` 是 `void`、失败只 `console.warn` 一句,于是信号退出那条路**无条件**
 * 打印「单例锁已释放」—— 第 1 轮审查把数据目录改成只读复现出来:删锁 EACCES、日志
 * 照说已释放、锁留在原地,下一个实例再把这次认成强杀。谁都没说谎,但三处拼起来是
 * 一个假结论。所以这里改成返回值,调用方按实际情况说话。
 */
export type LockReleaseOutcome =
  | { state: "removed" }
  | { state: "not-ours" }
  | { state: "failed"; error: string };

export type SingletonLock = {
  dbFile: string;
  lockFile: string;
  release: () => LockReleaseOutcome;
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
  trimExitLedger(dbFile);
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
    // 开局就把心跳设成取锁时刻:否则头一个心跳周期内死掉的实例在下次启动时会被报成
    // 「旧版本写的锁、给不出死亡时刻」—— 那是另一种病因,不能混。
    heartbeatAt: new Date().toISOString(),
    heartbeatAtMs: Date.now(),
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
      const existing = readLock(lockFile);
      const staleReason = staleLockReason(existing);
      if (!staleReason) {
        const holder = holderFromLock(lockFile);
        throw new SingletonConflictError(dbFile, lockFile, holder);
      }
      console.warn(`[ash] stale singleton lock at ${lockFile}: ${staleReason}; overwriting`);
      // 锁还在只说明「发现残留」,死因要回查账本才能定 —— 别只打一句 overwriting
      // 就扔掉,也别直接升格成强杀。
      reportResidualLock(dbFile, existing, staleReason);
      try {
        unlinkSync(lockFile);
      } catch (unlinkError) {
        if (!isNotFound(unlinkError)) throw unlinkError;
      }
    }
  }

  const heartbeat = setInterval(() => beat(lockFile, lock), HEARTBEAT_MS);
  // unref:心跳是旁路观测,绝不能成为「进程该不该退出」的理由。
  heartbeat.unref();

  let outcome: LockReleaseOutcome | null = null;
  return {
    dbFile,
    lockFile,
    release: () => {
      if (outcome) return outcome;
      clearInterval(heartbeat);
      try {
        const current = readLock(lockFile);
        if (current?.pid === lock.pid && current.token === lock.token) {
          unlinkSync(lockFile);
          outcome = { state: "removed" };
        } else {
          // 锁已经不是自己的了(被人工删掉、或被别的实例接走):没有要删的东西,
          // 也不是失败 —— 但也不能说成「我释放了」。
          outcome = { state: "not-ours" };
        }
      } catch (e) {
        if (isNotFound(e)) {
          outcome = { state: "removed" };
        } else {
          const error = (e as NodeJS.ErrnoException)?.code ?? String(e);
          console.warn(`[ash] failed to release singleton lock ${lockFile}:`, e);
          outcome = { state: "failed", error };
        }
      }
      return outcome;
    },
  };
}

function describeRelease(outcome: LockReleaseOutcome): string {
  if (outcome.state === "removed") return "单例锁已释放";
  if (outcome.state === "not-ours") return "单例锁已不属于本进程,未改动";
  return `单例锁删除失败(${outcome.error}),它会留在原地 —— 下一个实例会按账本把这次认成「退出已记录、清理失败」`;
}

/**
 * 刷一次心跳。
 *
 * 必须**原子换**(临时文件 + rename):这把锁同时被另一个启动流程和 scripts/restart.mjs
 * 读,就地改写会让读到半行的那一方 JSON 解析失败,进而把「不可读」当成陈旧锁覆盖掉 ——
 * 代价是两个 server 调度同一份库。rename 前再认一次 pid+token,是为了别把一把已经被
 * 人工删掉、或已被别的实例接走的锁又写回来。
 */
function beat(lockFile: string, lock: LockFile): void {
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

/**
 * 发现上一轮的锁还在:落账 + 打在终端上。
 *
 * **判据是账本,不是锁**。锁留在原地有两种完全不同的来由:
 *   * 账本里有这一轮的退出记录 ⇒ 它**走过**退出路径,只是删锁失败(数据目录只读
 *     就会 EACCES)。这不是强杀,说成强杀是假结论。
 *   * 账本里没有 ⇒ 死因未知。SIGKILL、内核击杀都在这一档里,但「退出时连账本都
 *     没写进去」也在 —— 所以只报 unknown,不点名 SIGKILL。
 *
 * 顺带一条:`staleReason` 里可能带别的进程的完整命令行(PID 复用那一支),它只进
 * `note`(账本 0600),不进公开响应。
 */
function reportResidualLock(dbFile: string, lock: Partial<LockFile> | null, staleReason: string): void {
  const pid = typeof lock?.pid === "number" && Number.isInteger(lock.pid) ? lock.pid : -1;
  if (pid <= 1) return; // 连是谁都读不出来,就别编一个死因
  const now = Date.now();
  const heartbeatAtMs = typeof lock?.heartbeatAtMs === "number" ? lock.heartbeatAtMs : null;
  const startedAtMs = typeof lock?.processStartedAtMs === "number" ? lock.processStartedAtMs : null;
  const runId = typeof lock?.token === "string" && lock.token ? runIdOfToken(lock.token) : null;
  const prior = runId ? findExitByRunId(runId, dbFile) : null;
  const diagnosis: ResidualDiagnosis = prior ? "cleanup_failed" : "unknown";
  const record: ExitRecord = {
    at: new Date(now).toISOString(),
    pid,
    runId: runId ?? undefined,
    kind: "residual",
    // residual 只能算到最后一次心跳,所以这是**下界**,不是精确寿命。
    uptimeMs: heartbeatAtMs !== null && startedAtMs !== null ? heartbeatAtMs - startedAtMs : null,
    lastHeartbeatAt: lock?.heartbeatAt ?? null,
    silentMs: heartbeatAtMs !== null ? now - heartbeatAtMs : null,
    diagnosis,
    note: staleReason,
  };
  previousResidualRecord = record;
  recordExit(record, dbFile);
  const ledger = exitLedgerFileForDb(dbFile);
  if (prior) {
    const how = prior.kind === "signal" ? `收到 ${prior.signal ?? "信号"}` : `退出码 ${prior.code ?? "未知"}`;
    console.warn(
      `[ash] 上一实例(PID ${pid})留下了锁,但账本里有它这一轮的退出记录(${how},${prior.at})`
        + ` ⇒ 它**走过**退出路径,只是没能把锁删掉(多半是数据目录不可写)。不是强杀。账本:${ledger}`,
    );
    return;
  }
  const alive = record.lastHeartbeatAt
    ? `最后已知存活 ${record.lastHeartbeatAt}(之后静默 ${humanDuration(record.silentMs)},至少活了 ${humanDuration(record.uptimeMs)})`
    : "那把锁是旧版本写的、没有心跳字段,连最后存活时刻都给不出";
  console.warn(
    `[ash] 上一实例(PID ${pid})留下了锁,账本里**没有**它这一轮的退出记录 ⇒ 死因未知:`
      + `${alive}。可能是 SIGKILL / 内核击杀,也可能是退出时连账本都没写进去;`
      + `锁本身只能证明「没留下已确认的退出记录」。账本:${ledger}`,
  );
}

function staleLockReason(lock: Partial<LockFile> | null): string | null {
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
//   POSIX:   /opt/homebrew/bin/node /Users/example/code/ash/server/dist/index.js
//   Windows: "C:\Program Files\nodejs\node.exe" C:\Users\example\ash\server\dist\index.js
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
//
// POSIX 这边 2026-10-19 补上了 SIGHUP 和 SIGQUIT:在那之前它们**没有任何处理器**,
// 默认动作是静默终止 —— 不打印、不写崩溃报告、不释放锁,跟被 SIGKILL 带走长得一模一样。
// 排查「ash 服务又停了」时正是这件事让「谁杀的」变成无解:能分辨的死因越多,下一次
// 要猜的就越少。SIGQUIT 被接住之后不再产 core,这台机器上 `core` rlimit 本来就是 0,
// 没有损失。
const EXIT_SIGNALS = (IS_WINDOWS
  ? ["SIGINT", "SIGBREAK", "SIGHUP"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) as readonly NodeJS.Signals[];

/** 128 + 信号号:退出码本身也是一条「上次是怎么停的」线索,别一律压成 143。 */
const SIGNAL_EXIT_CODE: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
  SIGBREAK: 149,
};

/**
 * 记账和释放锁的**顺序是有讲究的:先落账,再释放**。
 *
 * 反过来写(原来就是)会开一个跨实例的写入竞态:旧实例一松锁,新实例立刻就能取到锁
 * 并开始裁剪账本,而旧实例那条退出记录还没写进去 —— 整文件重写会把它盖掉。先落账
 * 就等于「账本只在持锁期间被动」,竞态自然没了。
 *
 * 代价是日志里那句「锁怎么样了」要等释放之后才知道,所以释放结果不进账本:下一个
 * 实例要的是「这一轮有没有退出记录」,有记录 + 锁还在就足以推出「清理失败」。
 */
function installCleanup(lock: SingletonLock) {
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  const runId = runIdOfToken(ownLockToken ?? "");
  let recorded = false;
  const note = (record: ExitRecord) => {
    if (recorded) return; // 信号路径已经记过,后面那次 exit 不要再记第二条
    recorded = true;
    recordExit(record, lock.dbFile);
  };
  process.once("exit", (code) => {
    note({
      at: new Date().toISOString(),
      pid: process.pid,
      runId,
      kind: "exit",
      code,
      uptimeMs: Date.now() - startedAtMs,
    });
    lock.release();
  });
  for (const signal of EXIT_SIGNALS) {
    process.once(signal, () => {
      const uptimeMs = Date.now() - startedAtMs;
      note({ at: new Date().toISOString(), pid: process.pid, runId, kind: "signal", signal, uptimeMs });
      const outcome = lock.release();
      // 收到 SIGTERM 曾经是**完全静默**地退出(`npm run restart` 走的就是这条),于是
      // 日志里「上一次为什么停」永远少一行。现在至少能把「有人让它停」和「它自己没了」
      // 分开,而且锁到底有没有删掉也如实说 —— 说错了会让下一个实例得出假结论。
      console.warn(`[ash] 收到 ${signal}，退出（运行 ${humanDuration(uptimeMs)}，${describeRelease(outcome)}）`);
      process.exit(SIGNAL_EXIT_CODE[signal] ?? 143);
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
