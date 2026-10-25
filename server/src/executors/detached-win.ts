// **Windows 上「活得过 ash 重启」的那条路。**
//
// POSIX 那边的做法是套一层 `/bin/sh -c '"$@" >>out 2>>err; printf %s $? >rc'`:shell 既做
// 重定向、又在 CLI 跑完之后把退出码写进 rc。Windows 上这一层**不需要 shell** —— Node 的
// `stdio` 直接收文件描述符,内核把那两个句柄交给 CLI,它的 stdout/stderr 就落在文件上,
// **字节原样**。这比 cmd.exe / PowerShell 的重定向可靠得多:前者要在命令行里再解析一轮
// 引号(`win-command.ts` 顶部那三条),后者会插手编码(PS 5.1 的 `>>` 写 UTF-16)。
//
// 落盘同时断掉了 POSIX 那边那条生死绑定(stdout 匿名管道:ash 一死读端关闭,CLI 下次写就吃
// EPIPE 当场毙命)。但**那不是 Windows 上的死因** —— 这边还有一条更硬的,见下面
// `detached: true` 那一节:libuv 的全局 Job。两条都断掉了才叫「活得过重启」。
//
// ── 退出码与可重连 stdin:套一层壳,跟 POSIX 同一个契约 ──────────────────────────
//
// 落盘输出不需要壳,但另外两件事只有「一个活过 ash 的进程」做得到:rc 得由观察到退出的那个
// 人写,stdin 得有个不随 ash 消失的持有者。所以这边也套一层 —— 不是 shell,是一个按次生成
// 的 node 壳(`detached-win-wrap.ts`,那边写着为什么不用 cmd.exe / PowerShell、以及代价)。
//
// 于是两个平台的契约逐字相同:**pid + 落盘输出 + 退出码 + 可接管 + 可重连 stdin**。
// 差别只剩实现细节 —— 那边是 `/bin/sh` + FIFO,这边是 node 壳 + 具名管道。
//
// 壳是**进程树的根**,也就是 `agentPid` 记的那个号:killTree 的 `taskkill /T` 按 ppid 走,
// 打在壳上连 CLI 一起收;内核圈定(Job Object)也圈在壳上,CLI 作为它的子进程自动继承,
// 覆盖范围反而比直起 CLI 那条路更整。
//
// ── `detached: true` 在这条路上是**必需**的,不是可选项 ──────────────────────────
//
// libuv 在 Windows 上给**每一个非 detached 的子进程**都做一次
// `AssignProcessToJobObject`,塞进它自己的一个全局 Job —— 那个 Job 带着
// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。于是父进程(ash)一退出,句柄由内核回收,
// 圈里的进程**全部被杀**:这就是「Windows 上 agent 活不过 ash 重启」的真正机制,跟
// `taskkill /T`、跟 stdout 管道都无关。`UV_PROCESS_DETACHED` 恰好是 libuv 唯一跳过那次
// assign 的分支,所以这边必须开。
//
// 2026-10-23 在 192.168.1.187 实测(父进程起完子进程 700ms 后 process.exit(0),再轮询
// 3 秒,三种起法各跑一遍):
//
//     直起 CLI(文件 fd、不 detached)      → 父一退,子当场死,输出停在 5 行
//     套壳(不 detached)                   → 壳和 CLI 一起死(壳的 job 又连坐了 CLI)
//     **detached**                          → 父退出后子照常活着、输出继续长到 26 行
//
// 代价是 `DETACHED_PROCESS`:壳自己没有控制台 —— 它是 node,不在乎(powershell.exe 那种
// 控制台应用会当场空退,见 confine-job.ts 的同一组实测)。CLI 由壳用
// `windowsHide` 起,拿到的是自己的无窗控制台,不跟 ash 共用 —— 顺带把「终端会话
// (ConPTY)一关就把 agent 带走」这条路也断了。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import {
  makeDetachedChild, readExitCode, type DetachedChild, type DetachedPaths,
} from "./detached-child.js";
import { WINDOWS_WRAP_SOURCE, windowsWrapPaths } from "./detached-win-wrap.js";
import {
  agentBaseEnv, failedChild, guardAgentSpawn, isDir, killChild, openTrackFd, registerTrackFd,
  resolveLaunch, shareChildIdentity, shareTrackFdRegistration,
} from "./spawn.js";
import { registerRootLife, shareRootLife } from "./root-life.js";
import {
  registerRunOutPath, registerUnitToken, seedUnitToken, shareRunOutPath, shareUnitToken,
} from "./unit-token.js";
import { openConfinement, registerConfinement, shareConfinement } from "./kernel-confine.js";
import { registerWindowsOwnership } from "./windows-run-evidence.js";
export { reopenWindowsControlStdin } from "./windows-control-stdin.js";

/**
 * 起一个输出落盘的 agent(Windows)。`keepStdin` = 原生引导回合:首条消息写完不关 stdin,
 * 调用方继续往里塞后续回合(见上面那段关于「ash 一死 stdin 收 EOF」的说明)。
 */
export function spawnWindowsDetachedAgent(
  cwd: string,
  bin: string,
  args: string[],
  input: string,
  paths: DetachedPaths,
  extraEnv?: Record<string, string | undefined>,
  opts?: { keepStdin?: boolean },
): DetachedChild | ChildProcess {
  const blocked = guardAgentSpawn(bin);
  if (blocked) return blocked;
  // 前置判定跟 spawnAgent 同一套:两者都会报 ENOENT,只有分开说才不说假话。
  if (!isDir(cwd)) return failedChild(`工作目录不存在：${cwd}`);
  let plan;
  try {
    plan = resolveLaunch(bin, args);
  } catch (e) {
    return failedChild(e instanceof Error ? e.message : String(e));
  }
  if (!plan) return failedChild(`找不到 ${bin} 命令(不在 PATH，也不在常见目录)`);

  // 文件先建出来:tailFile 一开始就 open 它们。拿到的 fd 交给子进程当 stdout/stderr,
  // **父进程这一侧随后立刻关掉** —— 句柄已经随 spawn 复制进子进程,留着只是多占一个。
  let outFd: number;
  let errFd: number;
  try {
    outFd = openSync(paths.out, "a");
  } catch (e) {
    return failedChild(`打开输出文件失败：${paths.out}（${e instanceof Error ? e.message : String(e)}）`);
  }
  try {
    errFd = openSync(paths.err, "a");
  } catch (e) {
    try { closeSync(outFd); } catch { /* ignore */ }
    return failedChild(`打开错误输出文件失败：${paths.err}（${e instanceof Error ? e.message : String(e)}）`);
  }

  // 壳的源码按次落盘。写不出来就**不要退回「直起 CLI」** —— 那是一条看起来能跑、却悄悄
  // 丢掉退出码和可重连 stdin 的路,而调用方无从分辨。如实失败。
  const wrap = windowsWrapPaths(paths);
  try {
    writeFileSync(wrap.script, WINDOWS_WRAP_SOURCE);
    writeFileSync(wrap.state, JSON.stringify({ supported: !!opts?.keepStdin, status: "pending" }));
    writeFileSync(wrap.ownership, JSON.stringify({ status: "pending" }));
  } catch (e) {
    try { closeSync(outFd); } catch { /* ignore */ }
    try { closeSync(errFd); } catch { /* ignore */ }
    return failedChild(`写入运行外壳失败：${wrap.script}（${e instanceof Error ? e.message : String(e)}）`);
  }
  try { if (existsSync(wrap.pipeMarker)) unlinkSync(wrap.pipeMarker); } catch { /* 上一轮的残留 */ }

  const env: Record<string, string | undefined> = {
    ...agentBaseEnv(),
    ...extraEnv,
    // 壳认的那几项。跟 POSIX 的 `ASH_OUT`/`ASH_ERR`/`ASH_RC`/`ASH_IN` 同名同义。
    ASH_OUT: paths.out,
    ASH_ERR: paths.err,
    ASH_RC: paths.rc,
    ASH_VERBATIM: plan.windowsVerbatimArguments ? "1" : "0",
    ASH_KEEP_STDIN: opts?.keepStdin ? "1" : "0",
    ASH_IN: opts?.keepStdin ? wrap.pipeName : undefined,
    ASH_IN_MARKER: opts?.keepStdin ? wrap.pipeMarker : undefined,
    ASH_STDIN_STATE: wrap.state,
    ASH_OWNERSHIP: wrap.ownership,
  };
  const unitToken = seedUnitToken(env);
  // 内核圈定(Windows 上是 Job Object,见 kernel-confine.ts / confine-job.ts):圈号与记号
  // 同源。这条路只有父进程这一侧写得了号(拿不到 CREATE_SUSPENDED),所以 coverage 是
  // `since-enroll` —— 跟 spawnAgent 那条路逐字一致。
  const confine = openConfinement(unitToken);
  Object.assign(env, confine?.preExecEnv() ?? {});
  // 追踪 fd 在 Windows 上恒为空(没有 lsof 等价物,见 track-evidence.ts),这里照旧调一次,
  // 为的是两条路的形状一致:哪天那边有了反查手段,只改那一处就全线生效。
  const track = openTrackFd();
  const stdio: Array<"pipe" | "ignore" | number> = track.fd === null
    ? ["pipe", outFd, errFd]
    : ["pipe", outFd, errFd, track.fd];
  const bornAt = Date.now();                      // 理由见 spawn.ts 里同一句
  // 壳拿 `node <wrap.cjs> <program> <args…>`:程序和参数照旧逐个过内核,不拼命令行,
  // 所以 `windowsVerbatimArguments` 这类规则留给壳里那次 spawn 处理(走 ASH_VERBATIM)。
  const real = spawn(process.execPath, [wrap.script, plan.file, ...plan.args], {
    cwd,
    stdio,
    env,
    // 见上:不开这个,libuv 的全局 Job 会在 ash 退出时把整棵树一起带走。
    detached: true,
    windowsHide: true,
  });
  // **`error` 的消费者必须在任何一个出口之前就位**(第 1 轮审查 N4)。spawn 的失败是
  // **异步** emit 的,而下面还有一个「拿不到 pid 就 return failedChild」的出口 —— 先 return
  // 的话那次 emit 就落在一个没有监听者的 EventEmitter 上,node 会升级成 uncaughtException
  // (健康的 server 兜底记一笔,没装兜底的调用方直接退出)。所以这里先接住、存着:
  // onExit 注册得上就转交给它,注册不上(走了 failedChild)就烂在这儿,谁都不会被它炸。
  let exitCb: ((code: number | null) => void) | null = null;
  let pendingExit: number | null = null;
  const settleExit = (rc: number) => {
    if (exitCb) exitCb(rc);
    else pendingExit = rc;
  };
  real.on("error", () => settleExit(1));
  // 壳退出 = CLI 已经跑完、rc 已经写好(那是它退出前的最后两件事)。留一轮重试,
  // 跟 POSIX 那条路逐字一致:极少数情况下文件写入还没落地。
  real.on("exit", (code, signal) => {
    const fallback = code ?? (signal ? 1 : 0);
    const rc = readExitCode(paths.rc);
    if (rc !== null) return settleExit(rc);
    setTimeout(() => settleExit(readExitCode(paths.rc) ?? fallback), 50);
  });
  try { closeSync(outFd); } catch { /* ignore */ }
  try { closeSync(errFd); } catch { /* ignore */ }
  registerTrackFd(real, track);
  registerUnitToken(real, unitToken);
  registerRunOutPath(real, paths.out);
  // **enroll 成了才登记这个圈**。POSIX 那条路可以无条件登记,因为真正入圈的是 shell 自己
  // (`CONFINE_ENROLL_CMD` 在 exec 之前跑);这边没有壳内 enroll 这一档,父进程这一次调用
  // 就是唯一的入圈动作 —— 失败了还登记,判定就会去问一个压根不存在的圈,把「这台设备弃权」
  // (absent)说成「问了但答不出来」(unknown),而后者会让清理白等一轮。跟 spawn.ts 的管道
  // 路径逐字同一个写法。
  if (real.pid && confine?.enroll(real.pid)) registerConfinement(real, confine);
  else confine?.dispose();
  registerRootLife(real, bornAt);
  registerWindowsOwnership(real, paths);
  real.stdin?.write(input);
  if (!opts?.keepStdin) real.stdin?.end();
  // 没跑起来的运行:圈已在上面 dispose 过(enroll 不可能成功),这里只负责如实报错。
  if (!real.pid) return failedChild(`起不来:${bin}`);

  const child = makeDetachedChild({
    pid: real.pid,
    paths,
    startOffset: 0,
    stdin: real.stdin,
    kill: () => killChild(real),
    onExit: (cb) => {
      exitCb = cb;
      // 监听器在 spawn 之后就装好了(见上面那段),所以这里只负责把已经发生过的那次接走。
      if (pendingExit !== null) cb(pendingExit);
    },
  });
  shareTrackFdRegistration(real, child);
  shareChildIdentity(real, child);  // 身份以真进程的内核状态为准(理由见 detached.ts 同一句)
  shareRootLife(real, child);
  shareUnitToken(real, child);
  shareRunOutPath(real, child);
  shareConfinement(real, child);
  registerWindowsOwnership(child, paths);
  return child;
}
