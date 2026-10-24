// 验收前置命令的**进程**这一层：起它、看着它、收掉它。编排（什么时候该跑、跑完算什么）
// 在 accept-gate.ts，这里一个业务判断都没有。
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCEPT_GATE_LOG_MAX_BYTES, ACCEPT_GATE_TAIL_BYTES } from "@ash/shared/accept-gate";
import { augmentedEnv } from "./executors/spawn.js";
import { RUNS_DIR } from "./paths.js";
import { inspectProcessSync, isPidAlive, IS_MAC, userShellLaunch } from "./platform.js";
import { assertGateConfinementAvailable } from "./accept-gate-confinement.js";
import { MAC_GATE_ENV, macGateToken } from "./accept-gate-confinement-macos.js";
import { gateBootstrapEnvironment } from "./accept-gate-process-env.js";
import { authorizeGateLaunch, finishGateLaunch, GATE_BOOTSTRAP, gateAbortPath, gateConfinement,
  gateGoPath, gateLaunchOf, gateLaunchPath, migrateGateLaunch, prepareGateLaunch, readGateLaunch, registerGateLaunch } from "./accept-gate-launch.js";

/** SIGTERM 之后等多久补一刀。给它收尾的时间，但不无限等。 */
const KILL_GRACE_MS = 5_000;

/** SIGKILL 之后再确认多久。KILL 收不下，那就是真卡在内核里了（D 状态 / 没权限）。 */
const KILL_CONFIRM_MS = 3_000;

/** 确认循环的采样间隔。只在取消/超时这种一次性路径上跑，不在热路径。 */
const KILL_POLL_MS = 50;

/** 日志落在任务自己的 run 目录下，跟会话正文同一处，归档清理会把它一起带走。 */
export function acceptGateLogPath(taskId: string, runId: string): string {
  return join(RUNS_DIR, taskId, `accept-gate-${runId}.log`);
}

export type GateExit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * 起一条门禁命令。返回 pid 和它的**启动时间**（拿不到 pid 视为没起来，抛错）。
 *
 * 启动时间要跟着 pid 一起落盘：pid 单独一个数字说明不了身份，ash 重启之后它可能早被
 * 别的进程复用了（见 stopAcceptGate / isSameGateProcess）。读不出来就是 null。
 *
 * 输出**全部写文件**：十几分钟的测试输出走管道只会把它攒在 ash 的内存里，而用户真正
 * 要的是能从头翻的一份日志。stdin 给 /dev/null —— 门禁命令不该等人输入，等于挂死。
 */
export async function spawnAcceptGate(opts: {
  command: string;
  cwd: string;
  logPath: string;
  onExit: (exit: GateExit) => void;
  hold?: boolean;
}): Promise<{ pid: number; startedAt: string | null; authorize: () => Promise<boolean> }> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  if (!existsSync(gateLaunchPath(opts.logPath))) prepareGateLaunch(opts.logPath);
  assertGateConfinementAvailable();
  const fd = openSync(opts.logPath, "a");
  try {
    const launch = userShellLaunch(opts.command);
    const environment = gateBootstrapEnvironment(augmentedEnv());
    if (IS_MAC) environment.bootstrap[MAC_GATE_ENV] = macGateToken(opts.logPath);
    const config = Buffer.from(JSON.stringify({ ...launch, cwd: opts.cwd,
      restoreEnv: environment.restore,
      go: gateGoPath(opts.logPath), abort: gateAbortPath(opts.logPath) })).toString("base64");
    const child = spawn(process.execPath, ["-e", GATE_BOOTSTRAP, config], {
      cwd: dirname(opts.logPath),
      env: environment.bootstrap,
      stdio: ["ignore", fd, fd],
      detached: true,
      windowsHide: true,
    });
    child.once("error", (error) => {
      // spawn 失败（shell 不存在之类）：当作一次没跑成的结束，别让调用方永远等。
      appendGateLog(opts.logPath, `\n[ash] 门禁命令起不来：${error instanceof Error ? error.message : String(error)}\n`);
      opts.onExit({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => opts.onExit({ code, signal }));
    // ash 自己的事件循环不该被它吊着不退（退出时的收尾由 stopAcceptGate 负责）。
    child.unref();
    const pid = child.pid;
    if (!pid) throw new Error("门禁命令没有拿到 pid");
    const startedAt = inspectProcessSync(pid)?.startedAt ?? null;
    registerGateLaunch(opts.logPath, pid, startedAt);
    const authorize = () => authorizeGateLaunch(opts.logPath);
    if (!opts.hold) {
      try { await authorize(); }
      catch (error) {
        writeFileSync(gateAbortPath(opts.logPath), "abort");
        throw error;
      }
    }
    return { pid, startedAt, authorize };
  } finally {
    // 句柄已经交给子进程了，父进程这边留着只会在日志被删后仍占着 inode。
    closeSync(fd);
  }
}

/**
 * 这个 pid 还是不是当初起的那条命令。
 *
 * 核对的是**启动时间**：pid 会被复用，而跨重启收残留时那个号多半已经是别人的了。
 * 拿不到身份（旧记录没落过、平台读不出来）一律算「不是」—— 盲发信号打到的是无辜进程。
 */
export function isSameGateProcess(pid: number | null | undefined, startedAt: string | null | undefined): boolean {
  if (!pid || !startedAt) return false;
  return inspectProcessSync(pid)?.startedAt === startedAt;
}

export async function stopAcceptGate(
  _taskId: string,
  pid: number | null | undefined,
  startedAt?: string | null,
  logPath?: string,
): Promise<boolean> {
  logPath = gateLaunchOf(pid, logPath);
  const persisted = readGateLaunch(logPath);
  if (!persisted || !logPath) return false;
  const launch = migrateGateLaunch(logPath, persisted);
  writeFileSync(gateAbortPath(logPath), "abort");
  if (launch.phase === "stopped" && launch.stoppedEvidence) return !gateTreeAlive(pid ?? 0, startedAt, logPath);
  if (launch.phase === "prepared" && !existsSync(gateGoPath(logPath))) {
    if (launch.pid && isPidAlive(launch.pid)) {
      const identity = inspectProcessSync(launch.pid);
      if (!launch.startedAt || !identity?.startedAt) return false;
      if (identity.startedAt === launch.startedAt) {
        const deadline = Date.now() + KILL_CONFIRM_MS;
        while (isPidAlive(launch.pid)) {
          const current = inspectProcessSync(launch.pid);
          if (current?.startedAt && current.startedAt !== launch.startedAt) break;
          if (Date.now() >= deadline) return false;
          await new Promise(resolve => setTimeout(resolve, KILL_POLL_MS));
        }
      }
    }
    finishGateLaunch(logPath, "never-authorized");
    return true;
  }
  if (!launch.confinementEnrolled) {
    appendGateLog(logPath, "\n[ash] 缺少整次运行的内核归属凭据；PID/进程组消失不能证明 detached 后代退出，保留工作区占用。\n");
    return false;
  }
  const confinement = gateConfinement(logPath, launch);
  if (!confinement) return false;
  try { await confinement.prepare?.(); } catch { return false; }
  const empty = (): boolean => {
    const reading = confinement.read();
    return reading.kind === "members" && reading.members.length === 0;
  };
  if (!empty()) {
    confinement.killAll("SIGTERM");
    if (!await untilEmpty(empty, KILL_GRACE_MS)) {
      confinement.killAll("SIGKILL");
      if (!await untilEmpty(empty, KILL_CONFIRM_MS)) return false;
    }
  }
  finishGateLaunch(logPath, launch.confinementId?.startsWith("macos-observed:") ? "observed-empty" : "kernel-empty");
  return true;
}

export function gateTreeAlive(pid: number, _startedAt?: string | null, logPath?: string): boolean {
  logPath = gateLaunchOf(pid, logPath);
  const launch = readGateLaunch(logPath);
  if (launch?.phase === "stopped") {
    if (launch.stoppedEvidence === "never-authorized" && logPath && !existsSync(gateGoPath(logPath))) return false;
    if (launch.stoppedEvidence === "kernel-empty" && launch.confinementEnrolled) return false;
    if (launch.stoppedEvidence === "observed-empty" && launch.confinementEnrolled
      && launch.confinementId?.startsWith("macos-observed:")) return false;
  }
  if (!launch?.confinementEnrolled || !logPath) return true;
  const reading = gateConfinement(logPath, launch)?.read();
  return reading?.kind !== "members" || reading.members.length > 0;
}

async function untilEmpty(empty: () => boolean, within: number): Promise<boolean> {
  const deadline = Date.now() + within;
  for (;;) {
    if (empty()) return true;
    if (Date.now() >= deadline) return false;
    // **不 unref**：调用方正在 await 这一句，unref 掉的话 Node 会认为没有待办事项、
    // 进程直接退出（回归里的表现是「top-level await 没有 settle」）。这段最长 8 秒，
    // 而它换来的是「取消返回时它真的没了」这个保证。
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
  }
}

export function appendGateLog(logPath: string, text: string): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, text, "utf8");
  } catch { /* 日志写不进去不该让门禁本身失败 */ }
}

/**
 * 日志末尾若干字节。整份日志可能有几十 MB（全量回归的输出），**只读尾巴**：
 * 一次验收检查要回这份数据，整份读进内存会把 ash 顶爆。
 */
export function acceptGateLogTail(logPath: string, bytes = ACCEPT_GATE_TAIL_BYTES): string {
  return readTail(logPath, bytes).text;
}

/**
 * 「看完整日志」那一份。**仍然有上限**：这一头整份读进内存、那一头整份塞进一个 `<pre>`，
 * 几十 MB 的回归输出会把两边都拖垮，而用户要看的永远是尾巴。截了就在开头说破。
 */
export function acceptGateLogText(logPath: string): string {
  const { text, skipped } = readTail(logPath, ACCEPT_GATE_LOG_MAX_BYTES);
  if (!skipped) return text;
  return `[ash] 这份日志有 ${Math.round((skipped + Buffer.byteLength(text)) / 1_000_000 * 10) / 10} MB，这里只给最后 `
    + `${Math.round(ACCEPT_GATE_LOG_MAX_BYTES / 1000)} KB。完整文件在 ${logPath}\n\n${text}`;
}

/** 日志尾部若干字节。`skipped` = 前面被略过了多少，0 表示这就是全文。 */
function readTail(logPath: string, bytes: number): { text: string; skipped: number } {
  try {
    if (!existsSync(logPath)) return { text: "", skipped: 0 };
    const size = statSync(logPath).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let offset = 0;
      if (start > 0) {
        const newline = buf.indexOf(10);
        if (newline >= 0) offset = newline + 1;
        else while (offset < buf.length && (buf[offset] & 0xc0) === 0x80) offset++;
      }
      const text = buf.subarray(offset).toString("utf8");
      // 从中间切进去的那一行多半是半截，掐掉它比留着一段乱码强。
      return { text, skipped: start + offset };
    } finally { closeSync(fd); }
  } catch { return { text: "", skipped: 0 }; }
}
