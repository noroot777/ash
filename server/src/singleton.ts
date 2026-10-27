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
import { liveMaintenanceHolderForAny, maintenanceLockFileFor } from "./maintenance-lock.js";
import { resourceKeysFor, withResourceClaim } from "./resource-claim.js";
import { RUNS_DIR } from "./paths.js";
import { IS_WINDOWS, isPidAlive, killPidsCommand } from "./platform.js";
import { inspectProcess as inspectProcessInfo, type ProcessInfo } from "./proc.js";
import {
  exitLedgerFileForDb,
  findExitByRunId,
  humanDuration,
  publicExitSummary,
  recordExit,
  rotateExitLedger,
  runIdOfToken,
  type ExitEvidence,
  type ExitRecord,
  type ObservedIntent,
  type PublicExitSummary,
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
 * 「上一轮的清理没完成」摔在用户脸上,而不是让他下次再从 /tmp 日志 + 系统日志里拼。
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
 *
 * `unknown` 这一档是第 2 轮审查加的:锁**读不出来**(EACCES、半行 JSON)时,原来一律
 * 归成 `not-ours` 然后肯定地说「已不属于本进程」—— 那是把一次读失败升格成身份事实。
 * 保守地不删是对的(删掉可能是别人的锁),肯定地下结论不对。
 */
export type LockReleaseOutcome =
  | { state: "removed" }
  | { state: "not-ours" }
  | { state: "unknown"; error: string }
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

/**
 * 这份库文件现在有没有**活着的** ash 实例在用。给离线维护脚本当安全闸用：历史回填会直接
 * 改 `sessions` 和 trace 文件，跟运行中的回合抢同一条线程的快照就会互相覆盖，所以那类
 * 脚本必须能在动手之前问一句「服务停了吗」，而不是只比对路径像不像生产库。
 *
 * 判据跟取锁时同一套 `staleLockReason`（pid 存活 + 命令形状 + 启动时刻一致），**不看
 * 心跳**：心跳停只说明事件循环被同步活儿堵住，不说明进程死了。
 *
 * 没有锁文件就返回 null —— 包括 `ASH_ALLOW_MULTI=1` 起的实例（它压根不写锁）。那种
 * 情况下这条闸给不出答案，调用方别把 null 读成「保证没人在用」。
 */
export function liveAshHolderForDb(dbFile = resolveAshDbFile()): {
  pid: number;
  startedAt: string | null;
  command: string | null;
} | null {
  const lockFile = singletonLockFileForDb(dbFile);
  if (!existsSync(lockFile)) return null;
  if (staleLockReason(readLock(lockFile)) !== null) return null;
  return holderFromLock(lockFile);
}

export function acquireDbSingletonLock(options: { port?: number | null } = {}): SingletonLock | null {
  const dbFile = resolveAshDbFile();
  const lockFile = singletonLockFileForDb(dbFile);
  const port = options.port ?? null;

  ensureAshDbDir(dbFile);
  // 这套资源的全部键:库文件 + 它的 runs 目录。两个都要查 —— 迁移要改的 trace 文件在
  // runs 里，而别的库路径（副本、软链）可能落到同一份 runs 上，只按库名锁挡不住。
  const keys = resourceKeysFor(dbFile, RUNS_DIR);

  // 「查维护锁 + 落自己的锁」必须是一个原子动作:两边都「先查对方再建自己」的话，
  // 存在一串两边都通过检查的合法交错（第 1 轮审查 F2 实测复现），所以整段放进占有锁里。
  const ownLock = withResourceClaim(keys, `ash 启动 PID ${process.pid}`, () => {
    // 离线维护（历史回填那类脚本）正在改这份库和它的 trace 时不许起服务:两边各写一半同一条
    // CLI 线程的账，谁都不知道最后落下的是什么。它是独立的一把锁，判据只认 pid 存活 +
    // 启动时刻（见 maintenance-lock.ts），所以脚本被强杀之后不会把服务永久挡在外面。
    //
    // **这一关排在 ASH_ALLOW_MULTI 前面**:那个开关的语义是「允许多个 ash 并存」，不是
    // 「允许踩正在迁移的库」—— 放在它后面等于给迁移留了一个一句话就能绕开的后门。
    const maintenance = liveMaintenanceHolderForAny(keys);
    if (maintenance) {
      throw new SingletonConflictError(
        dbFile,
        maintenanceLockFileFor(maintenance.key),
        {
          pid: maintenance.holder.pid,
          startedAt: maintenance.holder.startedAt,
          port: null,
          command: maintenance.holder.note,
        },
        `database is being migrated by an offline maintenance process (resource ${maintenance.key})`,
      );
    }
    if (process.env.ASH_ALLOW_MULTI === "1") {
      console.warn(
        `[ash] WARNING: ASH_ALLOW_MULTI=1 set; skipping single-instance guard for DB ${dbFile}`,
      );
      return null;
    }
    return writeOwnLock(dbFile, lockFile, port);
  });
  if (!ownLock) return null;

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
  rotateExitLedger(dbFile);
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
      const current = readLockResult(lockFile);
      if ("error" in current) {
        // 文件已经没了 = 没有要删的东西,这一档可以确定。其它读失败只能说「不知道」:
        // 既不删(可能是别人的),也不声称身份已变。
        outcome = isNotFound(current.error)
          ? { state: "removed" }
          : { state: "unknown", error: errnoOf(current.error) };
        return outcome;
      }
      if (current.lock.pid !== lock.pid || current.lock.token !== lock.token) {
        // 锁已经不是自己的了(被人工删掉、或被别的实例接走):没有要删的东西,
        // 也不是失败 —— 但也不能说成「我释放了」。
        outcome = { state: "not-ours" };
        return outcome;
      }
      try {
        unlinkSync(lockFile);
        outcome = { state: "removed" };
      } catch (e) {
        if (isNotFound(e)) {
          outcome = { state: "removed" };
        } else {
          console.warn(`[ash] failed to release singleton lock ${lockFile}:`, e);
          outcome = { state: "failed", error: errnoOf(e) };
        }
      }
      return outcome;
    },
  };
}

function describeRelease(outcome: LockReleaseOutcome): string {
  if (outcome.state === "removed") return "单例锁已释放";
  if (outcome.state === "not-ours") return "单例锁已不属于本进程,未改动";
  if (outcome.state === "unknown") return `单例锁读不出来(${outcome.error}),没有动它 —— 现在它属于谁无从判断`;
  return `单例锁删除失败(${outcome.error}),它会留在原地 —— 下一个实例只会看到「这一轮留过退出意向、清理没完成」`;
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
 * **只报证据等级,不报死因**(第 2 轮审查)。锁还带着那一轮的 token,能确定的只有
 * 一件事:那一轮的**清理没完成**。至于为什么没完成、进程最终是怎么走的,分两档:
 *   * 账本里有这一轮的退出记录 ⇒ 它**进入过**退出流程。但那条记录写在删锁之前,
 *     审查实测过「记完账、释放锁的路上被 SIGKILL」—— 现场跟删锁失败一模一样。
 *     所以这一档只说「留过退出意向」,**不说「不是强杀」、不说「是正常停的」**。
 *   * 账本里没有 ⇒ 连意向都没留下。SIGKILL、内核击杀都在这一档,但「退出时连账本
 *     都没写进去」也在。
 * 两档的结论都落在「最终死因未知」上 —— 要定性只能靠外部证据(wait 状态、系统日志),
 * 进程自己写的任何标记都做不到,再加一条更晚的标记也一样(标记之后还有窗口)。
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
  const evidence: ExitEvidence = prior ? "exit_intent" : "none";
  const observedIntent: ObservedIntent | undefined = prior
    ? { kind: prior.kind, signal: prior.signal, code: prior.code, at: prior.at }
    : undefined;
  const record: ExitRecord = {
    at: new Date(now).toISOString(),
    pid,
    runId: runId ?? undefined,
    kind: "residual",
    // residual 只能算到最后一次心跳,所以这是**下界**,不是精确寿命。
    uptimeMs: heartbeatAtMs !== null && startedAtMs !== null ? heartbeatAtMs - startedAtMs : null,
    lastHeartbeatAt: lock?.heartbeatAt ?? null,
    silentMs: heartbeatAtMs !== null ? now - heartbeatAtMs : null,
    evidence,
    observedIntent,
    note: staleReason,
  };
  previousResidualRecord = record;
  recordExit(record, dbFile);
  const ledger = exitLedgerFileForDb(dbFile);
  if (prior) {
    const how = prior.kind === "signal" ? `收到 ${prior.signal ?? "信号"}` : `退出码 ${prior.code ?? "未知"}`;
    console.warn(
      `[ash] 上一实例(PID ${pid})留下了锁,账本里有它这一轮的退出意向(${how},${prior.at})`
        + ` ⇒ 它**进入过**退出流程,但那一轮的清理没完成。那条记录写在删锁之前,`
        + `所以「删锁失败(数据目录不可写)」和「记完账之后又被强杀」留下的是同一个现场`
        + ` —— 最终死因未知。账本:${ledger}`,
    );
    return;
  }
  const alive = record.lastHeartbeatAt
    ? `最后已知存活 ${record.lastHeartbeatAt}(之后静默 ${humanDuration(record.silentMs)},至少活了 ${humanDuration(record.uptimeMs)})`
    : "那把锁是旧版本写的、没有心跳字段,连最后存活时刻都给不出";
  console.warn(
    `[ash] 上一实例(PID ${pid})留下了锁,账本里**没有**它这一轮的任何记录 ⇒ 最终死因未知:`
      + `${alive}。可能是 SIGKILL / 内核击杀,也可能是退出时连账本都没写进去;`
      + `锁本身只能证明「那一轮的清理没完成」。账本:${ledger}`,
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
function readLockResult(lockFile: string): { lock: Partial<LockFile> } | { error: unknown } {
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

function errnoOf(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? String(e);
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
 * 记账在释放锁**之前**:新实例一拿到锁就会去回查这一轮的退出意向,先落账它才看得到。
 *
 * 这个顺序**不再承担账本的完整性** —— 那条不变量现在住在账本层(`rotateExitLedger`
 * 只改名、不重写),因为「所有写入都发生在持锁期间」这句话本来就不成立:启动失败
 * 那条路(`index.ts` 的 `exitAfterStartupFailure`)先松锁再 `process.exit`,退出钩子
 * 这条记录就是在没有锁的情况下追加的。第 2 轮审查用真实生产入口把那条竞态复现了,
 * 所以别再靠调整调用顺序来保账本。
 *
 * 释放结果不进账本:那是**释放之后**才知道的事,再补一条更晚的记录也证明不了终态
 * (标记之后还有窗口),它只进日志。
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
