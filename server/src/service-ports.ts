/**
 * 「停止命令留空 = 杀掉启动命令起来的东西」这句承诺的**最后一档**。
 *
 * 前三档按进程归属走(terminal.ts 的 terminate:ppid 树 ∪ ctty/fd 会话成员 ∪ 存续期累积
 * pgid),覆盖前台常驻、`cmd &`、nohup、disown。但**真·守护化**的服务把这三条线索全切了:
 * 双 fork 让 PPID 变成 1、setsid 自成会话与进程组、stdio 重定向进日志文件 —— 从内核角度
 * 它跟那次启动再无瓜葛,macOS 又没有 cgroup/Job Object 这种「整次启动」的容器,按归属**查
 * 不到也就杀不到**(实测 knowledge-base 的 kb.sh daemonize():pid 66464 / PPID 66462 /
 * 自成 sid,启动脚本早退了它还听着 8787)。
 *
 * 于是换一条线索:**这次启动自己打印出来的本机端口**。服务起来都会打一句
 * `http://127.0.0.1:8787`,那是它自报家门,比任何启发式都准。停止时回到那个端口上看谁在听,
 * 核对身份后连它的进程组一起杀。
 *
 * 身份核对是这条路的全部安全性所在(杀错进程不可逆),两条都必须成立才动手:
 *  ① 它的启动时间不早于这次启动 —— 排除「端口本来就被别人占着」;
 *  ② 它的 cwd 在项目目录里 —— 排除 docker 后端、系统服务这类替别人转发端口的住户。
 * 任何一条核不上就**不杀**,原样报给用户看(谁占着、为什么没动它),由他决定要不要配一条
 * 停止命令。宁可停不掉,也不许杀错。
 *
 * 低位端口(<1024)一律不碰:那一档住的是 22/80/443 这类系统服务,误杀代价太大,而开发服务
 * 几乎不会落在那里。Windows 没有 lsof,这一档整个不启用(行为与改动前一致)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";
import { LSOF_PATH, PS_PATH, groupAlive, processAlive, readProcessTableSync } from "./terminal-process-tree.js";

const run = promisify(execFile);

/** 认本机端口:协议和主机名都可省,但必须是本机地址 —— 不然 `foo:3000` 这种字样会误报。 */
const PORT_PATTERN = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{4,5})\b/gi;
const MIN_PORT = 1024;
const TERM_GRACE_MS = 3_000;
const POLL_MS = 100;

export type PortHolder = {
  pid: number;
  pgid: number;
  command: string;
  cwd: string | null;
  /** 进程启动时刻(由 etime 反推,epoch ms)。拿不到记 null —— 核不上身份就不杀。 */
  startedAt: number | null;
};

export type PortStopResult = {
  killed: PortHolder[];
  /** 没动的住户 + 为什么。要如实回给用户,不能悄悄跳过。 */
  spared: { holder: PortHolder; reason: string }[];
};

/** 从一段输出里认出本机端口。只认 ≥1024 的,去重后返回。 */
export function portsFromOutput(text: string): number[] {
  const ports = new Set<number>();
  for (const match of text.matchAll(PORT_PATTERN)) {
    const port = Number(match[1]);
    if (port >= MIN_PORT && port <= 65535) ports.add(port);
  }
  return [...ports];
}

/** 这些端口上现在还有没有人在听。任何一个有人听就算「服务还开着」。 */
export async function anyPortListening(ports: Iterable<number>): Promise<boolean> {
  for (const port of ports) if ((await listeningPids(port)).length) return true;
  return false;
}

/** 谁在听这个端口(只问 LISTEN,不管已建立的连接 —— 那些是客户端)。 */
export async function listeningPids(port: number): Promise<number[]> {
  if (IS_WINDOWS || !LSOF_PATH) return [];
  try {
    const { stdout } = await run(LSOF_PATH, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 });
    return [...new Set(stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 1))];
  } catch { return []; } // lsof 查无此人时退 1,不是错误
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
    const { stdout } = await run(PS_PATH, ["-o", "pgid=,etime=,command=", "-p", String(pid)], { timeout: 5_000 });
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
    const { stdout } = await run(LSOF_PATH, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5_000 });
    const line = stdout.split("\n").find((row) => row.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * 停掉占着这些端口、且确实是这次启动起来的进程。`since` 给一点宽限:服务打印端口与它
 * 真正 listen 之间有先后,会话 startedAt 本身也可能比子进程晚几十毫秒。
 */
export async function stopByPorts(
  ports: Iterable<number>,
  options: { cwd: string; since: number; graceMs?: number },
): Promise<PortStopResult> {
  const result: PortStopResult = { killed: [], spared: [] };
  if (IS_WINDOWS || !LSOF_PATH) return result;
  const selfPgid = readProcessTableSync()?.pgidOf.get(process.pid) ?? null;
  const seen = new Set<number>();
  for (const port of ports) {
    for (const pid of await listeningPids(port)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const holder = await inspectPid(pid);
      if (!holder) continue; // 刚才还在,现在没了 —— 不用管
      const reason = refuseReason(holder, options, selfPgid);
      if (reason) { result.spared.push({ holder, reason }); continue; }
      if (await killHolder(holder, options.graceMs ?? TERM_GRACE_MS)) result.killed.push(holder);
      else result.spared.push({ holder, reason: "发了 TERM 和 KILL 都没停下来" });
    }
  }
  return result;
}

function refuseReason(holder: PortHolder, options: { cwd: string; since: number }, selfPgid: number | null): string | null {
  if (holder.pid === process.pid || (selfPgid !== null && holder.pgid === selfPgid)) return "那是 ash 自己";
  if (holder.startedAt === null) return "查不到它的启动时间,核不上是不是这次起的";
  if (holder.startedAt < options.since - 5_000) return "它比这次启动还早,不是这次起来的";
  if (!holder.cwd) return "查不到它的工作目录,核不上是不是这个项目的";
  if (!inside(options.cwd, holder.cwd)) return `它的工作目录是 ${holder.cwd},不在这个项目里`;
  return null;
}

/**
 * 杀整个进程组而不只是那一个 pid:守护进程常带着自己 fork 的工人(kb-web 里跑着采集器和
 * 向量编码子进程),只杀监听者会留下一地孤儿。pgid 不可信(<=1 或就是自己)时退回杀 pid。
 */
async function killHolder(holder: PortHolder, graceMs: number): Promise<boolean> {
  const target = holder.pgid > 1 ? -holder.pgid : holder.pid;
  const alive = () => (holder.pgid > 1 ? groupAlive(holder.pgid) : processAlive(holder.pid));
  try { process.kill(target, "SIGTERM"); } catch { return !alive(); }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  try { process.kill(target, "SIGKILL"); } catch { /* 它自己先走了 */ }
  const killDeadline = Date.now() + graceMs;
  while (Date.now() < killDeadline) {
    if (!alive()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !alive();
}
