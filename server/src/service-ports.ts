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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";
import { LSOF_PATH, PS_PATH, processAlive, readProcessTableSync } from "./terminal-process-tree.js";

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
 * 正则逐块匹配,这种地址会整条漏掉;更坏的是五位端口先到四位 —— `\b` 把块尾当成合法
 * 结尾,于是记下一个**错的**四位端口,那个端口上住的是别人(第 1 轮审查发现 5)。
 *
 * 所以认端口要在流上做:每块前面接上一截尾巴再匹配,并且**只认已经看到右边界的端口**
 * (端口后面还得有一个非数字字符,或者这一块已经确定不会再接数字)。没看到边界的那一截
 * 留到下一块。实现上:先匹配,再把末尾 SCAN_TAIL_KEEP 个字符留作下一块的前缀,已经吐过的
 * 端口靠 `reported` 去重 —— 重叠区域不会把同一个端口报两遍。
 */
export function createPortScanner(): { feed(chunk: string): number[]; flush(): number[] } {
  let tail = "";
  const reported = new Set<number>();
  /**
   * 接尾巴时在最前面垫一个**主机名字符**。尾巴是从上一块中间切出来的,直接拿 `^` 当左
   * 边界会把 `notlocalhost:8787` 这种切在词中间的字样认成 localhost;垫一个 `x` 之后,
   * 切点落在词里就仍然粘着词,形不成左边界。真正跨块的地址不受影响 —— 地址最长 23 字、
   * 尾巴留 32 字,它自己的左边界字符一定也在尾巴里。
   */
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
  return {
    feed(chunk: string): number[] {
      const text = (tail ? GLUE + tail : "") + chunk;
      tail = text.slice(-SCAN_TAIL_KEEP);
      return scan(text, false);
    },
    /** 流到头了(会话退出):手里那截尾巴按终态再认一遍 —— 地址恰好是最后一个字时才用到。 */
    flush(): number[] {
      if (!tail) return [];
      const text = GLUE + tail;
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
 * 这些号带着这次启动的记号吗。`ps -E` 把**exec 时那份环境**一起打出来,所以双 fork +
 * setsid 的守护进程照样核得到(实测:PPID=1、自成 sid,记号仍在)。
 *
 * 只有当前用户自己的进程读得到环境;root 的进程 `ps -E` 只打命令 —— 那一档记 unknown,
 * 一样不动它。环境值里可能带换行,所以不以行号认记录:以「行首是号」开新记录,其余行
 * 并进上一条。
 */
async function readLineage(pids: number[], token: string): Promise<Map<number, Lineage>> {
  const lineage = new Map<number, Lineage>();
  if (!pids.length) return lineage;
  if (IS_WINDOWS || !PS_PATH || !token) {
    for (const pid of pids) lineage.set(pid, "unknown");
    return lineage;
  }
  let stdout = "";
  try {
    ({ stdout } = await run(PS_PATH, ["-E", "-o", "pid=,command=", "-p", pids.join(",")], { timeout: PROBE_TIMEOUT_MS }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string };
    // 名单里有号已经退出时 ps 退 1,活着的那几条照样打出来 —— 还能用。
    stdout = failure.stdout ?? "";
  }
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

/** 跟这个号同进程组的全部号(含它自己)。进程表拿不到就只认它自己。 */
function groupMembers(holder: PortHolder, selfPgid: number | null): number[] {
  if (holder.pgid <= 1 || holder.pgid === selfPgid) return [holder.pid];
  const table = readProcessTableSync();
  if (!table) return [holder.pid];
  const members = new Set<number>([holder.pid]);
  for (const [pid, pgid] of table.pgidOf) if (pgid === holder.pgid) members.add(pid);
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
  const outcome: PortStopOutcome = { killed: [], spared: [], unknown: [] };
  if (IS_WINDOWS || !LSOF_PATH) return outcome;
  const selfPgid = readProcessTableSync()?.pgidOf.get(process.pid) ?? null;
  const deadline = Date.now() + STOP_DEADLINE_MS;
  const seen = new Set<number>();
  for (const port of ports) {
    if (Date.now() > deadline) { outcome.unknown.push(port); continue; }
    const found = await listeningPids(port);
    if (!found.ok) { outcome.unknown.push(port); continue; }
    for (const pid of found.pids) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (pid === process.pid) continue; // 那是 ash 自己
      const holder = await inspectPid(pid);
      if (!holder) continue; // 刚才还在,现在没了 —— 不用管
      if (selfPgid !== null && holder.pgid === selfPgid) {
        outcome.spared.push({ holder, reason: "那是 ash 自己所在的进程组" });
        continue;
      }
      const members = groupMembers(holder, selfPgid);
      const lineage = await readLineage(members, options.launchToken);
      if (lineage.get(holder.pid) !== "ours") {
        outcome.spared.push({ holder, reason: refusal(lineage.get(holder.pid)) });
        continue;
      }
      // 带记号的同组成员一起收:守护进程常带着自己 fork 的工人(kb-web 里跑着采集器和
      // 向量编码子进程),只杀监听者会留下一地孤儿。**没记号的同组成员不动** ——
      // 进程组不是血缘证据,它只是调度单位(第 1 轮审查)。
      const targets = members.filter((member) => lineage.get(member) === "ours");
      if (await killPids(targets, options.graceMs ?? TERM_GRACE_MS)) outcome.killed.push(holder);
      else outcome.spared.push({ holder, reason: "发了 TERM 和 KILL 都没停下来" });
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
