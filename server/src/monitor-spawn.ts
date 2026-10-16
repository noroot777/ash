// 哨兵的**进程**这一层：怎么把一条用户命令起成「ash 死了它也还活着」的长跑进程，
// 以及怎么跟着它的输出文件按行往下读。编排（什么时候推、推给谁、什么时候停）在
// monitors.ts，这里一个业务判断都没有。
//
// 脱离 ash 靠两件事，缺一不可（跟 executors/detached.ts 是同一招，理由见那里的文件头）：
//   ① `detached: true` —— POSIX 上 setsid 自成会话/进程组，ash 退出时的那串信号打不到它
//   ② **输出写文件、不给它任何管道** —— 唯一真正的生死绑定是 stdout 匿名管道：ash 一死
//      读端关闭，它下次往 stdout 写就吃 SIGPIPE 当场毙命。换成文件这条绑定就断了。
// 再加一个 `unref()`，ash 自己的事件循环也不会被它吊着不退。
//
// ── 放行闸：**命令开工之前，身份必须已经落库**（第 7 轮审查 F3）─────────────────
//
// 「起进程」和「把它记下来」是两件事，顺序决定了失败时会不会留下无主资源。原来是先 spawn
// 再 insert：登记失败时命令已经独立跑了几十毫秒，只能事后去追（落责任、发信号、确认退出），
// 而当身份查询也不可用、责任表又写不进去时，那个进程的唯一线索只剩一个 unref 定时器的内存
// 参数 —— 进程一退它就没了，重启恢复只枚举 monitors 和债表，两张表都没有它（实测：命令还
// 活着，三处全空）。
//
// 所以 spawn 出来的壳**先停在一道闸前面**：它第一件事是从 fd 3 读一行，读到才 exec 用户的
// 命令。ash 只有在身份行（含 pid）落库之后才写那一行。于是：
//   · 登记失败 ⇒ 不放行 ⇒ 用户的命令**从未开工**，没有任何需要回收的外部资源；
//   · ash 在放行前自己没了 ⇒ 写端随进程关闭 ⇒ 壳读到 EOF ⇒ 自己退出，同上；
//   · 放行之后 ⇒ 身份早已在库里，照旧由接回/债表那一圈兜。
// 壳是我们自己拼的一行 `sh`，不会 trap 信号，所以不放行时那一刀必中。
//
// **win32 没有这道闸**：`cmd.exe` 里没有可靠的「从第 3 号句柄读一行」写法，硬凑出来的
// `for /l` + `if exist` 轮询要把用户命令嵌进括号里（命令里一个 `)` 就炸）。那一侧只保留
// 「先落行、再 spawn、再回填 pid」的顺序，残余窗口写在 monitor-create.ts 里。**未在
// Windows 真机验证**（约定见根 AGENTS.md）。
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentBaseEnv } from "./executors/spawn.js";
import { IS_WINDOWS, userShellLaunch } from "./platform.js";
import { RUNS_DIR } from "./paths.js";

/** 输出落在任务自己的 run 目录下，跟会话正文、trace 同一处，归档清理不必另记一份路径。 */
export function monitorLogPath(taskId: string, monitorId: string): string {
  return join(RUNS_DIR, taskId, `monitor-${monitorId}.log`);
}

export type SpawnedMonitor = {
  pid: number;
  /** 命令自己跑完时回调一次（仅限本进程起的那次；跨 server 重启接回来的拿不到）。 */
  onExit: (cb: (code: number | null) => void) => void;
  /**
   * **让用户的命令开工**。只有身份已经落库的那条路径才许调（见文件头的放行闸）。
   * win32 上是空操作：那一侧没有闸，命令在 spawn 的那一刻就已经在跑了。
   */
  release: () => void;
  /**
   * **这次不放行**：关掉写端让壳自己退出（它还没 exec 用户的命令），调用方随后照旧走回收圈
   * 兜一刀。POSIX 上这意味着用户的命令一行都没跑过。
   */
  abandon: () => void;
};

/** 放行闸的那段壳前缀：先从 fd 3 读一行，读不到（ash 没了）就退出，绝不执行用户的命令。 */
const GATE_PREFIX = "IFS= read -r __ash_go <&3 || exit 97; exec 3<&-; ";

export function spawnMonitor(opts: { command: string; cwd: string; logPath: string }): SpawnedMonitor | { error: string } {
  // 工作目录先自己判一句。它失效是**最常见**的一种失败（项目目录被移走、旧任务的
  // worktree 被清掉），而 `spawn` 对坏 cwd 的报错是**异步**的：那条路在下面要靠两道
  // 防线才接得住，没必要为一个一句话就能判出来的情况去赌那两道。
  try {
    if (!statSync(opts.cwd).isDirectory()) return { error: `哨兵的工作目录不是一个目录：${opts.cwd}` };
  } catch {
    return { error: `哨兵的工作目录不在了：${opts.cwd}` };
  }
  mkdirSync(dirname(opts.logPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(opts.logPath, "a");
  } catch (e) {
    return { error: `建不了哨兵日志文件 ${opts.logPath}：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    // 闸只装在 POSIX 那一侧（见文件头）。拼在**命令前面**而不是包一层括号：用户的命令原样
    // 跟在后面，它自己的引号、换行、`&&` 的语义一个字都不变。
    const gated = !IS_WINDOWS;
    const launch = userShellLaunch(gated ? `${GATE_PREFIX}${opts.command}` : opts.command);
    // stdin 给 ignore 而不是继承：哨兵命令不该有机会去读 ash 的标准输入（闸走的是 fd 3，
    // 所以用户的命令拿到的 stdin 仍然是 /dev/null）。
    // stdout/stderr 都指向同一个 fd —— 合流是刻意的，命令自己报的错也该成为事件。
    const child = spawn(launch.file, launch.args, {
      cwd: opts.cwd,
      env: agentBaseEnv(),
      detached: true,
      stdio: gated ? ["ignore", fd, fd, "pipe"] : ["ignore", fd, fd],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
    });
    // `error` 必须**此刻**就挂上，不能等调用方 `onExit` 时再挂：spawn 的失败是异步报的
    // （坏 cwd 在 fork 之后才 chdir 失败），这一刻没有监听者的话 Node 把它升级成
    // uncaughtException —— 整个 ash 当场退出，一次失败的创建把所有任务页一起带下线
    // （第 2 轮审查实测：隔离服务退出码 143，日志 `uncaughtException: spawn sh ENOENT`）。
    let failure: Error | null = null;
    let forward: ((code: number | null) => void) | null = null;
    child.on("error", (e) => {
      failure = e;
      forward?.(null);
    });
    if (!child.pid) {
      // **绝不能 `child.kill()`**：没有 pid 就没有进程可杀，这一步会走到
      // `uv_process_kill(0, SIGTERM)`，而 POSIX 的 `kill(0, …)` 是「发给自己所在的
      // 整个进程组」—— ash 把自己连同它起的一切一起 SIGTERM 掉（同上，实测）。
      return { error: `哨兵起不来：${opts.command}` };
    }
    child.unref();
    // 闸的写端：**也要 unref**，不然 ash 的事件循环会被这个 pipe 吊着不退（`child.unref()`
    // 只管进程句柄，stdio 流是另一个 handle）。
    const gate = (child.stdio as Array<{ write?: (chunk: string) => void; end?: () => void; destroy?: () => void; unref?: () => void } | null>)[3];
    gate?.unref?.();
    return {
      pid: child.pid,
      release: () => {
        if (!gate?.write) return;      // win32：没有闸，命令早就在跑了
        try { gate.write("go\n"); gate.end?.(); } catch { /* 它已经没了：那就是没放行 */ }
      },
      abandon: () => {
        // 关掉写端 = 壳那边读到 EOF = 它在 exec 之前就退出。调用方仍会补一刀兜底。
        try { gate?.destroy?.(); } catch { /* 已经关了 */ }
      },
      onExit: (cb) => {
        forward = cb;
        child.on("exit", (code, signal) => cb(code ?? (signal ? null : 0)));
        // 挂得比失败还晚（起进程和登记之间隔着一次 insert）：补叫一次，否则这个哨兵
        // 会以 running 的样子一直挂到超时。
        if (failure) cb(null);
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

/**
 * 从文件**尾部**回读一段，切成完整的行。给界面看「它这会儿在吐什么」用。
 *
 * 不从头读的理由不只是省内存：哨兵盯的东西一跑就是几小时，日志动辄几十上百兆，而人想看
 * 的永远是最后那几十行。从尾部截一段再把开头那半行丢掉（`start > 0` 时），比按行遍历
 * 整个文件便宜几个数量级，代价只是最旧的那一行可能缺个头——那一行本来也不在视野里。
 */
export function readLogTail(path: string, maxBytes: number): { lines: string[]; truncated: boolean } {
  let size = 0;
  try { size = statSync(path).size; } catch { return { lines: [], truncated: false }; }
  const start = Math.max(0, size - maxBytes);
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { lines: [], truncated: false }; }
  try {
    const buf = Buffer.allocUnsafe(size - start);
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    const text = buf.subarray(0, filled).toString("utf8");
    const lines = text.split("\n");
    // 截断点多半落在某一行中间：那半行不是一行，丢掉而不是当成一行展示。
    if (start > 0) lines.shift();
    if (lines.at(-1) === "") lines.pop();
    return { lines, truncated: start > 0 };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}
