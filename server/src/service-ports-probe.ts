/**
 * 端口这一档的**查**:谁在听、它是不是这次启动起来的、跟它同组的还有谁。
 *
 * 为什么跟「停」分家:判据(为什么端口只是「上哪儿找」而不是「可以杀」、归属为什么认环境里
 * 那枚记号、「查不到」为什么不等于「没人听」)全写在 `service-ports.ts` 的文件头 —— 那边是
 * 这一档的总纲,读这个文件之前先读它。这边只装「怎么问」:lsof / ps / `/proc` 的平台分支、
 * 三态探测、归属解析。拆开纯粹因为两边加起来早超了单文件 700 行。
 *
 * 这里一个 `kill` 都不发。动手那一半在 `service-ports.ts`。
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";
import { HAS_PROC, LSOF_PATH, PS_PATH, processAlive, readProcessTableSync } from "./terminal-process-tree.js";

const run = promisify(execFile);

/** 这次启动的记号落在哪个环境变量里。命令会话的 env 由 terminal.ts 注入。 */
export const LAUNCH_ID_ENV = "ASH_LAUNCH_ID";

export const PROBE_TIMEOUT_MS = 5_000;

/**
 * 把「剩余预算」翻成 execFile 能用的 timeout。
 *
 * 两件事它必须挡住:**0 在 execFile 里是「不限时」**,所以预算见底时直接传下去等于把闸
 * 拆了,这里压到 1ms(当场超时,调用方按「没答上来」处理 —— 那正是预算用尽该有的结论);
 * 另一头不超过单问上限,免得一次停止把 30 秒全押在一个卡死的 lsof 上。
 *
 * 为什么要有这一层:标称「30 秒总时限」早先只在 stopByPorts 的循环入口看一眼,而 lsof、
 * `ps` 的 pgid/cwd 查询、归属查询各自带着 5 秒的**独立**上限 —— 一个端口上坐着十个住户
 * 就能把总时长翻十倍,外部工具一慢,那把命令锁跟着一起拖(第 2、6 轮审查的非阻塞项)。
 */
export function budgeted(remainingMs: number): number {
  return Math.max(1, Math.min(PROBE_TIMEOUT_MS, Math.floor(remainingMs)));
}

/** 端口此刻的状态。**unknown 是独立一档**,不能折叠成 free(见总纲文件头)。 */
export type PortState = "listening" | "free" | "unknown";

export type PortHolder = {
  pid: number;
  pgid: number;
  command: string;
  cwd: string | null;
  /** 进程启动时刻(由 etime 反推,epoch ms)。只用于回显,不参与授权。 */
  startedAt: number | null;
};

// ── 探端口 ────────────────────────────────────────────────────────────────────

/** 端口探测的结果。`ok:false` = **没答上来**,与「没人听」是两件事(见文件头)。 */
export type PortProbe = { ok: true; pids: number[] } | { ok: false; why: string };

/**
 * 谁在听这个端口(只问 LISTEN,不管已建立的连接 —— 那些是客户端)。
 *
 * `exec` 只为回归留的注入口:真实 lsof 没法按需制造「超时」「用法错」这两种失灵,而
 * 「失灵不许读成端口空了」正是第 1 轮审查 E2 的根因,必须有用例钉住。生产调用一律用默认值。
 */
export async function listeningPids(
  port: number,
  exec: typeof run = run,
  /** 这一问最多花多久。缺省是单问的上限;停止路径传**剩余总预算**(见 budgeted)。 */
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PortProbe> {
  if (IS_WINDOWS) return { ok: false, why: "Windows 上不做端口兜底" };
  if (!LSOF_PATH) return { ok: false, why: "这台机器上找不到 lsof" };
  try {
    const { stdout } = await exec(LSOF_PATH, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: budgeted(timeoutMs) });
    return { ok: true, pids: parsePids(String(stdout)) };
  } catch (error) {
    // lsof 查无此人时退 1 且不吭声 —— 那是「没人听」,不是故障。被超时杀掉(killed)、
    // 起不来(ENOENT)、或者退 1 还带着 stderr(用法/权限错)都算**没答上来**。
    const failure = error as { code?: unknown; killed?: boolean; stderr?: string; stdout?: string; message?: string };
    if (failure.killed) return { ok: false, why: `lsof 查端口 ${port} 超时` };
    if (failure.code === 1 && !(failure.stderr ?? "").trim()) return { ok: true, pids: parsePids(failure.stdout ?? "") };
    return { ok: false, why: `lsof 查端口 ${port} 失败（${failure.stderr?.trim() || failure.message || "未知原因"}）` };
  }
}

function parsePids(stdout: string): number[] {
  return [...new Set(stdout.split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1))];
}

/**
 * 端口这一档**在这台机器上存不存在**。Windows 没有 lsof(也没有等价的「谁在听 + 按环境核
 * 归属」组合),整档短路在 listeningPids 第一行;POSIX 上 lsof 没装也一样。
 *
 * **「这一档不存在」与「这一次问不出来」是两件事**:后者必须当成「可能还在跑」(第 1 轮
 * 审查发现 2 —— 工具失灵被读成端口空了,界面把还在跑的服务说成已停止);前者只说明**这一档
 * 给不出证据**,该让判断落回别的线索。混成一件,Windows 上每条打印过网址的命令就会永远
 * 停不掉也起不动:probePorts 恒为 unknown,于是停止一律 502「状态查不出来」、启动一律
 * alreadyRunning(真机 192.168.1.187 验证前自查发现)。
 */
export const PORT_TIER_AVAILABLE = !IS_WINDOWS && LSOF_PATH !== null;

/**
 * 这些端口上现在还有没有人在听。三态合并的优先级是 **listening > unknown > free**:
 * 有人听就是开着;没人听但有端口没答上来,只能说「不知道」,绝不能报成已经停净。
 *
 * `probe` 同样只为回归留的注入口(见 listeningPids),生产调用用默认值。
 */
export async function probePorts(
  ports: Iterable<number>,
  probe: (port: number) => Promise<PortProbe> = listeningPids,
): Promise<PortState> {
  let unknown = false;
  for (const port of ports) {
    const found = await probe(port);
    if (!found.ok) { unknown = true; continue; }
    if (found.pids.length) return "listening";
  }
  return unknown ? "unknown" : "free";
}

/**
 * 端口上坐着的**是不是这次启动起来的东西**。
 *
 * `PortState` 只回答「有没有人听」,而**生命周期该认的是归属** —— 这两件事被当成一件时,
 * 一条只打印了一行网址的命令(`echo http://127.0.0.1:5173`)会因为别人的 vite 恰好听着
 * 5173 而永远显示「运行中」:启动按钮不给起,停止按钮又停不掉它(那个监听者核不上归属,
 * 一个字都不许动),于是这条命令从此卡死(第 3 轮审查发现 3)。
 *
 * 归属证据与 `stopByPorts` 用的是**同一份**(环境里的启动记号,见文件头):
 *
 *   · `ours`     —— 至少一个监听者带着这次启动的记号:确定还在跑;
 *   · `unknown`  —— 有人听但核不上(lsof 没答上来 / 这条会话没有记号 / 读不到对方环境):
 *                   **不许读成「没在跑」**,保持悲观(文件头那条「查不到不等于没人听」);
 *   · `stranger` —— 有人听,但那个号**核不上是这次的**(带着别次启动的记号,或者一枚记号
 *                   都没有):这次启动在端口这条线索上已经没了 —— 注意这只是**端口这条**
 *                   线索上的结论,不是「已经证明它不是这次的后代」(那是启动闭包那一问,
 *                   环境可复制,见 Lineage 的 `stranger`);
 *   · `free`     —— 没人听。
 *
 * 优先级 **ours > unknown > stranger > free**:一个端口确认是别人的,不能把另一个端口上
 * 核不上的那位一并核销掉。
 */
export type OwnedPortState = "ours" | "unknown" | "stranger" | "free";

export type OwnedPortProbe = {
  state: OwnedPortState;
  /** `unknown` 的由来,原样进给用户看的那句话。其余档为 null。 */
  why: string | null;
};

export async function probeOwnedPorts(
  ports: Iterable<number>,
  token: string | null,
  probe: (port: number) => Promise<PortProbe> = listeningPids,
): Promise<OwnedPortProbe> {
  let ours = false;
  let stranger = false;
  let why: string | null = null;
  for (const port of ports) {
    const found = await probe(port);
    if (!found.ok) { why ??= found.why; continue; }
    const holders = found.pids.filter((pid) => pid !== process.pid);
    if (!holders.length) continue;
    if (!token) {
      why ??= `端口 ${port} 上有人在听，但这条会话没有启动记号（多半是 ash 重启前起的），核不上归属`;
      continue;
    }
    const lineage = await readLineage(holders, token);
    for (const pid of holders) {
      const who = lineage.get(pid);
      if (who === undefined) continue; // 刚才还在,现在没了
      if (who === "ours") ours = true;
      // `unmarked` 在这一问上跟 `stranger` 同义:端口上坐着一个核不上是自己的号,既不许动
      // 它,也不能据此说这次启动还在听(分档的理由只对启动闭包那一问成立,见 Lineage)。
      else if (withoutOurMark(who)) stranger = true;
      else why ??= `端口 ${port} 上的 pid ${pid} ${refusal(who)}`;
    }
  }
  if (ours) return { state: "ours", why: null };
  if (why !== null) return { state: "unknown", why };
  return { state: stranger ? "stranger" : "free", why: null };
}

/** `[[dd-]hh:]mm:ss` → 毫秒。ps 的 etime 与地区无关,比 lstart 好解析(本机是中文 locale)。 */
function elapsedToMs(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60) + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

export type PidInspection =
  | { state: "found"; holder: PortHolder }
  | { state: "gone" }
  | { state: "unknown"; why: string };

function failedInspection(pid: number, why: string): PidInspection {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "gone" };
  }
  return { state: "unknown", why: `pid ${pid} 的进程组没能查清（${why}）` };
}

export async function inspectPid(
  pid: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  exec: typeof run = run,
): Promise<PidInspection> {
  if (IS_WINDOWS || !PS_PATH) return failedInspection(pid, "这台机器上没有可用的 ps");
  try {
    const { stdout } = await exec(PS_PATH, ["-o", "pgid=,etime=,command=", "-p", String(pid)], { timeout: budgeted(timeoutMs) });
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(stdout.split("\n")[0] ?? "");
    if (!match) return failedInspection(pid, "ps 没有返回可识别的进程信息");
    const elapsed = elapsedToMs(match[2]);
    return {
      state: "found",
      holder: {
        pid,
        pgid: Number(match[1]),
        command: match[3].trim(),
        cwd: await processCwd(pid, timeoutMs),
        startedAt: elapsed === null ? null : Date.now() - elapsed,
      },
    };
  } catch (error) {
    return failedInspection(pid, error instanceof Error ? error.message : "ps 查询失败");
  }
}

async function processCwd(pid: number, timeoutMs: number): Promise<string | null> {
  if (!LSOF_PATH) return null;
  try {
    const { stdout } = await run(LSOF_PATH, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: budgeted(timeoutMs) });
    const line = stdout.split("\n").find((row) => row.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

// ── 候选闭包:属主与年龄 ───────────────────────────────────────────────────────

/**
 * 一个号的**非环境**事实。
 *
 * 为什么要单独问这两样:记号那一问(`readLineage`)在 macOS 上有一处天生的盲区 —— `ps -E`
 * 分不出「这份环境本来就是空的」和「这份环境不给你看」,两种都只打出一行光杆命令。早先据
 * 此断言「读不到环境的必然是别人家的号」,被自由审查用一个同用户、`env:{}` + setsid 的工人
 * 当场证伪(uid 跟 ash 相同、PPID=1,`ps -E` 一个变量都不打),于是那个工人被当成陌生人跳
 * 过,停止报了「已停止」而它还在跑。
 *
 * 补救不能靠猜环境,得换**跟环境无关**的两条事实先把候选圈小:
 *
 *  · `uid`   —— 子进程继承属主。属主跟 ash 不同的号不可能是这次启动直接创造的;
 *  · `ageMs` —— 这次启动之前就活着的号不可能带这次的记号:那枚记号是启动时现生成的,它
 *               那会儿还不存在,一个已经在跑的进程也无从把它塞进自己的环境。
 *
 * 圈完之后再读环境,读不出来的就是**真的没问出来**,必须算这一趟没问全。本机实测:同用户
 * 的 PID 1 孤儿有四百多个,其中读不到环境的只有 `loginwindow` 和一个 ssh 复用进程(它把
 * argv/env 区域改写成了自己的标题),两个都远早于任何一次启动 —— 不先按年龄筛,这台机器
 * 上每一次停止都会永远停在「没问全」。
 */
export type ProcessFact = { uid: number; ageMs: number };

/**
 * 这批年龄是**哪个钟**量出来的,读的那一刻那个钟读数是多少,以及读的那一小段时间里这个钟
 * 有没有被拨过。
 *
 * 为什么年龄必须连钟一起交出去(第 6 轮自由审查 F1):「它出生在这次启动之前」要拿候选的年龄
 * 跟「这次启动到现在过了多久」比,两边不是同一个钟,这一比就不构成证明。
 *
 *  · `boot` —— Linux:`/proc/<pid>/stat` 第 22 项与 `/proc/uptime` 都是 CLOCK_BOOTTIME(开机
 *              以来,含休眠,不受校时影响),`nowMs` 就是那次 `/proc/uptime`;
 *  · `wall` —— 其余 POSIX(macOS 的 ps):墙上钟。`ps etime` = `gettimeofday() − p_starttime`
 *              (Apple adv_cmds `print.c` 的 get_etime;`p_starttime` 是 fork 那一刻的墙上钟),
 *              跟启动那一刻取的 `Date.now()` **是同一个钟**,`nowMs` 是 ps 跑完之后的墙上钟。
 *
 * 墙上钟会被拨,可拨在启动之后、扫描之前的那一下对两边同增同减,约掉之后比的就是「出生是否
 * 早于启动取样」(复审第 1 轮指出,上一版把它判成了不同钟,macOS 上每次停止都封不了口)。
 * 拨在**读数之间**的那一下才约不掉:ps 读钟和 `nowMs` 不是同一刻。`steady` 就是那一段量出来
 * 的结论(`wallInStep`),`boot` 恒为 true。
 */
export type FactClock = { domain: "boot" | "wall"; nowMs: number; steady: boolean };
export type ProcessFacts = { facts: Map<number, ProcessFact>; clock: FactClock };

/** 墙上钟与单调钟在同一段时间里各走了多少,差出这么多就算这一段里钟被拨过。etime 只有秒级、
 *  起进程还有几十毫秒的停顿,都远小于这个数;而它又远小于停止扫描的出生宽限(5 秒)。 */
export const CLOCK_STEP_TOLERANCE_MS = 1_000;

/** 本进程的单调钟(毫秒)。 */
export function monoNowMs(): number {
  return process.uptime() * 1000;
}

/** 从 (`wallFrom`, `monoFrom`) 那一刻到现在,墙上钟有没有跟着单调钟一起走 —— 不一致就是这段
 *  时间里钟被拨过(或者机器睡过,单调钟不计休眠),两边的读数之间这一段就配不上。 */
export function wallInStep(wallFrom: number, monoFrom: number): boolean {
  const drift = (Date.now() - wallFrom) - (monoNowMs() - monoFrom);
  return Math.abs(drift) <= CLOCK_STEP_TOLERANCE_MS;
}

/**
 * Linux 的开机时钟此刻读数(毫秒)。给启动那一刻取样用:跟 `/proc/<pid>/stat` 的出生时刻是
 * 同一个钟,所以「这个候选出生在启动之前」在 Linux 上可以被**证明**。没有 `/proc`(macOS)
 * 或者读不动就是 null —— 那台机器上这条证明不存在,不是「证明成立」。
 */
export function bootClockMs(): number | null {
  if (!HAS_PROC) return null;
  try {
    const value = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

/**
 * 查这些号的属主与年龄,连同量年龄用的那个钟(`FactClock`)。
 *
 * 返回 `null` = **这一问本身没答上来**(这台机器上没有可用的 ps、`/proc/uptime` 读不动、
 * ps 超时或起不来)。调用方必须据此判「没问全」,**不许**当成「这些号都不是候选」——
 * 那正是把查询失灵读成否定结论的老毛病。映射里缺某个号 = ps 没打出它那一行;跟
 * `lineageFromPs` 同一个判据:再探一次活,还活着就同样是「没答上来」。
 */
export async function readProcessFacts(
  pids: number[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProcessFacts | null> {
  if (IS_WINDOWS) return null;
  if (HAS_PROC) return procProcessFacts(pids);
  if (!pids.length) return { facts: new Map(), clock: { domain: "wall", nowMs: Date.now(), steady: true } };
  if (!PS_PATH) return null;
  // ps 读钟的那一刻夹在这两次取样之间。「现在」取**跑完之后**那一份:ps 自己的 gettimeofday
  // 不会比它更晚,上界只会偏宽;两次取样之间钟被拨过,ps 那一刻就跟哪份都对不上(`steady`)。
  const wallFrom = Date.now();
  const monoFrom = monoNowMs();
  let read: PsRead;
  try {
    read = { stdout: (await run(PS_PATH, ["-o", "pid=,uid=,etime=", "-p", pids.join(",")], { timeout: budgeted(timeoutMs) })).stdout, trusted: true };
  } catch (error) {
    read = { stdout: psStdout(error), trusted: psAnswered(error) };
  }
  if (!read.trusted) return null;
  const facts = new Map<number, ProcessFact>();
  for (const line of read.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const ageMs = elapsedToMs(match[3]);
    if (ageMs === null) continue;
    facts.set(Number(match[1]), { uid: Number(match[2]), ageMs });
  }
  return { facts, clock: { domain: "wall", nowMs: Date.now(), steady: wallInStep(wallFrom, monoFrom) } };
}

/**
 * Linux 版:属主取 `/proc/<pid>` 这个目录的属主,年龄 = 开机已跑的时长 − stat 的第 22 项
 * (进程启动时刻,单位 USER_HZ —— 内核 ABI 把它固定成 100,不随 CONFIG_HZ 变)。
 * `/proc/uptime` 读不动就是这一问没答上来;单个号读不动一律当它已经退了(stat 是全局可读的,
 * 活着的号不会读不出来)。
 */
function procProcessFacts(pids: number[]): ProcessFacts | null {
  const uptimeMs = bootClockMs();
  if (uptimeMs === null) return null;
  const facts = new Map<number, ProcessFact>();
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      if (!Number.isFinite(ticks)) continue;
      facts.set(pid, { uid: statSync(`/proc/${pid}`).uid, ageMs: Math.max(0, uptimeMs - ticks * 10) });
    } catch { /* 这个号已经退了 */ }
  }
  return { facts, clock: { domain: "boot", nowMs: uptimeMs, steady: true } };
}

/**
 * 这几个号此刻的**工作目录**。拿不到(平台没有 lsof / `/proc`,或者这一问失灵)返回 null
 * —— 跟 `readProcessFacts` 同一个约定:问不出来就别筛,少筛只会让调用方更保守。
 *
 * 为什么要它:cwd 跟属主一样是**继承**来的,而且跟环境变量是两条独立的继承线 —— 启动脚本
 * 给工人现搭一份环境(记号丢了)时,cwd 照旧是从启动那一刻传下来的。所以它能把「这次启动
 * 目录下冒出来的孤儿」跟「系统自己起的那一堆 PID-1 守护进程」分开(实测:本机 10 分钟内
 * 新生的同属主孤儿有 10 个,其中 8 个 cwd 是 `/`)。
 *
 * 跟记号一样,它也是**可变**的:一个 chdir 出去的后代就筛不住了。所以它只用来**收窄候选**,
 * 从不用来宣称「问全了」。
 */
export async function readProcessCwd(
  pids: number[], timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Map<number, string> | null> {
  if (!pids.length) return new Map();
  if (IS_WINDOWS) return null;
  if (HAS_PROC) {
    const cwds = new Map<number, string>();
    for (const pid of pids) {
      try { cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`)); }
      catch { /* 退了,或者不是当前用户的号 */ }
    }
    return cwds;
  }
  if (!LSOF_PATH) return null;
  let stdout: string;
  try {
    stdout = (await run(LSOF_PATH, ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"],
      { timeout: budgeted(timeoutMs) })).stdout;
  } catch (error) {
    // lsof 对「有的号已经退了」也退非零,照样把活着的那几条打出来;超时/起不来则是这一问
    // 失灵,它的沉默什么都证明不了。
    if (!psAnswered(error)) return null;
    stdout = psStdout(error);
  }
  const cwds = new Map<number, string>();
  let current: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) { current = Number(line.slice(1)) || null; continue; }
    if (line.startsWith("n") && current !== null) { cwds.set(current, line.slice(1)); current = null; }
  }
  return cwds;
}

// ── 归属:环境里的那枚记号 ─────────────────────────────────────────────────────

/**
 * 一个号跟这次启动的关系。**两档「核不上」是分开的** —— 它们的成因完全不同,给用户的
 * 说法也不该一样:
 *
 *  · `unmarked`   —— 环境读出来了,里面**一枚 ash 启动记号都没有**。它不是「不是这次的」的
 *    证明:启动脚本完全可以给自己 fork 出去的工人现搭一份环境(`spawn(..., {env:{PATH,…}})`),
 *    那个号是这次启动创造的,只是记号没跟过去(第 2 轮自由审查 F2 真实复现)。端口那一档
 *    把它跟 `stranger` 同等处理(都是「别动它」),启动闭包那一档必须分开 —— 一个是否证,
 *    一个只是没有证据;
 *  · `unknown`    —— 问到了答案,但那份环境读不出来(多半不是当前用户的进程);
 *  · `unverified` —— **根本没问出答案**:ps 超时/起不来,或者它没打出这个号的那一行而这个号
 *    还活着。查询失灵不是「它已经退了」(第 4 轮审查发现 2),所以单独一档。
 *
 * 两档都不动它,也都不许折叠成「不在了」。
 *
 *  · `stranger`   —— 环境读出来了,里面带着**另一次** ash 启动的记号。那枚号码确实是 ash 生成
 *    的,但**环境是可复制的**:启动脚本把上一次启动时存下的环境原样拿来派工人,这个号就带着
 *    旧记号、却确凿是这次创造的(第 4 轮自由审查真实复现)。所以它跟 `unmarked` 一样**只是
 *    没有证据,不是反证** —— 端口那一档据它拒绝动手(没有杀它的凭据),启动闭包那一档据它判
 *    「没问出来」(terminal-launch-survivors.ts 文件头③)。两处都别把它读成「已经证明不是
 *    这次的」。
 */
export type Lineage = "ours" | "stranger" | "unmarked" | "unknown" | "unverified";

export function uncertainLineage(lineage: Lineage | undefined): boolean {
  return lineage === "unknown" || lineage === "unverified";
}

/**
 * 「环境读出来了,里面没有**这次**启动的记号」—— `stranger` 与 `unmarked` 的共同点。
 *
 * 端口那一档只关心这一句:谁都不许动一个核不上是自己的号。两档的区别只对启动闭包那一问
 * 有意义(terminal-launch-survivors.ts),所以那边单独分,这边共用一个谓词,行为与分档
 * 之前逐字节相同。
 */
export function withoutOurMark(lineage: Lineage | undefined): boolean {
  return lineage === "stranger" || lineage === "unmarked";
}

/** 一次 ps 读取的结果。`trusted=false` = 这次问话本身不可信,它的沉默不构成任何结论。 */
type PsRead = { stdout: string; trusted: boolean };

/**
 * 这些号带着这次启动的记号吗。**按平台读环境** —— 这一问没有跨平台的统一写法:
 *
 *  · **Linux**:直接读 `/proc/<pid>/environ`,NUL 分隔、逐项精确比对,没有任何边界启发式;
 *    读得到就是权威答案(有记号 = 这次的,没有 = 不是这次的),`EACCES` 才是「核不上」。
 *  · **macOS/BSD**:没有 `/proc`,只能 `ps -E`(把 exec 时那份环境一起打出来,所以双 fork
 *    + setsid 的守护进程照样核得到:实测 PPID=1、自成 sid,记号仍在)。
 *
 * 原先这一问对**所有**非 Windows 平台都发 `ps -E`。那是 macOS/BSD 的写法,Linux 的
 * procps-ng 直接拒绝它(第 2 轮审查发现 5 容器实测:procps-ng 4.0.2 退 1、stdout 空、
 * stderr `unsupported SysV option`),于是整条归属核验在 Linux 上**恒为失败** —— 默认停止
 * 永远报「核不上归属」,服务一个都停不掉。
 */
export async function readLineage(
  pids: number[],
  token: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Map<number, Lineage>> {
  const shortcut = lineageWithoutPs(pids, token);
  if (shortcut) return shortcut;
  let read: PsRead = { stdout: "", trusted: true };
  try {
    const { stdout } = await run(PS_PATH!, ["-E", "-o", "pid=,command=", "-p", pids.join(",")], { timeout: budgeted(timeoutMs) });
    read = { stdout, trusted: true };
  } catch (error) {
    read = { stdout: psStdout(error), trusted: psAnswered(error) };
  }
  return lineageFromPs(read, pids, token);
}

/**
 * 这次 ps **算不算答上话了**。名单里有号已经退出时 ps 退 1、把活着的那几条照样打出来,
 * 那是它的正常行为,结论可信;超时被杀、进程起不来(`ENOENT`/`EACCES`,错误码是字符串)
 * 则是这次问话本身失灵 —— 它一个字都没说,不能据此宣称任何号「已经退了」。
 */
function psAnswered(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: boolean; signal?: unknown };
  if (failure.killed || failure.signal) return false;
  return typeof failure.code === "number";
}

function psStdout(error: unknown): string {
  return String((error as { stdout?: unknown }).stdout ?? "");
}

/**
 * `readLineage` 的**同步**版。只服务 server 退出那一拍:`process.once("exit")` 里没有
 * await 可用(terminal.ts 的 shutdown 因此整条是同步的),但同步 I/O 照样能跑 —— 判据、
 * 平台分支、解析全与异步版共用一套,只有「怎么问 ps」这一步不同。
 */
export function readLineageSync(pids: number[], token: string): Map<number, Lineage> {
  const shortcut = lineageWithoutPs(pids, token);
  if (shortcut) return shortcut;
  let read: PsRead = { stdout: "", trusted: true };
  try {
    read = {
      stdout: String(execFileSync(PS_PATH!, ["-E", "-o", "pid=,command=", "-p", pids.join(",")], {
        timeout: PROBE_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      })),
      trusted: true,
    };
  } catch (error) {
    read = { stdout: psStdout(error), trusted: psAnswered(error) };
  }
  return lineageFromPs(read, pids, token);
}

/** 这几个号一律记成「核不上」。 */
function unknownLineage(pids: number[]): Map<number, Lineage> {
  return new Map(pids.map((pid) => [pid, "unknown" as Lineage]));
}

/** 不用问 ps 就能给出的答案(含 Linux 的 /proc 权威档)。返回 null = 得去问 ps。 */
function lineageWithoutPs(pids: number[], token: string): Map<number, Lineage> | null {
  if (!pids.length) return new Map();
  if (IS_WINDOWS || !token) return unknownLineage(pids);
  if (HAS_PROC) return lineageFromProc(pids, token);
  if (!PS_PATH) return unknownLineage(pids);
  return null;
}

/**
 * `ps -E` 那坨输出 → 逐号的归属结论。同步/异步两条路共用。
 *
 * **「名单里没有这一行」有两种成因,不能都读成「它已经退了」。** 早先这里是一句
 * `continue`,于是 ps 本身失灵(超时、退非零且一个字没打、输出被截断)时整张表是空的,
 * 上游 `probeOwnedPorts` 把「一个归属都没拿到」读成 free,默认停止于是对着一个还在听
 * 端口的服务返回「已停止」并落 verified —— 第 4 轮审查发现 2 用一个只让 `ps -E` 退非零的
 * 包装器实测到了这条路(服务活着、HTTP 照样应答,界面退回启动按钮)。这跟 lsof 那边
 * 「查不到不等于没人听」是同一条判据,只是换了个工具(文件头第三节)。
 *
 * 所以缺这一行时再问一次内核:**它还活着就是「核不上」**(unverified),确认不在了才当它
 * 退了。这次问话本身不可信
 * (`trusted=false`)时更不必问 —— 它的沉默什么都证明不了。
 */
function lineageFromPs(read: PsRead, pids: number[], token: string): Map<number, Lineage> {
  const lineage = new Map<number, Lineage>();
  const needle = `${LAUNCH_ID_ENV}=${token}`;
  let current: number | null = null;
  const text = new Map<number, string>();
  for (const line of read.stdout.split("\n")) {
    const head = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (head && pids.includes(Number(head[1]))) {
      current = Number(head[1]);
      text.set(current, head[2]);
      continue;
    }
    if (current !== null) text.set(current, `${text.get(current) ?? ""}\n${line}`);
  }
  for (const pid of pids) {
    const body = text.get(pid);
    if (body === undefined) {
      // 没打出这一行:确认不在了才算退出,否则这一问就是没答上来。
      if (read.trusted && !processAlive(pid)) continue;
      lineage.set(pid, "unverified");
      continue;
    }
    const at = body.indexOf(needle);
    if (at >= 0 && (at + needle.length === body.length || /\s/.test(body[at + needle.length]))) {
      lineage.set(pid, "ours");
      continue;
    }
    // 一个 `KEY=` 都没有 = 这条根本没打出环境(不是当前用户的进程),那是「核不上」而不是
    // 「不是我们的」。打出了环境的再分一道:带着**另一次**启动的记号 = 确凿是别人家的
    // (`stranger`);一枚记号都没有 = 没有证据(`unmarked`),它可能是这次启动现搭环境
    // fork 出去的工人。三种都不动它,但说法要诚实。
    if (!/\s[A-Z_][A-Z0-9_]*=/.test(body)) { lineage.set(pid, "unknown"); continue; }
    lineage.set(pid, body.includes(`${LAUNCH_ID_ENV}=`) ? "stranger" : "unmarked");
  }
  return lineage;
}

/**
 * Linux:`/proc/<pid>/environ` 是**精确**的 —— NUL 分隔的 `KEY=VALUE` 列表,不用猜边界。
 * 读失败分两档:`ENOENT` = 这个号已经退出了(不用管),其余(多半 `EACCES`,不是当前用户的
 * 进程)= 核不上。读成功就是权威:有记号就是这次的,没有就**不是**这次的 ——
 * 包括 `env -i` 洗成空环境的那一类(macOS 的 `ps -E` 分不出「空环境」和「不给看」,
 * 只能一律记 unknown;`/proc` 分得出,但两档都不动它,只是说法更准)。
 */
function lineageFromProc(pids: number[], token: string): Map<number, Lineage> {
  const lineage = new Map<number, Lineage>();
  const needle = `${LAUNCH_ID_ENV}=${token}`;
  for (const pid of pids) {
    let environ: string;
    try { environ = readFileSync(`/proc/${pid}/environ`, "utf8"); }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue; // 已经退出了
      lineage.set(pid, "unknown");
      continue;
    }
    const entries = environ.split("\0");
    lineage.set(pid, entries.includes(needle) ? "ours"
      : entries.some((entry) => entry.startsWith(`${LAUNCH_ID_ENV}=`)) ? "stranger" : "unmarked");
  }
  return lineage;
}

/**
 * 跟这个号同进程组的全部号(含它自己)。**同时交接这份清单全不全** —— 退回「只认它自己」
 * 有两种成因,不能都当成「它就是光杆一个」:
 *
 *  · 组号是 0/1 或者就是 ash 自己那组 → 这是**有意**不枚举:那不是血缘,组里坐着一堆无关
 *    进程(文件头)。清单按设计就到这儿,算全的;
 *  · 进程表问不出来(ps 失灵)→ 清单**不全**,「这次启动还有谁」这一问没答上来。把它当成
 *    「没有别人」,同组那个工人就连进不了 leftovers,端口一空就被判停净(第 5 轮审查发现 1)。
 */
export function groupMembers(pid: number, pgid: number, selfPgid: number | null): { members: number[]; complete: boolean } {
  if (pgid <= 1 || pgid === selfPgid) return { members: [pid], complete: true };
  const table = readProcessTableSync();
  if (!table) return { members: [pid], complete: false };
  const members = new Set<number>([pid]);
  for (const [other, group] of table.pgidOf) if (group === pgid) members.add(other);
  // 表本身漏了活着的行(Linux 单个 stat 读失败),这份清单就不全 —— 漏的那一行可能正是同组的。
  return { members: [...members], complete: table.complete };
}

/**
 * **这个进程组现在还有谁** —— 不带种子号。
 *
 * 跟 `groupMembers` 的差别只有一处,但要紧:那个得先有一个活着的号(`inspectPid` 问得出
 * pgid)才能展开,而**动手之后组长通常已经死了**。停止期间新冒出来的成员只认组号这一条
 * 线索(监听者的 TERM handler 现 fork 一个工人,它 ppid 变 1、却留在原来那个组里),所以
 * 重新收集必须按组号直接问进程表。
 *
 * `complete=false` 同义:进程表没答上来,这份清单不全,不许拿它的「没人剩下」当证据。
 */
export function membersOfGroup(pgid: number, selfPgid: number | null): { members: number[]; complete: boolean } {
  // 0/1 号组和 ash 自己那组按设计不枚举(组不是血缘,见总纲文件头) —— 清单到这儿就是全的。
  if (pgid <= 1 || pgid === selfPgid) return { members: [], complete: true };
  const table = readProcessTableSync();
  if (!table) return { members: [], complete: false };
  const members: number[] = [];
  for (const [other, group] of table.pgidOf) if (group === pgid) members.push(other);
  return { members, complete: table.complete };
}

export function refusal(lineage: Lineage | undefined): string {
  if (lineage === "stranger") return `它的环境里带着另一次启动的记号（${LAUNCH_ID_ENV}），没有杀它的归属凭据`;
  if (lineage === "unmarked") return `它的环境里没有这次启动的记号（${LAUNCH_ID_ENV}）`;
  if (lineage === "unverified") return `问不出它的进程环境（ps 没给出这一行，而这个号还活着），核不上是不是这次起来的`;
  return `读不到它的环境（多半不是当前用户的进程），核不上是不是这次起来的`;
}
/** 同步版 lsof。问不出来就当空清单 —— 关服那一拍没有重试余地,也没有调用方可交代。 */
export function listeningPidsSync(port: number): number[] {
  if (!LSOF_PATH) return [];
  try {
    return parsePids(String(execFileSync(LSOF_PATH, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: PROBE_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })));
  } catch (error) {
    return parsePids(String((error as { stdout?: unknown }).stdout ?? ""));
  }
}
