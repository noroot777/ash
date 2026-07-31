// agent 进程与 harness 解绑:输出写**文件**而不是匿名管道。
//
// 为什么这一层是必要的:spawn.ts 里的 agent 早就是 `detached: true`(自成进程组),
// server 重启时那句 `kill $OLD` 根本打不到它们;真正杀死它们的是 **stdout 匿名
// 管道** —— server 一死读端关闭,agent 下次往 stdout 写就吃 SIGPIPE 当场毙命。
// 把那根管子换成文件,这条唯一的生死绑定就断了:agent 照写不误,新起来的 server
// 从上次读到的字节位置接着读,期间它干的活一条不落。
// (这就是 server 自己 `nohup … > $LOG` 的同一招,只是原先没往下推到 agent 这层。)
//
// 对外形状**故意伪装成 ChildProcess**,跟 spawn.ts 的 failedChild 是同一个套路:
// parseClaudeStream / parseCodexStream 全部按 ChildProcess 写的(stdout/stderr/
// on('error'|'close'|'exit')),伪装之后它们一行都不用改。
//
// 不覆盖常驻会话(团队调度台):那是**双向**的,harness 还要往它 stdin 里塞后续
// 消息,文件替代不了。调度台走另一条路 —— 它本来就有完整的 `--resume` 自动接回
// (team/session.ts 的 deliver:内存里没有 lead 就自动 openLead 接回)。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { closeSync, openSync, readFileSync, readSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExecTarget } from "@harness/shared";
import { isSameProcess } from "../proc.js";
import { shq, resolveBin, augmentedEnv, failedChild, openTrackFd, registerTrackFd, killChild, killByPid } from "./spawn.js";

// 一次运行的三个落盘文件。rc 是退出码 —— 管道模式下退出码是 close 事件白送的,
// 换成文件后没人告诉我们了,只能让 shell 跑完自己写一个数字进去。
export type DetachedPaths = { out: string; err: string; rc: string };

export function detachedPathsFor(runDir: string, sessionId: string, turnStart: string): DetachedPaths {
  const turn = turnStart.replace(/[^0-9A-Za-z]/g, "");
  const base = join(runDir, `${sessionId}-${turn}`);
  return { out: `${base}.agent-out.jsonl`, err: `${base}.agent-err.log`, rc: `${base}.agent-rc` };
}

// 轮询间隔。文件尾巴的读取延迟直接决定网页上「字往外冒」的手感,所以压得比较低;
// 代价只是每个在跑的任务每 50ms 一次 read 系统调用(10 个并行 = 200 次/秒,可忽略)。
const POLL_MS = 50;
// 进程存活探测。只在**接管**路径用(spawn 路径有真的 ChildProcess,exit 事件白送),
// 频率可以低得多。
const LIVENESS_MS = 400;

// 跟着文件尾巴走的 Readable。只吐**完整的行** —— 这样 committed 永远落在换行处,
// 重启后从 committed 接着读绝不会把一行 JSON 劈成两半(claude/codex 的 stream-json
// 都是一行一个事件,劈开就是解析失败)。
// 多字节字符同理:全程在 Buffer 上按 0x0A 切,不在半个 UTF-8 字符中间下刀。
function tailFile(path: string, startOffset: number) {
  let offset = startOffset;
  let pending = Buffer.alloc(0);
  let fd: number | null = null;
  const stream = new Readable({ read() {} });

  const openFd = () => {
    if (fd !== null) return fd;
    if (!existsSync(path)) return null;
    try {
      fd = openSync(path, "r");
    } catch {
      fd = null;
    }
    return fd;
  };

  // 把文件里当前可读的部分全部吸干。返回是否吐出过新内容。
  const pump = (): boolean => {
    const f = openFd();
    if (f === null) return false;
    let grew = false;
    for (;;) {
      const buf = Buffer.allocUnsafe(64 * 1024);
      let n = 0;
      try {
        n = readSync(f, buf, 0, buf.length, offset);
      } catch {
        break; // 文件被删/fd 失效:当作读到头,由存活探测去收尾
      }
      if (n <= 0) break;
      offset += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      const nl = pending.lastIndexOf(0x0a);
      if (nl >= 0) {
        stream.push(pending.subarray(0, nl + 1));
        pending = pending.subarray(nl + 1);
        grew = true;
      }
      if (n < buf.length) break;
    }
    return grew;
  };

  return {
    stream,
    pump,
    // 已经安全消费到的字节位置(落在换行边界上)。存进 DB,重启后从这里接着读。
    committed: () => offset - pending.length,
    // 收尾:把剩下的读干净,连同最后那截没有换行的尾巴一起吐出去,然后结束流。
    finish() {
      pump();
      if (pending.length) {
        stream.push(pending);
        pending = Buffer.alloc(0);
      }
      stream.push(null);
      if (fd !== null) {
        try { closeSync(fd); } catch { /* already gone */ }
        fd = null;
      }
    },
  };
}

// 读退出码。rc 文件是 shell 在 CLI 跑完之后写的,所以「进程没了但 rc 还没出现」
// 是正常的竞态(几毫秒),调用方会重试几次。始终读不到 = 它是被杀死的,不是正常
// 退出 —— 按非零处理,别把一次强杀记成成功。
function readExitCode(rcPath: string): number | null {
  try {
    const raw = readFileSync(rcPath, "utf8").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// 伪装成 ChildProcess 的公共外壳。两条路(新起 / 接管)只有「怎么知道它死了」
// 和「怎么杀它」不一样,流的部分完全共用。
function makeDetachedChild(opts: {
  pid: number;
  paths: DetachedPaths;
  startOffset: number;
  stdin: ChildProcess["stdin"];
  kill: () => void;
  // 注册「进程退出时叫我」。回调参数是退出码(拿不到就 null)。
  onExit: (cb: (code: number | null) => void) => void;
}): DetachedChild {
  // 跟 failedChild 同一个套路:ChildProcess 的 pid/exitCode 等在类型上是只读的,
  // 合成品只能先当普通对象拼好再整体断言。
  const child: any = new EventEmitter();
  const out = tailFile(opts.paths.out, opts.startOffset);
  const err = tailFile(opts.paths.err, 0);
  child.stdout = out.stream;
  child.stderr = err.stream;
  child.stdin = opts.stdin;
  child.pid = opts.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    opts.kill();
    return true;
  };
  child.harnessCommitted = () => out.committed();

  const timer = setInterval(() => {
    out.pump();
    err.pump();
  }, POLL_MS);
  (timer as { unref?: () => void }).unref?.();

  let settled = false;
  opts.onExit((code) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    // 关键顺序:先把文件读干净再宣告结束。反过来的话,进程最后一口气写下的
    // 内容(往往正是 result 那一行)会被丢掉,run loop 就拿不到 session_id /
    // 退出信息了。
    out.finish();
    err.finish();
    child.exitCode = code;
    child.emit("exit", code, null);
    child.emit("close", code);
  });

  return child as DetachedChild;
}

export type DetachedChild = ChildProcess & {
  /** 已安全消费到的 stdout 字节位置(换行边界),存进 DB 供重启后接着读。 */
  harnessCommitted: () => number;
};

// 新起一个「活得过 server 重启」的 agent。
//
// 做法是套一层 shell 把输出重定向到文件、跑完再把退出码写进 rc:
//   sh -c '"$@" >>"$OUT" 2>>"$ERR"; printf %s $? >"$RC"' sh <cli> <args…>
// 路径全部走 env 传,不进命令行 —— 免掉一整类引号转义问题。
// `"$@"` 展开成「命令 + 它的参数」(sh -c 的 $0 是那个占位的 "sh"),所以 CLI 是
// 被 sh fork 出来的子进程,进程组组长是 sh,killChild 的 kill(-pid) 照样罩得住。
// stdin 仍是管道:prompt 写完立刻 end(),之后 agent 不再依赖它,所以 server 死了
// 也不影响 —— 这一点跟常驻会话不同,后者要一直往 stdin 里塞消息,故不走这条路。
export function spawnDetachedAgent(
  target: ExecTarget,
  cwd: string,
  bin: string,
  args: string[],
  prompt: string,
  paths: DetachedPaths,
  extraEnv?: Record<string, string>,
): DetachedChild | ChildProcess {
  if (target.kind === "ssh") {
    // ssh 那头的进程本来就不挂在本地 server 的管道上,不需要这套;调用方回退到
    // 普通 spawnAgent。这里显式拒绝,免得以后有人以为它支持。
    return failedChild("detached 模式暂不支持 ssh 目标");
  }
  const abs = resolveBin(bin);
  if (!abs) return failedChild(`找不到 ${bin} 命令(不在 PATH，也不在常见目录)`);

  // 先把文件建出来:tailFile 一开始就要 open 它们,而 shell 的 >> 要等到真正
  // 执行时才创建,中间那一小段空窗会让 tailer 白等一轮。
  for (const p of [paths.out, paths.err]) {
    try { closeSync(openSync(p, "a")); } catch { /* 目录不存在等,交给下面的 spawn 报错 */ }
  }

  const script = '"$@" >>"$HARNESS_OUT" 2>>"$HARNESS_ERR"; printf %s $? >"$HARNESS_RC"';
  const env = {
    ...augmentedEnv(),
    ...extraEnv,
    HARNESS_OUT: paths.out,
    HARNESS_ERR: paths.err,
    HARNESS_RC: paths.rc,
  };
  // 逃逸追踪跟普通 spawn 走同一套(见 spawn.ts 的 openTrackFd 注释)。
  const track = openTrackFd();
  const stdio: Array<"pipe" | "ignore" | number> =
    track.fd === null ? ["pipe", "ignore", "ignore"] : ["pipe", "ignore", "ignore", track.fd];
  const real = spawn("/bin/sh", ["-c", script, "sh", abs, ...args], {
    cwd,
    stdio,
    env,
    detached: true,
  });
  registerTrackFd(real, track);
  real.stdin?.write(prompt);
  real.stdin?.end();

  if (!real.pid) return failedChild(`起不来:${shq(bin)}`);

  const child = makeDetachedChild({
    pid: real.pid,
    paths,
    startOffset: 0,
    stdin: real.stdin,
    kill: () => killChild(real),
    onExit: (cb) => {
      real.on("error", (e) => cb(e ? 1 : 0));
      // sh 退出 = CLI 已经跑完并且 rc 已经写好(那是同一条命令行里的下一句)。
      // 仍留一轮重试:极少数情况下文件写入还没落地。
      real.on("exit", (code, sig) => {
        const fallback = code ?? (sig ? 1 : 0);
        const rc = readExitCode(paths.rc);
        if (rc !== null) return cb(rc);
        setTimeout(() => cb(readExitCode(paths.rc) ?? fallback), 50);
      });
    },
  });
  return child;
}

// 重启后接管一个还活着的 agent。
// 返回 null = 它已经不在了(或者 pid 被复用成了别的进程),调用方按「这一轮被打断」
// 处理。**pid 复用必须挡住**:光 kill(pid,0) 只能证明「有个进程叫这个号」,不能
// 证明还是当初那个 agent —— 挂上启动时间一起比对。
export function reattachDetachedAgent(opts: {
  pid: number;
  startedAt: string | null;
  paths: DetachedPaths;
  offset: number;
}): DetachedChild | null {
  if (!isSameProcess(opts.pid, opts.startedAt)) return null;

  return makeDetachedChild({
    pid: opts.pid,
    paths: opts.paths,
    startOffset: opts.offset,
    // 接管不回 stdin:prompt 早在当初就写完并 end 了,现在也没有管道可写。
    stdin: null,
    kill: () => killByPid(opts.pid),
    onExit: (cb) => {
      // 没有 ChildProcess 可听,只能探。kill(pid,0) 抛 ESRCH = 确实没了
      //(复用只会让它显得「活着」,不会让活着的显得死了,所以这个方向是安全的)。
      const t = setInterval(() => {
        let alive = true;
        try {
          process.kill(opts.pid, 0);
        } catch {
          alive = false;
        }
        if (alive) return;
        clearInterval(t);
        setTimeout(() => cb(readExitCode(opts.paths.rc)), 50);
      }, LIVENESS_MS);
      (t as { unref?: () => void }).unref?.();
    },
  });
}
