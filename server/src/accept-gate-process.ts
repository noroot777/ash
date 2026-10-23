// 验收前置命令的**进程**这一层：起它、看着它、收掉它。编排（什么时候该跑、跑完算什么）
// 在 accept-gate.ts，这里一个业务判断都没有。
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCEPT_GATE_LOG_MAX_BYTES, ACCEPT_GATE_TAIL_BYTES } from "@ash/shared/accept-gate";
import { augmentedEnv } from "./executors/spawn.js";
import { RUNS_DIR } from "./paths.js";
import { IS_WINDOWS, inspectProcessSync, isPidAlive, isProcessGroupAlive, killTree, userShellLaunch } from "./platform.js";
import { authorizeGateLaunch, finishGateLaunch, GATE_BOOTSTRAP, gateAbortPath, gateConfinement,
  gateGoPath, gateLaunchOf, gateLaunchPath, prepareGateLaunch, readGateLaunch, registerGateLaunch } from "./accept-gate-launch.js";

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
export function spawnAcceptGate(opts: {
  command: string;
  cwd: string;
  logPath: string;
  onExit: (exit: GateExit) => void;
  hold?: boolean;
}): { pid: number; startedAt: string | null; authorize: () => boolean } {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  if (!existsSync(gateLaunchPath(opts.logPath))) prepareGateLaunch(opts.logPath);
  const fd = openSync(opts.logPath, "a");
  try {
    const launch = userShellLaunch(opts.command);
    const config = Buffer.from(JSON.stringify({ ...launch, cwd: opts.cwd,
      go: gateGoPath(opts.logPath), abort: gateAbortPath(opts.logPath) })).toString("base64");
    const child = spawn(process.execPath, ["-e", GATE_BOOTSTRAP, config], {
      cwd: dirname(opts.logPath),
      env: augmentedEnv(),
      stdio: ["ignore", fd, fd],
      detached: !IS_WINDOWS,
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
    if (!opts.hold) authorize();
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

/**
 * 取消/超时的那一刀：先 SIGTERM，宽限期之后还活着再 SIGKILL，**并一直等到确认它没了**。
 *
 * ── 为什么必须等（第 1 轮审查 F2 实测）────────────────────────────────────────
 * 从前这里是「TERM 之后挂一个 5 秒的闹钟就返回」，于是：
 *   ① 调用方拿到的返回值不是「它停了」的证明，而只是「刀发出去了」。取消那一下随即落
 *      canceled、释放占用、允许清理，而那条忽略 TERM 的测试脚本还在往一个马上要被删掉的
 *      工作区里写文件（实测 leaderAlive:false、childAliveAfterGrace:true）。
 *   ② 那个闹钟里又拿**父进程**的启动时间核身份，而父进程恰恰已经被 TERM 收走了 ——
 *      核不过就提前 return，底下那句进程组 SIGKILL 一次都没执行过。所以它不是「再等久一点
 *      就好」：补刀分支被逻辑跳过了。
 * 现在：身份只在**进场**时核一次（那一刻父进程还在，核得准），之后认的是**进程组**
 * ——后代是不是还在，只有组答得出来，而父进程的号已经不能代表它们了。
 *
 * 返回 true = 确认整棵树都没了；false = 到这一刻
 * 还有活口，**调用方必须如实上报、并继续把工作区当占着**，不能宣告已经收干净。
 */
export async function stopAcceptGate(
  _taskId: string,
  pid: number | null | undefined,
  startedAt?: string | null,
  logPath?: string,
): Promise<boolean> {
  logPath = gateLaunchOf(pid, logPath);
  const launch = readGateLaunch(logPath);
  if (launch && logPath) {
    writeFileSync(gateAbortPath(logPath), "abort");
    if (launch.phase === "stopped") { finishGateLaunch(logPath); return true; }
    if (launch.phase === "prepared") {
      if (launch.pid && isSameGateProcess(launch.pid, launch.startedAt)) {
        killTree(launch.pid, "SIGKILL");
        if (!IS_WINDOWS && !await untilGone(launch.pid, launch.startedAt, KILL_CONFIRM_MS)) return false;
      }
      finishGateLaunch(logPath);
      return true;
    }
    pid ??= launch.pid;
    startedAt ??= launch.startedAt;
    if (IS_WINDOWS) {
      const confinement = gateConfinement(logPath, launch);
      if (!confinement) return false;
      const before = confinement.read();
      if (before.kind !== "members") return false;
      if (before.members.length) confinement.killAll("SIGKILL");
      const deadline = Date.now() + KILL_CONFIRM_MS;
      for (;;) {
        const after = confinement.read();
        if (after.kind === "members" && !after.members.length) break;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, KILL_POLL_MS));
      }
      finishGateLaunch(logPath);
      return true;
    }
  }
  if (!pid || IS_WINDOWS) return false;
  if (!gateTreeAlive(pid, startedAt, logPath)) {
    if (logPath) finishGateLaunch(logPath);
    return true;
  }
  const leader = inspectProcessSync(pid);
  if (!startedAt || (isPidAlive(pid) && !leader?.startedAt) || (leader && leader.startedAt !== startedAt)) {
    return false;
  }
  killTree(pid, "SIGTERM");
  if (await untilGone(pid, startedAt, KILL_GRACE_MS)) {
    if (logPath) finishGateLaunch(logPath);
    return true;
  }
  killTree(pid, "SIGKILL");
  if (await untilGone(pid, startedAt, KILL_CONFIRM_MS)) {
    if (logPath) finishGateLaunch(logPath);
    return true;
  }
  return false;
}

export function gateTreeAlive(pid: number, startedAt?: string | null, logPath?: string): boolean {
  logPath = gateLaunchOf(pid, logPath);
  const launch = readGateLaunch(logPath);
  if (launch?.phase === "stopped") return false;
  if (IS_WINDOWS) {
    const reading = launch && logPath ? gateConfinement(logPath, launch)?.read() : null;
    return reading?.kind !== "members" || reading.members.length > 0;
  }
  // 组还在 = 后代还在。父进程先退、`trap '' TERM` 的子进程接着跑，就是这一档。
  if (isProcessGroupAlive(pid)) return true;
  // 领头那个自己：号被别人复用了不算我们的（别把无辜进程算成「还没停掉」）。
  if (!isPidAlive(pid)) return false;
  const leader = inspectProcessSync(pid);
  return !startedAt || !leader?.startedAt || leader.startedAt === startedAt;
}

async function untilGone(pid: number, startedAt: string | null | undefined, within: number): Promise<boolean> {
  const deadline = Date.now() + within;
  for (;;) {
    if (!gateTreeAlive(pid, startedAt)) return true;
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
