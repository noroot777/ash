/**
 * 会话事实的**投影**:一条内存里的会话,对外是什么样(`sessionInfo`),以及三个一锤定音的
 * 判据 —— 「还有东西在跑吗」(`sessionRunning`)、「这条记录还得留着吗」(`retainHistory`)、
 * 「进程还活着吗」(`sessionAlive`)。
 *
 * 从 TerminalSessionManager 里搬出来的理由只有一个:**它们一个字都不碰会话表**(只读一个
 * session 对象),而管理器那边是调度 —— 两件事混在一份文件里,那份文件就越过 700 行上限。
 * 判据本身是整套停止/幂等语义的核心,所以每一条的「为什么」原样跟着搬过来了。
 *
 * 形状在 terminal-session-facts.ts,杀进程在 terminal-session-kill.ts,观测在
 * terminal-session-watch.ts,调度在 terminal.ts。
 */
import { groupAlive } from "./terminal-process-tree.js";
import { liveLeftovers, projectStop } from "./terminal-stop-facts.js";
import type { TerminalSession, TerminalSessionInfo } from "./terminal-session-facts.js";

/**
 * 一条会话最多记这么多个本机端口。停止那一档是逐个端口问 lsof 的,一条嘴碎的启动脚本
 * (测试输出、日志回放)不该把那次停止拖成几十次外部调用。先到先记 —— 服务自报家门
 * 几乎总在最前面。
 */
const MAX_LAUNCH_PORTS = 8;

export function sessionInfo(session: TerminalSession): TerminalSessionInfo {
  const { id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode } = session;
  return {
    id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode,
    // 派生,不存:「有没有人要求停过」是 stop 的投影,两份就会漂(见 StopFact 的注释)。
    stoppedByUser: session.stop.kind !== "none",
    // 即时探测,不是缓存值:组长退没退(exitCode)和组里有没有活人是两件事。
    groupAlive: sessionAlive(session),
    ports: [...session.launchPorts],
    // 这个只能是缓存值:问端口要跑 lsof,不能挂在每次 info() 上(列表接口一次几十条)。
    portsAlive: session.portsAlive,
    portUncertain: session.portUncertain ?? false,
    running: sessionRunning(session),
    stop: projectStop(session.stop),
    abandoned: session.abandoned ?? null,
    portsTruncated: session.portsTruncated,
  };
}

/**
 * 记下这次启动打印的端口(有上限 —— 一条疯狂刷端口的输出不该把内存和每次停止的 lsof
 * 预算吃光)。只在命令会话上调。
 *
 * **溢出要记账**:超额丢掉的那些是「没能收进来的线索」,不是「不存在的线索」。丢过就把
 * portsTruncated 立起来,停止那一档据此拒绝从「记下的端口都空了」推出「全停了」
 * (第 2 轮审查发现 2 的同一类:未核验的候选不许凭端口空闲核销)。
 */
export function recordPorts(session: TerminalSession, ports: number[]): void {
  for (const port of ports) {
    if (session.launchPorts.has(port)) continue;
    if (session.launchPorts.size >= MAX_LAUNCH_PORTS) { session.portsTruncated = true; continue; }
    session.launchPorts.add(port);
  }
}

/**
 * 这条会话名下**还有东西在跑吗** —— 整个生命周期(start 的幂等门、stop/restart、容量、
 * 同命令旧记录清理、闲置回收、前端那颗按钮)都认这一个口径。
 *
 * 进程归属(sessionAlive)之外多一档:**它打印过的端口还有人在听**。真·守护化的服务从
 * ppid/ctty/pgid 三条线索里全逃了,只剩端口这一条 —— 少了这一档就会出现「停止接口认为
 * 它开着、启动接口认为它没开」,于是同一个服务被起第二份(第 1 轮审查发现 3)。
 */
export function sessionRunning(session: TerminalSession): boolean {
  // 显式放弃过的一律不算「还在跑」:这一格的全部用途就是解除悲观判据造成的死局
  // (端口归属核不上 ⇒ 起不动也停不掉也删不掉,terminal-abandon.ts 文件头)。注意它
  // **不改 stop 账** —— 「还有什么活着」照旧看 `abandoned`/`stop`,只有「ash 还管不管它」
  // 认这一格。
  if (session.abandoned) return false;
  return sessionAlive(session) || session.portsAlive || session.portUncertain === true || liveLeftovers(session.stop).length > 0;
}

export function retainHistory(session: TerminalSession): boolean {
  // 同上:删除保护是「这条记录是触达残留进程的唯一把手」换来的,用户亲手放弃了这个把手,
  // 保护就跟着解除(关日志标签、删项目都不再被它拦下)。
  if (session.abandoned) return false;
  return projectStop(session.stop).kind === "unresolved";
}

/**
 * 这条会话是否还有活着的进程:组长没退,或组长退了但同组子进程还在(daemonize 形状),
 * 或 job-control 后台作业在累积的独立组里还活着 —— 少最后这一条,shell exit 后独立组的
 * 后台作业会被 sweeper 当死透会话回收,连同累积快照一起丢,那些进程就彻底失控
 * (第 2 轮自由审查实锤)。
 */
export function sessionAlive(session: TerminalSession): boolean {
  if (session.exitCode === null || groupAlive(session.process.pid)) return true;
  for (const pgid of session.descendantPgids) if (groupAlive(pgid)) return true;
  return false;
}
