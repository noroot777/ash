/**
 * 「停止命令留空 = 杀掉启动命令起来的东西」这句承诺的**最后一档**。
 *
 * 前三档按进程归属走(terminal-session-kill.ts 的 terminateSession:ppid 树 ∪ ctty/fd
 * 会话成员 ∪ 存续期累积 pgid),覆盖前台常驻、`cmd &`、nohup、disown。但**真·守护化**的
 * 服务把这三条线索全切了:双 fork 让 PPID 变成 1、setsid 自成会话与进程组、stdio 重定向
 * 进日志文件 —— 从内核角度它跟那次启动再无瓜葛,macOS 又没有 cgroup/Job Object 这种
 * 「整次启动」的容器(executors/kernel-confine.ts 在这台机器上直接弃权),按归属**查不到
 * 也就杀不到**(实测 knowledge-base 的 kb.sh daemonize():pid 66464 / PPID 66462 / 自成
 * sid,启动脚本早退了它还听着 8787)。
 *
 * 于是换一条线索:**这次启动自己打印出来的本机端口**。服务起来都会打一句
 * `http://127.0.0.1:8787`,那是它自报家门,比任何启发式都准。
 *
 * ── 端口只是「上哪儿找」,不是「可以杀」 ─────────────────────────────────────────
 *
 * 这一点第 1 轮自由审查用实测钉死过(E1):只凭「cwd 在项目里 + 启动时间不比这次早」就
 * 授权终止,等于把「最近在同一个目录里跑过」当成血缘 —— 探针在同一目录另起一个无关服务
 * 占住那个端口,点停止就把它杀了。端口会被复用、会被另一个终端抢去、同项目可以同时跑两个
 * 服务,这三种都落在那个窗口里,而杀错进程不可逆。
 *
 * 所以归属证据换成**环境继承**:启动命令会话的 env 里带一枚这次启动独有的随机记号
 * (`ASH_LAUNCH_ID`,terminal.ts 注入),凡是这次启动 fork 出来的进程都带着它,**双 fork +
 * setsid 也洗不掉**(实测:PPID=1、自成 sid 的守护进程,`ps -E` 里那枚记号照旧在)。于是
 * 「它是不是这次起来的」有了一条**可核验**的判据,而不是时间窗口的推断:
 *
 *   · 记号对得上      → 这就是这次启动的后代,可以动手(连同它同组的、同样带记号的工人);
 *   · 环境里没有记号  → 不是这次起来的,**一根汗毛都不许动**,原样报给用户;
 *   · 环境读不出来    → 核不上(多半不是当前用户的进程),同样不动。
 *
 * 这条判据的已知空洞也写明:后代自己 `env -i` 洗掉环境再 exec,记号就断了 —— 那种进程我们
 * 认不出来,于是**停不掉**(报给用户让他配一条停止命令),而不是扩大授权去猜。
 * `executors/kernel-confine.ts` 顶部那张表列的就是这几类线索各自的断点。
 *
 * 另外两道硬闸不变:ash 自己的进程/进程组永不碰;低位端口(<1024)一律不碰 —— 那一档住的
 * 是 22/80/443 这类系统服务,而开发服务几乎不会落在那里。Windows 没有 lsof,这一档整个不
 * 启用(行为与改动前一致)。
 *
 * ── 「查不到」不等于「没人听」 ───────────────────────────────────────────────────
 *
 * lsof 查无此人(退 1、空输出)和 lsof 自己坏了/超时是两件事,早先全被 catch 成空数组,
 * 于是「工具失灵」会被读成「端口空了 = 已经停净」(第 1 轮审查 E2)。所以探测一律三态:
 * `listening` / `free` / `unknown`,**unknown 不许当 free 用** —— 调用方据此拒绝宣称已停止。
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";
import { HAS_PROC, LSOF_PATH, PS_PATH, processAlive, readProcessTableSync } from "./terminal-process-tree.js";

const run = promisify(execFile);

/** 这次启动的记号落在哪个环境变量里。命令会话的 env 由 terminal.ts 注入。 */
export const LAUNCH_ID_ENV = "ASH_LAUNCH_ID";

const MIN_PORT = 1024;
const TERM_GRACE_MS = 3_000;
const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 5_000;
/** 一次 stopByPorts 的总时限:端口是逐个问 lsof 的,不能让一次停止无上限地拖着那把命令锁。 */
const STOP_DEADLINE_MS = 30_000;

/** 端口此刻的状态。**unknown 是独立一档**,不能折叠成 free(见文件头)。 */
export type PortState = "listening" | "free" | "unknown";

export type PortHolder = {
  pid: number;
  pgid: number;
  command: string;
  cwd: string | null;
  /** 进程启动时刻(由 etime 反推,epoch ms)。只用于回显,不参与授权。 */
  startedAt: number | null;
};

export type PortStopOutcome = {
  killed: PortHolder[];
  /** 没动的住户 + 为什么。要如实回给用户,不能悄悄跳过。 */
  spared: { holder: PortHolder; reason: string }[];
  /** 探测没答上来的端口:既不能说它空了,也没人可杀。 */
  unknown: number[];
  /**
   * 动过手的进程组里**核不上归属、所以一个字都没动**的成员(此刻仍活着的那些)。
   *
   * 早先这些号是被 `filter` 静默丢掉的,于是「这几个端口让出来了」被升级成「这次启动起来
   * 的东西都停了」(第 2 轮审查发现 2 实测:监听者被收掉、端口 free、界面显示已停止,而同组
   * 那个 `env -i` 洗掉环境的采集 worker 还在跑)。不杀它是对的 —— 没有归属凭据;**但不能
   * 顺手把它从账上划掉**:它是一笔没核销的责任,要原样报给用户。
   */
  leftovers: { pid: number; reason: string }[];
};

// ── 认端口 ────────────────────────────────────────────────────────────────────

/**
 * 本机地址 + 端口。主机名左边界必须是「非主机名字符」,否则 `notlocalhost:8787` 这种
 * 字样会被当成 localhost(第 1 轮审查)。协议可省 —— 很多脚本只打 `localhost:5173`。
 */
const PORT_PATTERN = /(?:^|[^0-9a-z.-])(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{4,5})(?![0-9])/gi;
/**
 * 增量扫描时在手里留多长的尾巴:够装下「最长的本机地址前缀 + 5 位端口」就行
 * (`https://127.0.0.1:` 是 18 字,`[::1]` 那支更短)。
 */
const SCAN_TAIL_KEEP = 32;

/** 从一段**完整**文本里认出本机端口。只认 ≥1024 的,去重后返回。 */
export function portsFromOutput(text: string): number[] {
  const ports = new Set<number>();
  for (const match of text.matchAll(PORT_PATTERN)) {
    const port = Number(match[1]);
    if (port >= MIN_PORT && port <= 65535) ports.add(port);
  }
  return [...ports];
}

/**
 * pty 的输出是**流**,不是一行一行的消息:`http://127.0.0.1:8787` 完全可能被拆成
 * `http://127.0.0.` + `1:8787` 两块送来(启动器分次 write,或底层按缓冲区切)。拿无状态
 * 正则逐块匹配,这种地址会整条漏掉;更坏的是五位端口先到四位 —— 块尾被当成合法结尾,
 * 于是记下一个**错的**四位端口,那个端口上住的是别人(第 1 轮审查发现 5)。
 *
 * 所以认端口要在流上做,不变量是一句话:**无论怎么切,feed 串联 + flush 的结果必须与
 * 把整条文本一次喂进 `portsFromOutput` 完全一致**。为此有两件事:
 *
 *  ① **只认已经看到右边界的端口**(端口后面还得有一个非数字字符,或者流已经到头),
 *     没看到边界的那一截留给下一块;
 *  ② 接尾巴时**只在尾巴确实被截断过时**才在最前面垫一个主机名字符。垫片是为了压住
 *     「从词中间切出来的尾巴被 `^` 当成左边界」——`notlocalhost:8787` 切在 `notloc` /
 *     `alhost:8787` 之间,拼回去必须仍然不是本机地址。但**尾巴就是流的起点**时,那个
 *     `^` 是真的:无条件垫片反过来伪造了一个本来不存在的主机名前缀,于是启动脚本只打
 *     `localhost:8787` 就整条漏掉(第 2 轮审查发现 4 实测:`portsFromOutput` 给
 *     `[8787]`,同一段文本 feed+flush 给 `[]`;`127.0.0.1` / `0.0.0.0` / `[::1]` 同样)。
 *     所以记一笔「尾巴前面有没有丢掉过字符」,丢过才垫。
 */
export function createPortScanner(): { feed(chunk: string): number[]; flush(): number[] } {
  /** 上一块留下的尾巴(**不含垫片**)。 */
  let tail = "";
  /** 这截尾巴前面已经丢掉过字符吗 —— 丢过,它的开头就不是流的起点,`^` 不算左边界。 */
  let truncated = false;
  const reported = new Set<number>();
  /** 垫片:一个主机名字符,把假的左边界压掉(只在 truncated 时用)。 */
  const GLUE = "x";
  const scan = (text: string, final: boolean): number[] => {
    const fresh: number[] = [];
    for (const match of text.matchAll(PORT_PATTERN)) {
      const port = Number(match[1]);
      if (port < MIN_PORT || port > 65535) continue;
      // 端口紧挨着文本末尾 = 右边界还没到:它可能是 8787 也可能是 87870,留给下一块。
      // flush 时没有下一块了,末尾就是终态。
      if (!final && (match.index ?? 0) + match[0].length >= text.length) continue;
      if (reported.has(port)) continue; // 重叠的尾巴会再次匹配到同一个端口
      reported.add(port);
      fresh.push(port);
    }
    return fresh;
  };
  /** 把尾巴接上这一块,顺手把「有没有丢过字符」更新到接完之后的状态。 */
  const join = (chunk: string): string => {
    const glue = truncated && tail ? GLUE : "";
    const text = glue + tail + chunk;
    const kept = Math.min(SCAN_TAIL_KEEP, text.length - glue.length);
    truncated = truncated || text.length - glue.length > SCAN_TAIL_KEEP;
    tail = text.slice(text.length - kept); // kept ≤ 真实长度,所以绝不会把垫片留进尾巴
    return text;
  };
  return {
    feed(chunk: string): number[] {
      return scan(join(chunk), false);
    },
    /** 流到头了(会话退出):手里那截尾巴按终态再认一遍 —— 地址恰好是最后一个字时才用到。 */
    flush(): number[] {
      if (!tail) return [];
      const text = (truncated ? GLUE : "") + tail;
      tail = "";
      return scan(text, true);
    },
  };
}

// ── 探端口 ────────────────────────────────────────────────────────────────────

/** 端口探测的结果。`ok:false` = **没答上来**,与「没人听」是两件事(见文件头)。 */
export type PortProbe = { ok: true; pids: number[] } | { ok: false; why: string };

/**
 * 谁在听这个端口(只问 LISTEN,不管已建立的连接 —— 那些是客户端)。
 *
 * `exec` 只为回归留的注入口:真实 lsof 没法按需制造「超时」「用法错」这两种失灵,而
 * 「失灵不许读成端口空了」正是第 1 轮审查 E2 的根因,必须有用例钉住。生产调用一律用默认值。
 */
export async function listeningPids(port: number, exec: typeof run = run): Promise<PortProbe> {
  if (IS_WINDOWS) return { ok: false, why: "Windows 上不做端口兜底" };
  if (!LSOF_PATH) return { ok: false, why: "这台机器上找不到 lsof" };
  try {
    const { stdout } = await exec(LSOF_PATH, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: PROBE_TIMEOUT_MS });
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
 *   · `stranger` —— 有人听,而且**核实了不是这次起来的**:这次启动在端口这条线索上已经没了;
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
      else if (who === "stranger") stranger = true;
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

export async function inspectPid(pid: number): Promise<PortHolder | null> {
  if (IS_WINDOWS || !PS_PATH) return null;
  try {
    const { stdout } = await run(PS_PATH, ["-o", "pgid=,etime=,command=", "-p", String(pid)], { timeout: PROBE_TIMEOUT_MS });
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(stdout.split("\n")[0] ?? "");
    if (!match) return null;
    const elapsed = elapsedToMs(match[2]);
    return {
      pid,
      pgid: Number(match[1]),
      command: match[3].trim(),
      cwd: await processCwd(pid),
      startedAt: elapsed === null ? null : Date.now() - elapsed,
    };
  } catch { return null; }
}

async function processCwd(pid: number): Promise<string | null> {
  if (!LSOF_PATH) return null;
  try {
    const { stdout } = await run(LSOF_PATH, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: PROBE_TIMEOUT_MS });
    const line = stdout.split("\n").find((row) => row.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

// ── 归属:环境里的那枚记号 ─────────────────────────────────────────────────────

/** 一个号跟这次启动的关系。`unknown` = 环境读不出来(多半不是当前用户的进程)。 */
type Lineage = "ours" | "stranger" | "unknown";

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
async function readLineage(pids: number[], token: string): Promise<Map<number, Lineage>> {
  const shortcut = lineageWithoutPs(pids, token);
  if (shortcut) return shortcut;
  let stdout = "";
  try {
    ({ stdout } = await run(PS_PATH!, ["-E", "-o", "pid=,command=", "-p", pids.join(",")], { timeout: PROBE_TIMEOUT_MS }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string };
    // 名单里有号已经退出时 ps 退 1,活着的那几条照样打出来 —— 还能用。
    stdout = failure.stdout ?? "";
  }
  return lineageFromPs(stdout, pids, token);
}

/**
 * `readLineage` 的**同步**版。只服务 server 退出那一拍:`process.once("exit")` 里没有
 * await 可用(terminal.ts 的 shutdown 因此整条是同步的),但同步 I/O 照样能跑 —— 判据、
 * 平台分支、解析全与异步版共用一套,只有「怎么问 ps」这一步不同。
 */
function readLineageSync(pids: number[], token: string): Map<number, Lineage> {
  const shortcut = lineageWithoutPs(pids, token);
  if (shortcut) return shortcut;
  let stdout = "";
  try {
    stdout = String(execFileSync(PS_PATH!, ["-E", "-o", "pid=,command=", "-p", pids.join(",")], {
      timeout: PROBE_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch (error) {
    stdout = String((error as { stdout?: unknown }).stdout ?? "");
  }
  return lineageFromPs(stdout, pids, token);
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

/** `ps -E` 那坨输出 → 逐号的归属结论。同步/异步两条路共用。 */
function lineageFromPs(stdout: string, pids: number[], token: string): Map<number, Lineage> {
  const lineage = new Map<number, Lineage>();
  const needle = `${LAUNCH_ID_ENV}=${token}`;
  let current: number | null = null;
  const text = new Map<number, string>();
  for (const line of stdout.split("\n")) {
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
    if (body === undefined) continue; // 已经退出了,不用管
    const at = body.indexOf(needle);
    if (at >= 0 && (at + needle.length === body.length || /\s/.test(body[at + needle.length]))) {
      lineage.set(pid, "ours");
      continue;
    }
    // 一个 `KEY=` 都没有 = 这条根本没打出环境(不是当前用户的进程),那是「核不上」而不是
    // 「不是我们的」。两种都不动它,但说法要诚实。
    lineage.set(pid, /\s[A-Z_][A-Z0-9_]*=/.test(body) ? "stranger" : "unknown");
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
    lineage.set(pid, environ.split("\0").includes(needle) ? "ours" : "stranger");
  }
  return lineage;
}

/** 跟这个号同进程组的全部号(含它自己)。进程表拿不到就只认它自己。 */
function groupMembers(pid: number, pgid: number, selfPgid: number | null): number[] {
  if (pgid <= 1 || pgid === selfPgid) return [pid];
  const table = readProcessTableSync();
  if (!table) return [pid];
  const members = new Set<number>([pid]);
  for (const [other, group] of table.pgidOf) if (group === pgid) members.add(other);
  return [...members];
}

// ── 停 ────────────────────────────────────────────────────────────────────────

/**
 * 停掉占着这些端口、**且带着这次启动记号**的进程。记号核不上的一律不动,原样回给调用方
 * 去告诉用户 —— 宁可停不掉,也不许杀错。
 */
export async function stopByPorts(
  ports: Iterable<number>,
  options: { launchToken: string; graceMs?: number },
): Promise<PortStopOutcome> {
  const outcome: PortStopOutcome = { killed: [], spared: [], unknown: [], leftovers: [] };
  if (IS_WINDOWS || !LSOF_PATH) return outcome;
  const selfPgid = readProcessTableSync()?.pgidOf.get(process.pid) ?? null;
  // **整个动作共用一份预算**:逐端口、每个住户的 inspect/readLineage、TERM/KILL 的等待
  // 全从这里扣。只在外层逐端口时看一眼的话,一个端口上坐着十个住户就能把标称总时限翻十倍
  // (第 2 轮审查的非阻塞项)。
  const deadline = Date.now() + STOP_DEADLINE_MS;
  const left = () => deadline - Date.now();
  const seen = new Set<number>();
  for (const port of ports) {
    if (left() <= 0) { outcome.unknown.push(port); continue; }
    const found = await listeningPids(port);
    if (!found.ok) { outcome.unknown.push(port); continue; }
    for (const pid of found.pids) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (pid === process.pid) continue; // 那是 ash 自己
      if (left() <= 0) { outcome.unknown.push(port); break; }
      const holder = await inspectPid(pid);
      if (!holder) continue; // 刚才还在,现在没了 —— 不用管
      if (selfPgid !== null && holder.pgid === selfPgid) {
        outcome.spared.push({ holder, reason: "那是 ash 自己所在的进程组" });
        continue;
      }
      const members = groupMembers(holder.pid, holder.pgid, selfPgid);
      const lineage = await readLineage(members, options.launchToken);
      if (lineage.get(holder.pid) !== "ours") {
        outcome.spared.push({ holder, reason: refusal(lineage.get(holder.pid)) });
        continue;
      }
      // 带记号的同组成员一起收:守护进程常带着自己 fork 的工人(kb-web 里跑着采集器和
      // 向量编码子进程),只杀监听者会留下一地孤儿。**没记号的同组成员不动** ——
      // 进程组不是血缘证据,它只是调度单位(第 1 轮审查)。
      const targets = members.filter((member) => lineage.get(member) === "ours");
      const grace = Math.max(0, Math.min(options.graceMs ?? TERM_GRACE_MS, left()));
      if (await killPids(targets, grace)) outcome.killed.push(holder);
      else outcome.spared.push({ holder, reason: "发了 TERM 和 KILL 都没停下来" });
      // **没核销的责任要留在账上**:同组里核不上归属的那几个,杀完之后还活着就记下来。
      // 把它们静默丢掉,等于拿「端口空了」核销了「这次启动起来的东西都停了」。
      for (const member of members) {
        if (member === holder.pid || lineage.get(member) === "ours") continue;
        if (!processAlive(member)) continue;
        outcome.leftovers.push({ pid: member, reason: refusal(lineage.get(member)) });
      }
    }
  }
  return outcome;
}

function refusal(lineage: Lineage | undefined): string {
  if (lineage === "stranger") return `它的环境里没有这次启动的记号（${LAUNCH_ID_ENV}），不是这次起来的`;
  return `读不到它的环境（多半不是当前用户的进程），核不上是不是这次起来的`;
}

/** TERM → 等 → KILL → 等。逐个号发,不打整组 —— 组里可能坐着与这次启动无关的进程。 */
async function killPids(pids: number[], graceMs: number): Promise<boolean> {
  const alive = () => pids.some((pid) => processAlive(pid));
  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    for (const pid of pids) {
      try { process.kill(pid, sig); } catch { /* 已经走了 */ }
    }
  };
  if (!alive()) return true;
  signal("SIGTERM");
  if (await waitGone(alive, graceMs)) return true;
  signal("SIGKILL");
  return await waitGone(alive, graceMs);
}

async function waitGone(alive: () => boolean, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (!alive()) return true;
    if (Date.now() >= deadline) return !alive();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * 端口这一档的**同步**收口:只给 server 退出那一拍用。
 *
 * `process.once("exit")` 里不能 await(信号处理器直接 `process.exit()`,见 singleton.ts
 * 的 installCleanup),所以关服清场整条是同步的 —— `killAllSessionTrees` 同步连发
 * TERM+KILL 就是这个缘故。端口这一档被漏在外面时,关服会把会话表连 launchToken 一起丢掉,
 * 而真·守护化的服务只认这一条线索:ash 再起来,它还听着那个端口、却**再没有任何把手能停
 * 它**(第 3 轮审查发现 2)。
 *
 * 判据与异步版逐字一致(带记号的才动,没记号/核不上的一根汗毛都不碰),区别只有两处:
 * 同步问 lsof/ps,以及**不等宽限** —— 退出那一拍没有「等 3 秒」这种预算,TERM 与 KILL
 * 连发(同 killAllSessionTrees)。
 */
export function stopByPortsSync(
  ports: Iterable<number>,
  token: string,
): { killed: number[]; spared: number[] } {
  const result: { killed: number[]; spared: number[] } = { killed: [], spared: [] };
  if (IS_WINDOWS || !LSOF_PATH || !token) return result;
  const table = readProcessTableSync();
  const selfPgid = table?.pgidOf.get(process.pid) ?? null;
  const seen = new Set<number>();
  for (const port of ports) {
    if (port < MIN_PORT) continue;
    for (const pid of listeningPidsSync(port)) {
      if (seen.has(pid) || pid === process.pid) continue;
      seen.add(pid);
      const pgid = table?.pgidOf.get(pid) ?? 0;
      if (selfPgid !== null && pgid === selfPgid) { result.spared.push(pid); continue; }
      const members = groupMembers(pid, pgid, selfPgid);
      const lineage = readLineageSync(members, token);
      const targets = members.filter((member) => lineage.get(member) === "ours");
      if (!targets.length) { result.spared.push(pid); continue; }
      for (const target of targets) {
        try { process.kill(target, "SIGTERM"); } catch { /* 已经走了 */ }
        try { process.kill(target, "SIGKILL"); } catch { /* 已经走了 */ }
      }
      result.killed.push(...targets);
    }
  }
  return result;
}

/** 同步版 lsof。问不出来就当空清单 —— 关服那一拍没有重试余地,也没有调用方可交代。 */
function listeningPidsSync(port: number): number[] {
  if (!LSOF_PATH) return [];
  try {
    return parsePids(String(execFileSync(LSOF_PATH, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: PROBE_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })));
  } catch (error) {
    return parsePids(String((error as { stdout?: unknown }).stdout ?? ""));
  }
}
