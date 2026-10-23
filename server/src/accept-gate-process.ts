// 验收前置命令的**进程**这一层：起它、看着它、收掉它。编排（什么时候该跑、跑完算什么）
// 在 accept-gate.ts，这里一个业务判断都没有。
//
// ── 为什么不做成「ash 死了它还活着」（哨兵那一套）────────────────────────────────
// 哨兵要脱离 ash 是因为它天生跨回合、跨重启（盯一夜的构建）。门禁不是：它是用户**刚刚
// 点下验收、正等着结果**的一次动作，寿命以十几分钟计。做成脱离进程，就得为它补上一整套
// 跨重启认领（退出码写文件、按代次认 pid、半截日志接着读），而换来的收益只有「ash 恰好
// 在这十几分钟里重启」这一种情形。
//
// 所以这里选的是另一半：**ash 重启后把上一轮的残留收掉，并如实把那次标成「被打断」**。
// 用户看到的是「上次没跑完，重点一次」，而不是一个永远停在「正在跑」的幽灵——后者才是
// 真正的坑（见根 AGENTS.md「停止/暂停必须留下持久可见的状态」）。pid 因此必须落盘：
// 没有它，重启后那条还在跑的测试命令就彻底没人管了。
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCEPT_GATE_TAIL_BYTES } from "@ash/shared/accept-gate";
import { augmentedEnv } from "./executors/spawn.js";
import { RUNS_DIR } from "./paths.js";
import { IS_WINDOWS, killTree, userShellLaunch } from "./platform.js";

/** 日志落在任务自己的 run 目录下，跟会话正文同一处，归档清理会把它一起带走。 */
export function acceptGateLogPath(taskId: string, runId: string): string {
  return join(RUNS_DIR, taskId, `accept-gate-${runId}.log`);
}

export type GateExit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * 起一条门禁命令。返回 pid（拿不到 pid 视为没起来，抛错）。
 *
 * 输出**全部写文件**：十几分钟的测试输出走管道只会把它攒在 ash 的内存里，而用户真正
 * 要的是能从头翻的一份日志。stdin 给 /dev/null —— 门禁命令不该等人输入，等于挂死。
 */
export function spawnAcceptGate(opts: {
  command: string;
  cwd: string;
  logPath: string;
  onExit: (exit: GateExit) => void;
}): number {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, "a");
  try {
    const launch = userShellLaunch(opts.command);
    const child = spawn(launch.file, launch.args, {
      cwd: opts.cwd,
      env: augmentedEnv(),
      stdio: ["ignore", fd, fd],
      // POSIX 上自成进程组，取消/超时那一刀才打得到整棵树（killTree 发的是 -pid）。
      // Windows 侧由 taskkill /T 负责，detached 在那边只会多开一个控制台窗口。
      detached: !IS_WINDOWS,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
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
    return pid;
  } finally {
    // 句柄已经交给子进程了，父进程这边留着只会在日志被删后仍占着 inode。
    closeSync(fd);
  }
}

/** 取消/超时的那一刀。pid 不在了是正常情况（命令已经自己退了），不报错。 */
export function stopAcceptGate(pid: number | null | undefined): void {
  if (!pid) return;
  killTree(pid, "SIGTERM");
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
  try {
    if (!existsSync(logPath)) return "";
    const size = statSync(logPath).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      // 从中间切进去的那一行多半是半截，掐掉它比留着一段乱码强。
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally { closeSync(fd); }
  } catch { return ""; }
}

/** 整份日志（下载/排查用）。调用方自己决定给不给，这里只负责读得到。 */
export function acceptGateLogText(logPath: string): string {
  try { return readFileSync(logPath, "utf8"); } catch { return ""; }
}
