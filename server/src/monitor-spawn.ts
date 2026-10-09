// 哨兵的**进程**这一层：怎么把一条用户命令起成「ash 死了它也还活着」的长跑进程，
// 以及怎么跟着它的输出文件按行往下读。编排（什么时候推、推给谁、什么时候停）在
// monitors.ts，这里一个业务判断都没有。
//
// 脱离 ash 靠两件事，缺一不可（跟 executors/detached.ts 是同一招，理由见那里的文件头）：
//   ① `detached: true` —— POSIX 上 setsid 自成会话/进程组，ash 退出时的那串信号打不到它
//   ② **输出写文件、不给它任何管道** —— 唯一真正的生死绑定是 stdout 匿名管道：ash 一死
//      读端关闭，它下次往 stdout 写就吃 SIGPIPE 当场毙命。换成文件这条绑定就断了。
// 再加一个 `unref()`，ash 自己的事件循环也不会被它吊着不退。
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentBaseEnv } from "./executors/spawn.js";
import { userShellLaunch } from "./platform.js";
import { RUNS_DIR } from "./paths.js";

/** 输出落在任务自己的 run 目录下，跟会话正文、trace 同一处，归档清理不必另记一份路径。 */
export function monitorLogPath(taskId: string, monitorId: string): string {
  return join(RUNS_DIR, taskId, `monitor-${monitorId}.log`);
}

export type SpawnedMonitor = {
  pid: number;
  /** 命令自己跑完时回调一次（仅限本进程起的那次；跨 server 重启接回来的拿不到）。 */
  onExit: (cb: (code: number | null) => void) => void;
};

export function spawnMonitor(opts: { command: string; cwd: string; logPath: string }): SpawnedMonitor | { error: string } {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(opts.logPath, "a");
  } catch (e) {
    return { error: `建不了哨兵日志文件 ${opts.logPath}：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const launch = userShellLaunch(opts.command);
    // stdin 给 ignore 而不是继承：哨兵命令不该有机会去读 ash 的标准输入。
    // stdout/stderr 都指向同一个 fd —— 合流是刻意的，命令自己报的错也该成为事件。
    const child = spawn(launch.file, launch.args, {
      cwd: opts.cwd,
      env: agentBaseEnv(),
      detached: true,
      stdio: ["ignore", fd, fd],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
    });
    if (!child.pid) {
      child.kill();
      return { error: `哨兵起不来：${opts.command}` };
    }
    child.unref();
    return {
      pid: child.pid,
      onExit: (cb) => {
        child.on("error", () => cb(null));
        child.on("exit", (code, signal) => cb(code ?? (signal ? null : 0)));
      },
    };
  } catch (e) {
    return { error: `哨兵起不来：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    // 父进程立刻交还 fd：子进程已经各自持有一份复制品，留着只会在日志被删后拖住 inode。
    try { closeSync(fd); } catch { /* 已经关了 */ }
  }
}

/** tail 的轮询间隔。事件要的是「几百毫秒内知道」，不是实时，250ms 足够且近乎零开销。 */
export const TAIL_POLL_MS = 250;

export type Tailer = { stop: () => void; drain: () => void };

/**
 * 从 `startOffset` 开始跟着文件尾巴走，**只吐完整的行**。
 *
 * 「只吐完整的行」是硬要求而不是讲究：offset 要落库，它必须永远停在换行处，否则 server
 * 重启后从半行接着读，那一行会被劈成两条事件。全程在 Buffer 上按 0x0A 切，也就不会在半个
 * UTF-8 字符中间下刀。
 *
 * `onLines` 拿到的是这一轮新读到的所有整行，以及**读完之后**的绝对字节位置——调用方按它
 * 落库，于是「这些行已经推出去了」和「读到了这里」是同一次写入，不会各记各的。
 */
export function tailLines(
  path: string,
  startOffset: number,
  onLines: (lines: string[], offset: number) => void,
): Tailer {
  let offset = startOffset;
  let pending = Buffer.alloc(0);
  let fd: number | null = null;
  let stopped = false;

  const openFd = (): number | null => {
    if (fd !== null) return fd;
    if (!existsSync(path)) return null;
    try { fd = openSync(path, "r"); } catch { fd = null; }
    return fd;
  };

  const pump = () => {
    if (stopped) return;
    const f = openFd();
    if (f === null) return;
    // 文件被截断/换掉了（有人 `>` 了它）：从头再来，否则 offset 永远超过文件长度，
    // 之后写进去的内容一个字节都读不到，哨兵看起来就像「静默了」。
    try {
      const size = statSync(path).size;
      if (size < offset) { offset = 0; pending = Buffer.alloc(0); }
    } catch { /* stat 失败就按老路走 */ }
    const lines: string[] = [];
    for (;;) {
      const buf = Buffer.allocUnsafe(64 * 1024);
      let n = 0;
      try { n = readSync(f, buf, 0, buf.length, offset); } catch { break; }
      if (n <= 0) break;
      offset += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      const nl = pending.lastIndexOf(0x0a);
      if (nl >= 0) {
        for (const line of pending.subarray(0, nl).toString("utf8").split("\n")) lines.push(line);
        pending = pending.subarray(nl + 1);
      }
      if (n < buf.length) break;
    }
    if (lines.length) {
      // 已读但还没凑够一行的那几个字节不算数：报出去的 offset 一定落在换行处。
      onLines(lines, offset - pending.length);
    }
  };

  const timer = setInterval(pump, TAIL_POLL_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } fd = null; }
    },
    // 收尾前再吸一次：进程刚死那一瞬写进去的最后几行，不该因为「哨兵已停」就丢掉。
    drain: () => pump(),
  };
}
