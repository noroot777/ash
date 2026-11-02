// 门禁命令的**退出结果**：起它的那个 ash 收不到时（重启了），新实例凭什么认。
//
// 由来（2026-11-02）：启动器（GATE_BOOTSTRAP）拿到退出码后原本只用 process.exit 转发，唯一的
// 收件人是旧 ash 内存里的 exit 回调。ash 一重启，十几分钟跑出来的 rc=0 没人认，只能落「被打断」
// 让用户从头再跑一遍。现在启动器转发之前先把结果原子写进日志旁的 `.exit.json`
// （accept-gate-launch.ts 的 GATE_BOOTSTRAP），重启后按三岔分流（gateRecoveryFate）：
//
//   命令还在跑、身份核得上   → 接管：接着等它退出，看门的照旧（watchGateExit + accept-gate.ts）
//   命令没了、留下了退出档   → 按真实 rc 结算，跟没重启过走同一条路（gateExitOutcome）
//   其余一切                 → 维持老结局「被打断」：拿不到真实结果就不编一个
//
// **退出档的可信条件**（绿了会自动合并，不可逆，所以任何一条不满足都退回「被打断」）：
//  · 档在这一次 run 自己的日志路径旁（runId 唯一），起跑前还会清掉同路径的旧档 —— 不会串到
//    别的运行、也不会认领上一次的残留；
//  · 档里的 pid 就是启动记录里登记的那个启动器；tmp+rename 写入，启动器被杀/崩溃只会留下
//    没改名的 tmp，读口不认；
//  · 启动记录是 armed（命令确实被放行过），而且**没有 abort 标记**。abort 只由 ash 自己写
//    （取消、超时、结算时的收尾都先写它再动刀），有它就说明那一刻是 ash 在停这条命令：子进程被
//    信号打死后启动器留下的 128 不是命令自己的结论。「命令自己跑完了、旧 ash 正在收尾时死掉」
//    那一段不靠这里：结算一认领就先把结论落库（accept-gate-settle.ts 的 settlement），重启后
//    照那一份续完，轮不到这里来猜。
//
// **时限也按同一份证据判**（第 1 轮审查 F1）：退出档里有启动器自己量的单调用时，过了时限的
// 退出码一律不作数、按超时收。不然同一次运行，ash 在不在场就决定了它是「超时」还是「通过」。
import { existsSync, readFileSync } from "node:fs";
import type { AcceptGateFailure, AcceptGateStatus } from "@ash/shared/accept-gate";
import { gateAbortPath, gateConfinement, gateExitPath, gateGoPath, readGateLaunch } from "./accept-gate-launch.js";
import { isSameGateProcess, type GateExit } from "./accept-gate-process.js";
import { gateTakeoverUnavailable } from "./accept-gate-confinement.js";
import { gateTimeoutMs } from "./accept-gate-watch.js";
import { inspectProcessSync, isPidAlive } from "./platform.js";

/** 接管期间多久问一次「它退了没有」。只看一个文件在不在 + 一次进程身份，不在热路径。 */
const EXIT_POLL_MS = 1_000;

export type GateOutcome = { status: Exclude<AcceptGateStatus, "running">; exitCode: number | null; failure: AcceptGateFailure | null;
  /** 「为什么是这个结论」的一句话，落进任务时间线。 */
  note?: string };
/**
 * 认领下来、落进 settlement 列的结论。scene = 撞上时限那一刻的完整现场，结算一开头就冻结存盘，
 * 不追加进日志；delivering = 红了之后那份修复输入**已经开始投递**（拿到回合、即将起跑）时的
 * 投递凭据，重启时据此分辨「从没送过、可以补发」「凭据已落进会话、送到了」和「说不清、不许
 * 重发」（accept-gate-handoff.ts）。
 */
export type GateSettlement = GateOutcome & { scene?: string; delivering?: string };

/** 库里那份认领下来的结论。读不出（旧行、坏 JSON）就当没有。 */
export function parseGateSettlement(value: string | null | undefined): GateSettlement | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as GateSettlement;
    return typeof parsed?.status === "string" && (parsed.status as string) !== "running" ? parsed : null;
  } catch { return null; }
}

export type GateFate = { kind: "exited"; exit: GateExit } | { kind: "running" } | { kind: "lost" };

const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

/**
 * 退出 → 结论。起它的 ash 收到的 exit 回调、重启后读到的退出档、接管期间等到的退出、看门的
 * 撞上时限那一刻，四条路查的是同一张表：结论只取决于命令怎么退的、用了多久，不取决于中间有没有
 * 重启过、谁先被处理。
 */
export function gateExitOutcome(exit: GateExit, timeoutMs = gateTimeoutMs()): GateOutcome {
  if (exit.elapsedMs !== undefined && exit.elapsedMs >= timeoutMs) return { status: "failed", exitCode: null, failure: "timeout",
    note: `命令跑了 ${minutes(exit.elapsedMs)} 分钟才退出（rc=${exit.code}），超过了 ${minutes(timeoutMs)} 分钟的上限，`
      + "按超时处理：过了时限的退出码不作数，不论那一刻 ash 在不在场。" };
  return exit.code === 0
    ? { status: "passed", exitCode: 0, failure: null }
    // 信号打死的那一条可能是取消/超时先发的刀 —— 那两条路自己会落更准的理由，
    // 这里的结论会被 settleGate 的幂等挡掉，只有「命令自己被外人杀了」才落到这儿。
    : { status: "failed", exitCode: exit.code, failure: exit.signal ? "canceled" : exit.code === null ? "spawn_failed" : "exit_code" };
}

/**
 * 启动器留下的退出档。只认这一次的那个启动器（pid）写的、完整的那一份；读不出、对不上一律 null。
 * 返回的 code 就是启动器本该用 process.exit 转发的那个数，signal 恒为 null（启动器自己没被信号打死）。
 * 没有用时的档同样不认：拿它结算就绕过了时限。
 */
export function readGateExit(logPath: string, pid: number): GateExit | null {
  try {
    const record = JSON.parse(readFileSync(gateExitPath(logPath), "utf8")) as
      { version?: unknown; pid?: unknown; code?: unknown; elapsedMs?: unknown };
    if (record.version !== 1 || record.pid !== pid || !Number.isSafeInteger(record.code)
      || typeof record.elapsedMs !== "number" || !Number.isFinite(record.elapsedMs) || record.elapsedMs < 0) return null;
    return { code: record.code as number, signal: null, elapsedMs: record.elapsedMs };
  } catch { return null; }
}

/** 这条日志对应的启动器有没有留下退出档（pid 取自启动记录）。在场的 ash 收到退出回调时也先认它。 */
export function recordedGateExit(logPath: string): GateExit | null {
  const pid = readGateLaunch(logPath)?.pid;
  return pid ? readGateExit(logPath, pid) : null;
}

/**
 * ash 重启后，一条库里还是 running 的门禁实际上怎么样了。只读，不发任何信号。
 *
 * 「还在跑」的判据是**身份**（pid + 启动时间）而不是 pid 在不在：pid 被复用时那个号属于别人，
 * 当成我们的去接管，最后要么误杀、要么拿别人的退出去结算。身份读不出来也不算「还在跑」——
 * 落到「被打断」那条老路上，那里的停止逻辑本来就按「核不出身份不发信号」处理。
 */
export function gateRecoveryFate(run: { pid: number | null; pidStartedAt: string | null; logPath: string }): GateFate {
  const pid = run.pid;
  if (!pid || gateTakeoverUnavailable()) return { kind: "lost" };
  const launch = readGateLaunch(run.logPath);
  if (launch?.phase !== "armed" || launch.pid !== pid || !launch.confinementEnrolled
    || !existsSync(gateGoPath(run.logPath)) || existsSync(gateAbortPath(run.logPath))) return { kind: "lost" };
  const exited = (): GateFate | null => {
    const exit = readGateExit(run.logPath, pid);
    return exit ? { kind: "exited", exit } : null;
  };
  // 先认退出档、再看身份、最后**再认一次**：两次读之间它可能刚好写完档退出了。
  return exited()
    ?? (run.pidStartedAt && launch.startedAt === run.pidStartedAt && isSameGateProcess(pid, run.pidStartedAt)
      ? { kind: "running" } : null)
    ?? exited()
    ?? { kind: "lost" };
}

/**
 * 接管之后等它退出。拿到退出档就给退出，启动器没留档就消失了给 null（拿不到真实结果 —— 调用方
 * 按「被打断」收）。`onExit` 回答「结论落库了没有」：没落成（写库临时失败）就接着盯，下一拍拿
 * 同一份结果再交一次，不让一次写失败把它变成没人看着的 running（第 1 轮审查 N2）。
 *
 * 「消失」只认两种证据：pid 不在了，或者 pid 在但启动时间已经是别人的（被复用）。身份**读不出来**
 * 不算消失：一次 ps 抖动就把一条还在跑的命令判成被打断、紧接着收掉它，比多等一秒糟得多。
 *
 * 顺带把监督的持续观察接回来（GateConfinement.resume）：macOS 兼容监督靠轮询记下后代，起跑时
 * 那份轮询随旧 ash 一起没了，不接回来的话接管期间新冒出来的后代就没人记，收尾时认不出它们。
 * 接不回来要说出来（`onResumeFailed`），不能让「已接管」被读成监督也全部恢复了。
 */
export function watchGateExit(opts: { logPath: string; pid: number; startedAt: string;
  onExit: (exit: GateExit | null) => Promise<boolean>; onResumeFailed: (error: unknown) => void }): { stop: () => void } {
  let done = false;
  let busy = false;
  const launch = readGateLaunch(opts.logPath);
  const confinement = launch ? gateConfinement(opts.logPath, launch) : null;
  if (confinement?.resume) void confinement.resume().catch(opts.onResumeFailed);
  const handle = setInterval(() => {
    if (done || busy) return;
    let exit = readGateExit(opts.logPath, opts.pid);
    if (!exit) {
      const current = isPidAlive(opts.pid) ? inspectProcessSync(opts.pid) : null;
      if (isPidAlive(opts.pid) && (!current?.startedAt || current.startedAt === opts.startedAt)) return;
      exit = readGateExit(opts.logPath, opts.pid);
    }
    busy = true;
    void opts.onExit(exit).catch(() => false).then((settled) => {
      busy = false;
      if (settled) { done = true; clearInterval(handle); }
    });
  }, EXIT_POLL_MS);
  handle.unref?.();
  return { stop: () => { done = true; clearInterval(handle); } };
}
