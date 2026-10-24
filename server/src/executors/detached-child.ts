// 「输出走文件」那条路的**公共底座**:一次运行的三个落盘文件、跟着文件尾巴走的
// Readable、以及伪装成 ChildProcess 的那层外壳。
//
// 从 detached.ts 搬出来的理由只有一个:那边贴着 700 行上限,而 Windows 那条路
// (detached-win.ts)要用的恰好就是这几样 —— 两边各写一份 tailFile/外壳就是两种
// 「committed 落在哪」的语义,而那个数字直接决定重启后会不会把一行 JSON 劈成两半。
// 谁都别从这里 import spawn.ts:这一层只碰文件和流,不碰进程。
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { closeSync, openSync, readFileSync, readSync, existsSync } from "node:fs";
import { join } from "node:path";

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
export function readExitCode(rcPath: string): number | null {
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
export function makeDetachedChild(opts: {
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
  child.ashCommitted = () => out.committed();
  child.ashPaths = opts.paths;

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
    try { child.stdin?.destroy(); } catch { /* 已关闭 */ }
    child.exitCode = code;
    child.emit("exit", code, null);
    child.emit("close", code);
  });

  return child as DetachedChild;
}

export type DetachedChild = ChildProcess & {
  /** 已安全消费到的 stdout 字节位置(换行边界),存进 DB 供重启后接着读。 */
  ashCommitted: () => number;
  /** 可重连 stdin 与 App Server 恢复都从同一组路径派生，不另加数据库列。 */
  ashPaths: DetachedPaths;
};
