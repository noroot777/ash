// Windows 上那层「活得过 ash」的壳(POSIX 那边是白送的 `/bin/sh -c`)。
//
// 为什么非得有个壳。落盘输出本身不需要它 —— Node 的 `stdio` 直接收文件描述符,CLI 的
// stdout/stderr 就字节原样落在文件上。但另外两件事**只有一个活过 ash 的进程做得到**:
//
//   ① **退出码。** rc 只能由「观察到退出的那个人」写。让 ash 写,就等于「ash 恰好不在的
//      那一两秒里退出 = 退出码永久丢失」——而重启后接回的那一侧手上没有 ChildProcess,
//      它只认 rc 文件。POSIX 不吃这个亏正是因为写 rc 的是 shell,不是 ash。
//   ② **可重连 stdin。** 原生引导回合要一直往 CLI 的 stdin 里塞后续消息。ash 一死,匿名
//      管道的写端就没了,CLI 当场收到 EOF —— 它会把当前这一轮跑完,但这一轮再也引导不动,
//      而「重启后还能接着引导」本来就是 POSIX 那边 FIFO 换来的东西。
//
// 为什么是 node 而不是 cmd.exe / PowerShell:
//   · `cmd /c "<prog> <args> >>out 2>>err & <写 rc>"` 要把程序和参数拼成**一条命令行**再
//     让 cmd 解析一轮(win-command.ts 顶部那三条规则),而退出码还得靠 `%%errorlevel%%` /
//     `/v:on` 这类花招 —— 后者一开,参数里任何一个 `!` 都会被吃掉;
//   · PowerShell 的 `>>` 在 5.1 上写 UTF-16,且启动要几百毫秒;
//   · node 这条路**压根不拼命令行**:程序和参数照旧由 `spawn` 逐个交给内核,壳里把它们
//     原样转手。代价是一个常驻 node(约 35–45 MB),换来的是跟 POSIX 一字不差的契约。
//     ash 自己就是 node,所以没有新依赖;CLI 里有一半(claude)本来也是 node。
//
// 壳的源码按次写进运行目录(`<rc><WINDOWS_WRAP_SUFFIX>`),而不是打进 dist 或塞进 `node -e`:
// 前者在 `tsx` 跑源码的开发态下不存在,后者会把两千字的脚本原样挂进进程命令行。`.cjs` 后缀
// 是为了不受最近那个 package.json 的 `type` 影响。

import { createHash } from "node:crypto";
import type { DetachedPaths } from "./detached-child.js";

/**
 * 壳脚本的文件名后缀。**这不只是个文件名,它是一个对外可见的记号**:壳的路径原样挂在它自己
 * 的命令行上,于是进程表里能一眼认出「这个进程是一个活得过 ash 的 agent 壳」。
 *
 * `scripts/platform.mjs` 的重启那一刀就靠它:`killServerProcess` 按这个后缀认人并无条件
 * 绕开,不依赖控制面给的保护名单 —— 那份名单是**上一时刻**的快照,合不上后一刻的进程表
 * (第 1 轮审查 F2)。两份常量由 `server/scripts/test-win-launch.ts` 钉在一起,改名字那边
 * 会当场红。
 */
export const WINDOWS_WRAP_SUFFIX = ".ash-agent-wrap.cjs";

/** 壳用到的三个派生路径。都从 rc 派生,所以不往 DB 加列(跟 POSIX 的 FIFO 同一套做法)。 */
export function windowsWrapPaths(paths: DetachedPaths): {
  script: string;
  pipeMarker: string;
  pipeName: string;
} {
  // 管道名必须**跨重启稳定**(接回那一侧要按它找回来),又必须每次运行唯一 ——
  // rc 路径恰好两样都满足:它带着 sessionId 和回合起点。
  const id = createHash("sha1").update(paths.rc).digest("hex").slice(0, 20);
  return {
    script: `${paths.rc}${WINDOWS_WRAP_SUFFIX}`,
    // 存在性判定走**文件**而不是管道本身:`existsSync` 对 `\\.\pipe\…` 的行为跨 Node 版本
    // 不好保证,而这个文件由壳自己在收尾时删掉 —— 它在 = 管道还有人守着。
    pipeMarker: `${paths.rc}.stdin.pipe`,
    pipeName: `\\\\.\\pipe\\ash-stdin-${id}`,
  };
}

/**
 * 壳的源码。约定全部走环境变量,**命令行只有程序和它自己的参数** ——
 * `node <壳> <program> <args…>`。
 *
 * 几个不显眼但必须这么写的地方:
 *  · 壳自己的 stdout/stderr 不回 ash(回了就又多一条「ash 一死就 EPIPE」的绑定),
 *    它只把自己的故障附到 err 文件末尾,带 `[ash-wrap]` 前缀便于跟 CLI 的输出分辨;
 *  · ash 的 stdin 结束(重启)**不得**连带结束 CLI 的 stdin —— 那正是 ② 要防的 EOF;
 *  · rc 先写、再退出:接回那一侧看到「壳没了」时 rc 必定已经在盘上(跟 POSIX 的
 *    `printf %s $? >rc; exit` 同一个顺序)。
 */
export const WINDOWS_WRAP_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { appendFileSync, closeSync, openSync, unlinkSync, writeFileSync } = require("node:fs");
const net = require("node:net");

const OUT = process.env.ASH_OUT;
const ERR = process.env.ASH_ERR;
const RC = process.env.ASH_RC;
const PIPE = process.env.ASH_IN || "";
const MARKER = process.env.ASH_IN_MARKER || "";
const KEEP = process.env.ASH_KEEP_STDIN === "1";
const [file, ...args] = process.argv.slice(2);

const gripe = (msg) => { try { appendFileSync(ERR, "[ash-wrap] " + msg + "\n"); } catch { /* 盘满 */ } };

let out, err;
try {
  out = openSync(OUT, "a");
  err = openSync(ERR, "a");
} catch (e) {
  gripe("打不开输出文件:" + e.message);
  try { writeFileSync(RC, "126"); } catch { /* 同上 */ }
  process.exit(126);
}

const child = spawn(file, args, {
  stdio: ["pipe", out, err],
  windowsHide: true,
  windowsVerbatimArguments: process.env.ASH_VERBATIM === "1",
});
// 句柄已经随 spawn 复制进子进程,壳这一侧留着只是多占一个。
closeSync(out);
closeSync(err);

child.stdin.on("error", () => {});
// end:false 时 ash 重启只是让这条管道断开,CLI 的 stdin 不受影响(可重连的全部意义)。
process.stdin.on("error", () => {});
process.stdin.pipe(child.stdin, { end: !KEEP });

let server = null;
if (KEEP && PIPE) {
  server = net.createServer((conn) => {
    conn.on("error", () => {});
    conn.pipe(child.stdin, { end: false });
  });
  server.on("error", (e) => gripe("具名管道起不来:" + e.message));
  server.listen(PIPE, () => {
    if (MARKER) { try { writeFileSync(MARKER, PIPE); } catch (e) { gripe("写管道标记失败:" + e.message); } }
  });
}

let done = false;
const finish = (rc) => {
  if (done) return;
  done = true;
  try { writeFileSync(RC, String(rc)); } catch (e) { gripe("写 rc 失败:" + e.message); }
  if (MARKER) { try { unlinkSync(MARKER); } catch { /* 本来就没写出来 */ } }
  try { server && server.close(); } catch { /* ignore */ }
  // Windows 的退出码可以是 0xC0000005 这种大数,node 的 exit 只带低 8 位 ——
  // 真值在 rc 文件里,接回那一侧认的也是它。
  process.exit(rc & 0xff);
};

child.on("error", (e) => { gripe("起不来:" + e.message); finish(127); });
child.on("exit", (code, signal) => finish(code === null || code === undefined ? (signal ? 1 : 0) : code));
`;
