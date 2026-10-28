import { basename } from "node:path";
import * as pty from "node-pty";
import { SERVICE_COMMAND_ID } from "@ash/shared/project-commands";
import { IS_WINDOWS } from "./platform.js";
import { createPortScanner, LAUNCH_ID_ENV } from "./service-ports.js";
import { id } from "./util.js";
import {
  containmentAvailable,
  groupAlive,
  TTY_COMMAND_WRAPPER,
  TTY_REAPER_WRAPPER,
} from "./terminal-process-tree.js";
import {
  applyStop,
  liveLeftovers,
  projectStop,
  oweLeftovers,
  releaseLaunchPortsSync,
  releaseLaunchResponsibility,
} from "./terminal-stop-facts.js";
import { killAllSessionTrees, killSessionTree, terminateSession, type KillResult } from "./terminal-session-kill.js";
import { TerminalWatcher } from "./terminal-session-watch.js";
import { commandLaunch, ptyEnvironment, shellCommand, terminalSize } from "./terminal-shell.js";
import { spawnWindowsPty, type TerminalProcess } from "./terminal-pty.js";
import { TerminalCapacity } from "./terminal-capacity.js";

export { resolveTerminalDirectory } from "./terminal-shell.js";

import {
  type CreateOptions,
  type StopFact,
  type StopResolution,
  type TerminalCreation,
  type TerminalEvent,
  type TerminalEventInput,
  type TerminalSession,
  type TerminalSessionInfo,
} from "./terminal-session-facts.js";

// 会话事实的形状住在 terminal-session-facts.ts(连同「每条线索为什么存在」的说明)。
// 这里原样对外转发:terminal-routes / terminal-commands 一直从 terminal.js 取它们。
export type { StopFact, TerminalEvent, TerminalSessionInfo };


const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_SESSIONS = 16;
const IDLE_TTL_MS = 30 * 60 * 1000;
/**
 * 一条会话最多记这么多个本机端口。停止那一档是逐个端口问 lsof 的,一条嘴碎的启动脚本
 * (测试输出、日志回放)不该把那次停止拖成几十次外部调用。先到先记 —— 服务自报家门
 * 几乎总在最前面。
 */
const MAX_LAUNCH_PORTS = 8;


export class TerminalSessionManager {
  private stopped = false;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly capacity = new TerminalCapacity(MAX_SESSIONS, () => this.sessions.values(), (session) => this.sessionRunning(session), (session) => this.retainHistory(session));
  private readonly creations = new Set<TerminalCreation>();
  private readonly windowsPty: typeof spawnWindowsPty;
  private readonly sweeper: ReturnType<typeof setInterval>;
  /** 观测层(后代进程组累积 + 端口存活):实现与判据见 terminal-session-watch.ts。 */
  private readonly watcher: TerminalWatcher;
  /**
   * 正在删除的项目:进入删除态后拒绝新建该项目的会话,直到删库完成。删成功后 projectId
   * 转入 deletedProjects **永久**留存(见下),删失败则撤销允许重试。没有它,清场被一个
   * 忽略 TERM 的会话拖住几秒时,并发的终端 POST / 命令 start 能在 destroyProject 的快照
   * 之后溜进来,变成删库后没有任何 UI 入口的无主会话(第 2 轮自由审查实锤)。生命周期
   * 由 project-routes 的 DELETE 用 begin/end 括起来。
   */
  private readonly closingProjects = new Set<string>();
  /**
   * 已删除的项目 id。**只增不减**(projectId 不复用,进程重启即清零,量级可忽略)。用于
   * 封死一类竞态:慢终端 POST 在删除开始前已缓存 cwd、停在 `await c.req.json()`,删除完成
   * 撤掉 closingProjects 后它才走到 create —— 只靠「删除执行期布尔 Set」拦不住它(第 3 轮
   * 自由审查实锤)。deleted 标记让这类在途请求**永远**拿不到创建资格。
   */
  private readonly deletedProjects = new Set<string>();

  /** containment 依赖(lsof / procfs)是否齐备;构造可注入 false 供回归验证拒绝路径。 */
  private readonly containment: boolean;

  constructor(options: { descendantScanMs?: number; containment?: boolean; windowsPty?: typeof spawnWindowsPty } = {}) {
    this.containment = options.containment ?? containmentAvailable();
    this.windowsPty = options.windowsPty ?? spawnWindowsPty;
    this.sweeper = setInterval(() => this.sweepIdleSessions(), 60_000);
    this.sweeper.unref?.();
    this.watcher = new TerminalWatcher(() => this.sessions.values(), { scanMs: options.descendantScanMs });
  }

  async createAsync(projectId: string, cwd: string, options: CreateOptions = {}): Promise<TerminalSessionInfo> {
    if (!IS_WINDOWS) return this.create(projectId, cwd, options);
    return this.createReserved(projectId, cwd, options, this.reserve(projectId, options.command?.id ?? null));
  }

  reserveCommand(projectId: string, commandId: string) {
    const creation = this.reserve(projectId, commandId, true);
    return {
      create: (cwd: string, command: { name: string; script: string }) => this.createReserved(projectId, cwd, {
        command: { ...command, id: commandId },
      }, creation),
      release: () => { if (!creation.reservation.started) this.releaseCreation(creation); },
    };
  }

  private checkProject(projectId: string, signal?: AbortSignal): void {
    if (this.stopped || this.closingProjects.has(projectId) || this.deletedProjects.has(projectId) || signal?.aborted) {
      throw new Error("项目正在删除或已删除，无法新建终端会话");
    }
  }

  private reserve(projectId: string, commandId: string | null, replaceLive = false): TerminalCreation {
    this.checkProject(projectId);
    const reservation = this.capacity.reserve(projectId, commandId, replaceLive);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const creation = { projectId, reservation, controller: new AbortController(), done, finish };
    this.creations.add(creation);
    return creation;
  }

  private releaseCreation(creation: TerminalCreation): void {
    this.capacity.release(creation.reservation);
    if (this.creations.delete(creation)) creation.finish();
  }

  private cancelCreations(projectId?: string): void {
    for (const creation of [...this.creations]) {
      if (projectId !== undefined && creation.projectId !== projectId) continue;
      creation.controller.abort();
      if (!creation.reservation.started) this.releaseCreation(creation);
    }
  }

  private async createReserved(projectId: string, cwd: string, options: CreateOptions,
    creation: TerminalCreation): Promise<TerminalSessionInfo> {
    try { this.checkProject(projectId, creation.controller.signal); }
    catch (error) {
      if (!creation.reservation.started) this.releaseCreation(creation);
      throw error;
    }
    this.capacity.begin(creation.reservation);
    try {
      if (!IS_WINDOWS) return this.register(projectId, cwd, options, creation, pty.spawn);
      const fallback = shellCommand();
      const launch = options.command
        ? commandLaunch(options.command.script, options.shell)
        : { shell: options.shell ?? fallback.shell, args: options.shellArgs ?? fallback.args };
      const handle = await this.windowsPty(launch.shell, launch.args, {
        name: "xterm-256color", cols: terminalSize(options.cols, 100, 20, 400),
        rows: terminalSize(options.rows, 24, 5, 200), cwd, env: ptyEnvironment(),
      }, { signal: creation.controller.signal });
      try { return this.register(projectId, cwd, options, creation, () => handle); }
      catch (error) { handle.kill(); throw error; }
    } finally { this.releaseCreation(creation); }
  }

  create(projectId: string, cwd: string, options: CreateOptions = {}): TerminalSessionInfo {
    if (IS_WINDOWS) throw new Error("Windows 终端需要异步隔离启动，请使用 createAsync");
    const creation = this.reserve(projectId, options.command?.id ?? null);
    this.capacity.begin(creation.reservation);
    try { return this.register(projectId, cwd, options, creation, pty.spawn); }
    finally { this.releaseCreation(creation); }
  }

  private register(projectId: string, cwd: string, options: CreateOptions, creation: TerminalCreation,
    spawnProcess: (file: string, args: string[], options: pty.IPtyForkOptions) => TerminalProcess): TerminalSessionInfo {
    this.capacity.validate(creation.reservation);
    // 项目正在删除 / 已删除:拒绝新建(shell 与命令 start 都走这里),否则会成为无主会话。
    this.checkProject(projectId, creation.controller.signal);
    // 同一条命令的退出记录只为回看而留,新会话一起就没意义了 —— **无条件**清掉整组
    // 已死透的那些(组里还有活人的会话是唯一能停到那些进程的把手,不能删)。开着日志
    // tab(有订阅)也照清:订阅钉住退出记录会把 16 个会话槽慢慢吃光,反复重启后 create
    // 失败、restart 变成服务中断(第 1 轮审查实锤)。前端本来就只挂同命令最新会话的
    // tab,旧记录被替换是预期行为。
    //
    // 「死透」这里读的是**缓存**的端口事实(sessionRunning,下同;问端口要跑 lsof,不能挂在
    // register 这条同步路径上)。这不是漏洞,因为**命令会话只有 start 和 restart 两个入口**,
    // 两边在动手之前都已经过 openSession 现问一遍端口(terminal-commands.ts);走到这里时
    // 「原来那次运行已经结束或被明确停止」已经核过了,这一层是兜底而不是判据。要再加第三个
    // 创建命令会话的入口,**必须先过同一个门** —— 否则这里会把还开着的服务的记录连同它的
    // launch token(唯一的归属凭据)一起删掉,那台服务从此没人能停(第 2 轮审查发现 1)。
    for (const sessionId of creation.reservation.replacedSessionIds) {
      const previous = this.sessions.get(sessionId);
      if (previous && this.sessionRunning(previous)) throw new Error("旧命令会话尚未停止，无法替换");
    }
    if (options.command) {
      for (const stale of [...this.sessions.values()]) {
        if (stale.projectId === projectId && stale.commandId === options.command.id && !this.sessionRunning(stale) && !this.retainHistory(stale)) {
          stale.listeners.clear();
          this.sessions.delete(stale.id);
        }
      }
    }
    const fallback = shellCommand();
    // 常用命令怎么起由 commandLaunch 定(POSIX `shell -lc`,Windows PowerShell
    // `-EncodedCommand`,理由见 terminal-shell.ts)。它可能抛 —— Windows 上找不到
    // PowerShell 时拒绝开会话,比拿 cmd.exe 去跑一段 PowerShell 脚本诚实。
    const launch = options.command
      ? commandLaunch(options.command.script, options.shell)
      : { shell: options.shell ?? fallback.shell, args: options.shellArgs ?? fallback.args };
    const shell = launch.shell;
    // containment 依赖缺失(非 Linux 且连 ps 都找不到)就**显式拒绝**开会话:没有确定性
    // 成员枚举,「关会话/关服时清空进程树」的承诺就兑现不了 —— 绝不静默降级到已被证伪的
    // 采样后继续对清场报成功(第 5 轮自由审查)。Linux 有 /proc 永真,macOS 的 ps 在
    // /bin/ps(SIP 保护),真实环境到不了这里;到了就是环境坏了,该修环境而不是带病运行。
    if (!IS_WINDOWS && !this.containment) {
      throw new Error("终端依赖缺失：ps 与 /proc 都不可用，无法保证关闭会话时清空进程树；请安装 procps 后重启 ash");
    }
    const args = launch.args;
    // POSIX 一律包 wrapper,session leader 是常驻 /bin/sh、真正的 shell/命令是它的孩子,
    // 详见 terminal-process-tree.ts:
    //   交互 → TTY_REAPER_WRAPPER:shell 退出时确定性清杀余党(「起作业后立即 disown;
    //   exit」的根治 —— 任何采样都赢不了毫秒级退出,第 3、4 轮实锤);
    //   命令 → TTY_COMMAND_WRAPPER:命令退出后**不杀**(daemonize 是合法保活形状),但
    //   只要会话里还有成员(含 stdio 全重定向 + 独立 PGID 的 nohup 形状,第 6 轮实锤)
    //   就保持存活 —— 会话持续「运行中」,stop/restart 随时能经成员枚举触达,独立 PGID
    //   服务不再失控/被重复启动(第 5 轮实锤)。
    // exitCode 由 wrapper 透传(信号死的内层折算成 128+n)。
    //
    // **Windows 没有这一层**,而且那边的能力因此少一档:ConPTY 自己就是整条进程树的容器
    // (node-pty 的 kill 走 `GetConsoleProcessList` 把挂在这个伪控制台上的进程全收掉),
    // 所以「停止」是确定性的;但「组长退了、后台服务还活着」(daemonize 形状)在那边
    // **判不出来** —— 没有进程组,`groupAlive`/`processAlive` 在 win32 上恒为 false,
    // 于是 `sessionAlive` 退化成「pty 进程还在吗」。后果如实记下:一条把服务
    // `Start-Process` 出去、自己立刻退出的命令,会话会落「已结束」,那个服务就脱管了。
    // 要让它跟 POSIX 一样可控,得给会话套 Job Object(confine-job.ts 已有那套机器)——
    // 等真有人这么写命令再做,不预先加一层没人验过的复杂度。
    const wrapper = options.command ? TTY_COMMAND_WRAPPER : TTY_REAPER_WRAPPER;
    const spawnSpec = IS_WINDOWS
      ? { file: shell, args }
      : { file: "/bin/sh", args: ["-c", wrapper, "ash-terminal", shell, ...args] };
    // 记号必须在 spawn **之前**生成:它要进这次启动的环境,才能被后代继承。
    const launchToken = options.command ? id() : null;
    const processHandle = spawnProcess(spawnSpec.file, spawnSpec.args, {
      name: "xterm-256color",
      cols: terminalSize(options.cols, 100, 20, 400),
      rows: terminalSize(options.rows, 24, 5, 200),
      cwd,
      env: ptyEnvironment(launchToken ? { [LAUNCH_ID_ENV]: launchToken } : {}),
    });
    const session: TerminalSession = {
      id: id(),
      projectId,
      cwd,
      shell,
      name: options.command ? options.command.name : basename(cwd) || cwd,
      commandId: options.command?.id ?? null,
      startedAt: Date.now(),
      exitCode: null,
      groupAlive: true,
      ports: [],
      portsAlive: false,
      stop: { kind: "none" },
      portsTruncated: false,
      process: processHandle,
      events: [],
      bufferBytes: 0,
      nextSeq: 1,
      lastAccessedAt: Date.now(),
      listeners: new Set(),
      descendantPgids: new Set(),
      launchPorts: new Set(),
      portScanner: createPortScanner(),
      launchToken,
      ttyPath: (processHandle as unknown as { ptsName?: string }).ptsName ?? null,
      factsGeneration: 0,
    };
    this.sessions.set(session.id, session);
    processHandle.onData((data) => {
      this.publish(session, { type: "data", data });
      // 服务起来都会自报家门(`Local: http://127.0.0.1:5173`)。趁输出流过记下来 ——
      // 守护化的服务退出进程树之后,这是唯一还指得到它的线索。按流增量认,不按块认。
      if (session.commandId !== null) this.recordPorts(session, session.portScanner.feed(data));
      // shell 产出输出 = 它还活着,且可能刚起了后台作业(job-control 会打印 `[1] pid`)。
      // 限流触发一次后代扫描,让新作业在毫秒级被记进 descendantPgids,而不必等满一个周期
      // —— 缩小「起作业后立刻退 shell」的漏记窗口(第 3 轮审查)。
      this.watcher.nudge();
    });
    processHandle.onExit(({ exitCode, signal }) => {
      session.exitCode = exitCode;
      // 流到头了:扫描器手里那截尾巴按终态再认一遍(地址恰好是最后一个字节时才用到)。
      if (session.commandId !== null) this.recordPorts(session, session.portScanner.flush());
      this.publish(session, { type: "exit", exitCode, signal });
    });
    return this.info(session);
  }

  get(sessionId: string, projectId?: string): TerminalSessionInfo | null {
    const session = this.session(sessionId, projectId);
    return session ? this.info(session) : null;
  }

  eventsAfter(sessionId: string, projectId: string, seq: number): TerminalEvent[] | null {
    const session = this.session(sessionId, projectId);
    if (!session) return null;
    session.lastAccessedAt = Date.now();
    return session.events.filter((event) => event.seq > seq);
  }

  subscribe(sessionId: string, projectId: string, listener: (event: TerminalEvent) => void): (() => void) | null {
    const session = this.session(sessionId, projectId);
    if (!session) return null;
    session.lastAccessedAt = Date.now();
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  write(sessionId: string, projectId: string, data: string): boolean {
    const session = this.session(sessionId, projectId);
    if (!session) return false;
    session.lastAccessedAt = Date.now();
    // 已退出的会话(常用命令跑完/被停,日志还挂着给人看)吞掉输入:进程都没了,写下去
    // 只会让 node-pty 抛错、前端弹「连接失败」——而用户只是在死 tab 里碰了下键盘。
    if (session.exitCode !== null) return true;
    try { session.process.write(data); } catch { /* pty died between checks */ }
    return true;
  }

  resize(sessionId: string, projectId: string, cols: number, rows: number): boolean {
    const session = this.session(sessionId, projectId);
    if (!session) return false;
    session.lastAccessedAt = Date.now();
    // 同上:对死 pty 调 resize 是 ioctl ENOTTY,不是调用方的错,静默成功。
    if (session.exitCode !== null) return true;
    try { session.process.resize(terminalSize(cols, 100, 20, 400), terminalSize(rows, 24, 5, 200)); } catch { /* pty died between checks */ }
    return true;
  }

  /**
   * 删会话 + 兜底清场。**同步**路径(sweeper 回收、destroy 收尾都走它),所以用同步 ps/lsof:
   * ppid 树 ∪ tty 持有者 ∪ 累积 pgid 一起 SIGKILL。destroy 里 terminate 已确认杀净、这里
   * 基本是空跑;但 sweeper 直接 close 一个「shell 退了、独立组作业还赖着」的会话时,这次
   * 同步清场就是最后的兜底 —— 否则回收会话会连把手一起丢(第 3 轮审查)。
   */
  close(sessionId: string, projectId?: string, released = false): boolean {
    const session = this.session(sessionId, projectId);
    if (!session) return false;
    if (!released && this.retainHistory(session)) return false;
    this.sessions.delete(sessionId);
    session.listeners.clear();
    killSessionTree(session);
    return true;
  }

  /**
   * 停止一个会话的进程但保留现场(日志、退出码、「我停过」都留着)。实现与判据见
   * terminal-session-kill.ts 的 terminateSession —— 那边只认进程事实,不碰会话表。
   */
  async terminate(
    sessionId: string,
    projectId?: string,
    timeouts?: { termMs?: number; killMs?: number },
  ): Promise<KillResult> {
    const session = this.session(sessionId, projectId);
    // 记录已经不在了:这一趟什么都没枚举过,`complete` 只能是 false —— 把「没问过」说成
    // 「问全了」,下游那条「敢不敢说收干净了」的判断就建在空气上。
    if (!session) return { ok: true, complete: false };
    return terminateSession(session, timeouts);
  }

  /**
   * 结束并移除一个会话:先走 terminate 的进程组级确认(TERM→整组清空→KILL 兜底),
   * 确认杀净才从 Map 删除。close() 只对组长单发一次信号,交互 shell 里忽略 HUP/TERM
   * 的后台作业会被 PID 1 收养、而控制把手已被删掉(第 1 轮自由审查实锤)——所以
   * 「关 tab = 结束会话」必须走这里;杀不净时会话保留在 Map 里,失败如实回给调用方。
   *
   * 进程那三条线索走完之后**还要清这次启动的整笔账**:这条记录是它唯一的把手(记号、端口、
   * 没核销的责任全只活在记录里),删掉就等于把还在跑的东西变成永久孤儿 —— 关 tab、删项目都
   * 会走到这儿(第 3 轮审查发现 2;只补端口不看账的漏洞见第 4 轮发现 1)。清不干净同样保留
   * 记录、如实报失败。
   */
  async destroy(
    sessionId: string,
    projectId?: string,
    timeouts?: { termMs?: number; killMs?: number },
  ): Promise<KillResult> {
    const session = this.session(sessionId, projectId);
    const result = await this.terminate(sessionId, projectId, timeouts);
    if (!result.ok) return result;
    if (session) {
      const left = await releaseLaunchResponsibility(session);
      if (left) return { ok: false, reason: left };
    }
    this.close(sessionId, projectId, true);
    return result;
  }

  /**
   * 删项目前的清场:该项目的全部会话(交互 shell + 常用命令)逐个 destroy。任何一个
   * 杀不净都如实报失败,由调用方**拒绝删项目**——项目行一删,这些会话就再没有任何
   * UI/API 把手,只能占着全局会话槽等 server 重启(第 1 轮自由审查实锤)。
   */
  // 项目级没有「清单全不全」这一问(逐条会话各有各的),所以这里不透传 KillResult 的 complete。
  async destroyProject(projectId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const alreadyClosing = this.closingProjects.has(projectId);
    this.beginProjectShutdown(projectId);
    try {
      await Promise.all([...this.creations].filter((creation) => creation.projectId === projectId).map((creation) => creation.done));
      for (const session of this.listForProject(projectId)) {
        const result = await this.destroy(session.id, projectId);
        if (!result.ok) return { ok: false, reason: `「${session.name}」${result.reason}` };
      }
      return { ok: true };
    } finally {
      if (!alreadyClosing) this.endProjectShutdown(projectId);
    }
  }

  /** 进入项目删除态。由 project-routes 的 DELETE 用 try/finally 括住整个删除流程。 */
  beginProjectShutdown(projectId: string): void {
    this.closingProjects.add(projectId);
    this.cancelCreations(projectId);
  }
  /**
   * 退出删除态。deleted=true(删库成功)时把 projectId 转入 deletedProjects **永久**留存,
   * 让删除开始前就已进入创建路由、删除完成后才走到 create 的在途慢请求**永远**拿不到创建
   * 资格 —— 只在删除执行期维护一个布尔 Set 封不住这条竞态(第 3 轮自由审查实锤)。deleted=false
   * (删库失败、需重试)时只撤销执行期标记,不留永久墓碑。
   */
  endProjectShutdown(projectId: string, deleted = false): void {
    this.closingProjects.delete(projectId);
    if (deleted) {
      this.deletedProjects.add(projectId);
      this.cancelCreations(projectId);
    }
  }
  /** 项目是否正在删除或已删除:命令 start/restart、终端 create 据此拒绝,别把正在被杀/已无
   *  归宿的会话当「已在跑」交还,也别为已删项目起无主 shell。 */
  isProjectClosing(projectId: string): boolean {
    return this.closingProjects.has(projectId) || this.deletedProjects.has(projectId);
  }

  /**
   * shell 每产出一批输出就(限流地)触发一次后代扫描,收窄「起作业后很快关 shell」时
   * 累积清单的空窗。**trailing edge**:限流窗口内到达的触发不丢弃而是排队一个补扫
   * (第 4 轮审查:全局限流直接跳过会让另一终端的输出吃掉本终端的扫描名额)。它只是
   * 让累积兜底更快命中 —— 正确性主力是 wrapper 清杀 + 结束时的 lsof/ppid 快照。
   */
  /**
   * server 退出前的清场:会话表清空,进程交给 killAllSessionTrees 同步连发 TERM+KILL
   * (为什么必须同步、为什么不能只读累积快照,见 terminal-session-kill.ts 那边)。
   *
   * **端口这一档也在清场范围内**,而且同样必须同步:会话表一清,这次启动的记号就没了,
   * 而真·守护化的服务只认这一条线索 —— 漏掉它,ash 重启后那个服务还听着端口,却再没有
   * 任何把手能停它(第 3 轮审查发现 2)。顺序是先发信号再问端口:信号是免费的,lsof 要
   * 几十毫秒一个端口,别让它拖着前面那一步。
   */
  shutdown(): void {
    this.stopped = true;
    this.cancelCreations();
    clearInterval(this.sweeper);
    this.watcher.stop();
    const targets = [...this.sessions.values()];
    for (const session of targets) {
      session.listeners.clear();
      this.sessions.delete(session.id);
    }
    killAllSessionTrees(targets);
    const { owed } = releaseLaunchPortsSync(targets);
    if (owed.length) {
      console.warn(`[terminal] 关服时这些进程核不上归属、没敢停,重启后已无把手可停它们：${owed.join("；")}`);
    }
  }

  sweepIdleSessions(now = Date.now()): number {
    const cutoff = now - IDLE_TTL_MS;
    let closed = 0;
    for (const session of this.sessions.values()) {
      // A subscriber means the CLI is still open, even when the shell is silent.
      if (session.listeners.size > 0 || session.lastAccessedAt >= cutoff) continue;
      // 活着的会话一律不回收:命令会话是「常驻服务」,交互 shell 是**持久终端**(VSCode
      // 语义:关抽屉只是收起,回来还要原样在,结束它的只有 tab 上的关闭按钮和它自己
      // exit)。判「活」含 daemonize 形状(组长退了、子进程还在):回收会话就没人能停
      // 那些进程了。只有整组死透的(纯退出日志)才闲置半小时后回收。
      if (this.sessionRunning(session)) continue;
      // 唯一的例外:service 的启动脚本**正常退出、又没被用户停过**。这条记录可能是
      // 「服务还开着」仅存的凭据 —— `docker compose up -d`、`pm2 start` 这类服务跑在
      // ash 的进程树之外,启动脚本跑完自己就退,把它当「纯退出日志」收走,停止按钮当场
      // 退回 ▶、容器却还在跑(第 1 轮审查 E1 实锤)。GC 在这件事上必须保守:宁可多留
      // 一条退出日志,也不能把「还有东西在跑」这个事实清掉。
      if (session.commandId === SERVICE_COMMAND_ID && session.exitCode === 0 && session.stop.kind === "none") continue;
      if (this.close(session.id)) closed += 1;
    }
    return closed;
  }

  /** 一个项目的全部会话（交互 shell + 常用命令），给终端抽屉 attach 和状态栏用。 */
  listForProject(projectId: string): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.projectId === projectId)
      .map((session) => this.info(session));
  }

  /** 所有项目的常用命令会话（含刚退出还没被回收的），给全局状态栏汇总用。 */
  listCommandSessions(): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.commandId !== null)
      .map((session) => this.info(session));
  }

  /**
   * 某条常用命令当前活着的会话;判「活」用 sessionAlive 而不是 exitCode ——
   * daemonize 形状(组长退了、后台子进程还在)也算活:stop/restart 得能找到它交给
   * terminate,start 得知道「其实还在跑」而不是在旁边再起一份抢端口。
   */
  liveCommandSession(projectId: string, commandId: string): TerminalSessionInfo | null {
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.commandId === commandId && this.sessionAlive(session)) {
        return this.info(session);
      }
    }
    return null;
  }

  /**
   * **发现即落账**:停止/重启路径一发现「核不上归属、没敢动」的号(或者发现成员清单本身
   * 不全),立刻把这笔责任并进那条会话的账 —— 不等这次动作有没有成功。
   *
   * 为什么不走 markCommandStopped:那一个落的是**结论**(verified/unresolved),会把 portsAlive
   * 一并收口;而这里落的是**发现**,此刻端口可能还有人听、这次停止可能马上就要报失败。
   * 失败分支原地返回、发现跟着丢掉,下一遍就再也发现不了它(第 5 轮审查发现 1)。
   *
   * 按**会话 id** 定位,不按「最近一次」:调用方手里的 open 就是它动手时的那条会话,中途可能
   * 已经有新实例起来了,落错对象等于把责任记到无关的那次启动上。
   */
  oweCommandLeftovers(sessionId: string, projectId: string, pids: number[], why: string, complete = true): void {
    const session = this.session(sessionId, projectId);
    if (session) oweLeftovers(session, pids, why, complete);
  }

  /**
   * 把这条常用命令**最近一次**会话记成「用户停的」,并落下这次停止的核验结论。
   *
   * 停止路径一律调它,**不分活进程还是守护形状**:`docker compose up -d` 这类启动脚本早就
   * 自己退了,没有活进程给 terminate 去标;而活进程那条路里 terminate 只标它自己那条会话,
   * 缓存的 portsAlive 还可能是旧的 true。两种形状都要求「我点过停止」留在会话事实里 ——
   * 否则刷新回来还显示着停止按钮(根 AGENTS.md:停止要留下持久可见的状态),紧接着点启动还会
   * 被幂等门拿一条已经退出的会话顶回去(第 2 轮审查发现 1)。
   *
   * `resolution` = 这次停止**核验之后**的结论(verified / unresolved)。落账是**单调**的 ——
   * 合并规则见 terminal-stop-facts.ts 的 mergeStop:一次范围更窄的核验不许核销一笔范围更宽的
   * 责任。返回落账后的终态,给调用方原样回给用户(「这次又没停净」要说得出口)。
   */
  markCommandStopped(sessionId: string, projectId: string, resolution: StopResolution): StopFact {
    const session = this.session(sessionId, projectId);
    if (!session) return resolution;
    applyStop(session, resolution);
    this.pruneStoppedHistory(session);
    return projectStop(session.stop);
  }

  /**
   * 同一条命令只留**最新那条**「没能确认停净」的记录。
   *
   * 这类记录按设计永远核销不掉(`mergeStop` 对 `complete=false` 的单调性),于是既不被
   * `close()` 回收、也不被同命令新会话替换(`register` 的 stale 清理放过它们),而界面上根本
   * 没有释放它们的入口 —— 命令日志标签的 ✕ 只是「收起」,同一条命令又只有最新那条会进标签。
   * 容量那一侧已经不把纯历史算进活会话预算(terminal-capacity 的 `pureHistory`),这一侧负责
   * 它们不会无界堆积:更早的那些 pids 和端口都是空的,除了那句话之外不提供任何把手,留着
   * 只会占地方(第 2 轮审查必须修 1 的建议修法)。
   *
   * **名下还有活物的一条都不动**(`sessionRunning`):那种记录是触达残留进程的唯一把手,删掉
   * 就等于把还在跑的东西变成永久孤儿。所以这里只删「保留 且 不活」的那些。
   */
  private pruneStoppedHistory(latest: TerminalSession): void {
    if (latest.commandId === null || !this.retainHistory(latest)) return;
    for (const session of [...this.sessions.values()]) {
      if (session.id === latest.id || session.projectId !== latest.projectId) continue;
      if (session.commandId !== latest.commandId) continue;
      if (this.sessionRunning(session) || !this.retainHistory(session)) continue;
      session.listeners.clear();
      this.sessions.delete(session.id);
    }
  }

  recordCommandPortState(sessionId: string, projectId: string, state: "ours" | "unknown" | "stranger" | "free"): void {
    const session = this.session(sessionId, projectId);
    if (!session) return;
    session.portsAlive = state === "ours";
    session.portUncertain = state === "unknown";
    session.factsGeneration += 1;
  }

  /**
   * restart 的容量预检:排除同命令会话(活的会被 terminate、死的会被 create 清掉,
   * 都会让位)后还有没有槽。restart 的顺序是先杀旧再建新,若 create 注定因上限失败,
   * 必须在动手前拒绝 —— 「重启失败」绝不能落成「服务被停了」(第 1 轮审查实锤)。
   */
  hasSlotForCommand(projectId: string, commandId: string): boolean {
    return this.capacity.hasSlot(projectId, commandId, true);
  }

  private session(sessionId: string, projectId?: string): TerminalSession | null {
    const session = this.sessions.get(sessionId) ?? null;
    if (session && (!projectId || session.projectId === projectId)) return session;
    return null;
  }

  private info(session: TerminalSession): TerminalSessionInfo {
    const { id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode } = session;
    return {
      id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode,
      // 派生,不存:「有没有人要求停过」是 stop 的投影,两份就会漂(见 StopFact 的注释)。
      stoppedByUser: session.stop.kind !== "none",
      // 即时探测,不是缓存值:组长退没退(exitCode)和组里有没有活人是两件事。
      groupAlive: this.sessionAlive(session),
      ports: [...session.launchPorts],
      // 这个只能是缓存值:问端口要跑 lsof,不能挂在每次 info() 上(列表接口一次几十条)。
      portsAlive: session.portsAlive,
      portUncertain: session.portUncertain ?? false,
      running: this.sessionRunning(session),
      stop: projectStop(session.stop),
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
  private recordPorts(session: TerminalSession, ports: number[]): void {
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
  private sessionRunning(session: TerminalSession): boolean {
    return this.sessionAlive(session) || session.portsAlive || session.portUncertain === true || liveLeftovers(session.stop).length > 0;
  }

  private retainHistory(session: TerminalSession): boolean {
    return projectStop(session.stop).kind === "unresolved";
  }

  /**
   * 这条会话的启动记号(service-ports.ts 核归属用)。服务端内部接口,不进 DTO ——
   * 它是一枚授权凭据,没有任何前端用途。
   */
  launchTokenOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.launchToken ?? null;
  }

  /**
   * 这条会话是否还有活着的进程:组长没退,或组长退了但同组子进程还在(daemonize 形状),
   * 或 job-control 后台作业在累积的独立组里还活着 —— 少最后这一条,shell exit 后独立组的
   * 后台作业会被 sweeper 当死透会话回收,连同累积快照一起丢,那些进程就彻底失控
   * (第 2 轮自由审查实锤)。
   */
  private sessionAlive(session: TerminalSession): boolean {
    if (session.exitCode === null || groupAlive(session.process.pid)) return true;
    for (const pgid of session.descendantPgids) if (groupAlive(pgid)) return true;
    return false;
  }

  private publish(session: TerminalSession, event: TerminalEventInput): void {
    const next = { ...event, seq: session.nextSeq++ } as TerminalEvent;
    session.events.push(next);
    session.bufferBytes += next.type === "data" ? Buffer.byteLength(next.data) : 32;
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.events.length > 1) {
      const removed = session.events.shift()!;
      session.bufferBytes -= removed.type === "data" ? Buffer.byteLength(removed.data) : 32;
    }
    session.lastAccessedAt = Date.now();
    for (const listener of session.listeners) listener(next);
  }

}

export const terminalSessions = new TerminalSessionManager();

// server 无论怎么退,'exit' 都会同步触发:SIGINT/SIGTERM 处理器(singleton.ts
// installCleanup)和 `npm run restart` 的杀法最终都走 process.exit(),uncaught 的默认
// 行为也是 exit。在这里收掉所有活着的会话进程,否则常用命令的 dev server 被 PID 1
// 收养成孤儿 —— ash 重启后会话表(内存态)清零,UI 显示「未启动」,旧进程却继续占端口,
// 再点启动只会得到端口冲突(第 3 轮审查实锤)。kill -9 / 崩溃 / 断电没有钩子能接,
// 属已知边界。
process.once("exit", () => terminalSessions.shutdown());
