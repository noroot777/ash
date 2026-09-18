import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import * as pty from "node-pty";
import { resolveBin } from "./executors/bin-resolve.js";
import { expandHome } from "./git.js";
import { IS_WINDOWS } from "./platform.js";
import { id } from "./util.js";
import {
  descendantsFromTable,
  groupAlive,
  processAlive,
  readProcessTable,
  readProcessTableSync,
  snapshotDescendants,
  snapshotDescendantsSync,
  type DescendantSnapshot,
} from "./terminal-process-tree.js";

const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_SESSIONS = 16;
const IDLE_TTL_MS = 30 * 60 * 1000;
// 后代累积扫描的默认间隔。它**不是正确性的唯一来源**:结束/退出会话时会先抓一次**实时**
// 后代快照(shell 还活着就能抓全,这是点 ✕ 关活 shell 的常见路径);累积只兜底「shell 已经
// 自己退出、树断了」的场景。除周期扫外,shell 每次产出输出(onData)也会触发一次限流扫描,
// 让刚起的后台作业在毫秒级被记下,而不必等满一个周期。构造可注入间隔,回归用小间隔 + 真实
// sleep 按真实定时器验证(第 3 轮审查:测试不得手动调 trackDescendants)。
const DESCENDANT_SCAN_MS = 1_500;
// onData 触发扫描的限流:shell 输出很密,别每帧都 ps。
const DESCENDANT_DATA_THROTTLE_MS = 250;

export type TerminalEvent =
  | { seq: number; type: "data"; data: string }
  | { seq: number; type: "exit"; exitCode: number; signal?: number };

type TerminalEventInput =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number; signal?: number };

export type TerminalSessionInfo = {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  name: string;
  /** 非空 = 这是「常用命令」的常驻会话（shared/src/project-commands.ts），不是交互 shell。 */
  commandId: string | null;
  startedAt: number;
  /** null = 进程还活着。命令会话靠它区分「运行中」和「退了但日志还能回看」。 */
  exitCode: number | null;
  /** 用户主动停的（区别于自己崩了）：UI 显示「已停止」，不算异常退出、不亮红点。 */
  stoppedByUser: boolean;
  /**
   * 进程组里是否还有活着的进程(info() 时即时探测)。组长退了组不一定空:启动脚本
   * `cmd & …; exit 0` 这种 daemonize 形状下 exitCode 已落、后台子进程还在跑 ——
   * 「这条命令还活着吗」一律看这个字段,别看 exitCode(第 4 轮审查实锤)。
   */
  groupAlive: boolean;
};

type TerminalSession = TerminalSessionInfo & {
  process: pty.IPty;
  events: TerminalEvent[];
  bufferBytes: number;
  nextSeq: number;
  lastAccessedAt: number;
  listeners: Set<(event: TerminalEvent) => void>;
  /**
   * 会话存续期见过的后代进程组 pgid(job-control 后台作业的独立组)。持续累积 ——
   * shell 一 exit 树就断了、实时快照抓不到,只有这份内存记录能在结束/退出时杀到它们
   * (第 2 轮自由审查实锤)。见 terminal-process-tree.ts 顶部与 trackDescendants。
   */
  descendantPgids: Set<number>;
};

type CreateOptions = {
  cols?: number;
  rows?: number;
  shell?: string;
  shellArgs?: string[];
  /**
   * 常用命令模式：不开交互 shell，直接 `shell -lc <script>` 跑这条命令，进程退出
   * 会话就结束（exitCode 落在会话上）。`-l` 保留 —— dev 命令的 PATH/nvm 全靠登录 shell。
   */
  command?: { id: string; name: string; script: string };
};

function terminalSize(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

/**
 * 起一个交互 shell 用什么命令。
 *
 * POSIX:`$SHELL`,回退 zsh / bash,带 `-l` 走登录 shell(用户的 PATH、nvm、rbenv
 * 这些全靠它)。
 *
 * Windows:**没有 `-l` 这一档**,登录 shell 是 POSIX 概念,PowerShell 会把它当成
 * 一个位置参数、当脚本名去找,直接起不来。回退顺序按「用户更可能想要哪个」排:
 * PowerShell 7(`pwsh`)→ 随系统自带的 Windows PowerShell 5.1 → `cmd`。`$SHELL`
 * 在 Windows 上基本只由 Git Bash 之类的环境设置,而且往往是一条 MSYS 风格的路径
 * (`/usr/bin/bash`),ConPTY 起不了 —— 所以那边不认它。
 */
function shellCommand(): { shell: string; args: string[] } {
  if (IS_WINDOWS) {
    for (const candidate of ["pwsh.exe", "powershell.exe", "cmd.exe"]) {
      const resolved = resolveBin(candidate);
      if (resolved) return { shell: resolved, args: [] };
    }
    // 一个都没解析到(PATH 被改坏了)也别抛:交给 ConPTY 自己去找,起不来会走
    // onExit,前端至少能看见退出码,比这里直接 500 强。
    return { shell: "cmd.exe", args: [] };
  }
  const shell = process.env.SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
  return { shell, args: ["-l"] };
}

function ptyEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", ASH_TERMINAL: "1" };
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly descendantScanner: ReturnType<typeof setInterval>;
  private scanningDescendants = false;
  private lastDescendantScanAt = 0;
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

  constructor(options: { descendantScanMs?: number } = {}) {
    this.sweeper = setInterval(() => this.sweepIdleSessions(), 60_000);
    this.sweeper.unref?.();
    this.descendantScanner = setInterval(
      () => void this.trackDescendants(),
      options.descendantScanMs ?? DESCENDANT_SCAN_MS,
    );
    this.descendantScanner.unref?.();
  }

  create(projectId: string, cwd: string, options: CreateOptions = {}): TerminalSessionInfo {
    // 项目正在删除 / 已删除:拒绝新建(shell 与命令 start 都走这里),否则会成为无主会话。
    if (this.closingProjects.has(projectId) || this.deletedProjects.has(projectId)) {
      throw new Error("项目正在删除或已删除，无法新建终端会话");
    }
    // 同一条命令的退出记录只为回看而留,新会话一起就没意义了 —— **无条件**清掉整组
    // 已死透的那些(组里还有活人的会话是唯一能停到那些进程的把手,不能删)。开着日志
    // tab(有订阅)也照清:订阅钉住退出记录会把 16 个会话槽慢慢吃光,反复重启后 create
    // 失败、restart 变成服务中断(第 1 轮审查实锤)。前端本来就只挂同命令最新会话的
    // tab,旧记录被替换是预期行为。
    if (options.command) {
      for (const stale of [...this.sessions.values()]) {
        if (stale.projectId === projectId && stale.commandId === options.command.id
          && !this.sessionAlive(stale)) {
          stale.listeners.clear();
          this.sessions.delete(stale.id);
        }
      }
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("终端会话数量已达上限");
    const fallback = shellCommand();
    const shell = options.shell ?? fallback.shell;
    // 常用命令在 Windows 上没有对应的「-lc」语义，且 win32 分支未经真机验证 —— 与其留
    // 一段没跑过的 cmd/pwsh 参数拼接，不如明确拒绝（AGENTS.md「Windows 真机」一节）。
    if (options.command && IS_WINDOWS) throw new Error("常用命令暂不支持 Windows 上的 ash 实例");
    const args = options.command ? ["-lc", options.command.script] : options.shellArgs ?? fallback.args;
    const processHandle = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: terminalSize(options.cols, 100, 20, 400),
      rows: terminalSize(options.rows, 24, 5, 200),
      cwd,
      env: ptyEnvironment(),
    });
    const info: TerminalSessionInfo = {
      id: id(),
      projectId,
      cwd,
      shell,
      name: options.command ? options.command.name : basename(cwd) || cwd,
      commandId: options.command?.id ?? null,
      startedAt: Date.now(),
      exitCode: null,
      stoppedByUser: false,
      groupAlive: true,
    };
    const session: TerminalSession = {
      ...info,
      process: processHandle,
      events: [],
      bufferBytes: 0,
      nextSeq: 1,
      lastAccessedAt: Date.now(),
      listeners: new Set(),
      descendantPgids: new Set(),
    };
    this.sessions.set(info.id, session);
    processHandle.onData((data) => {
      this.publish(session, { type: "data", data });
      // shell 产出输出 = 它还活着,且可能刚起了后台作业(job-control 会打印 `[1] pid`)。
      // 限流触发一次后代扫描,让新作业在毫秒级被记进 descendantPgids,而不必等满一个周期
      // —— 缩小「起作业后立刻退 shell」的漏记窗口(第 3 轮审查)。
      this.maybeScanFromData();
    });
    processHandle.onExit(({ exitCode, signal }) => {
      session.exitCode = exitCode;
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
   * 删会话 + 兜底清场。**同步**路径(sweeper 回收、destroy 收尾都走它),所以用同步 ps:
   * 实时抓一次后代(shell 若还活着能抓全)并入累积的 pgid,一起 SIGKILL。destroy 里 terminate
   * 已确认杀净、这里基本是空跑;但 sweeper 直接 close 一个「shell 退了、独立组作业还赖着」
   * 的会话时,这次同步清场就是最后的兜底 —— 否则回收会话会连把手一起丢(第 3 轮审查)。
   */
  close(sessionId: string, projectId?: string): boolean {
    const session = this.session(sessionId, projectId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.listeners.clear();
    const live = snapshotDescendantsSync(session.process.pid);
    const members: DescendantSnapshot = {
      pids: live.pids,
      pgids: [...new Set([...session.descendantPgids, ...live.pgids])],
    };
    this.signalTree(session, "SIGKILL", members);
    return true;
  }

  /**
   * 停止一个会话但**保留现场**:会话不删、缓冲日志不丢,退出码照常经 onExit 落在会话上
   * —— 停止是用户动作,刷新页面后要看得出「我停过」(根 AGENTS.md 的硬要求),所以它和
   * close(关掉 tab、连日志一起丢)是两个动词。
   *
   * 杀的是**整个进程组 + 会话见过的全部后代**(pty 子进程 fork 后 setsid,组长就是它自己,
   * dev server 派生的子进程都在组里;交互 shell 的 job control 会把后台作业挪进独立进程组,
   * 靠「存续期累积 + 发信号前实时补抓」两份后代 pgid 覆盖):SIGTERM 给进程收尾的机会,等不到
   * **整组+后代清空**再 SIGKILL 兜底;两轮都压不住(基本只剩 D 状态)就如实返回失败,绝不把
   * 「没杀死」报成「已停」—— 会话还在,UI 可重试。判定必须是「组长退了 **且** 组里没人 **且**
   * 已见后代组/进程全消失」:`cmd & wait`(或 shell 先 exit、独立组作业还在)这种形状下只看
   * 组长就会漏杀(第 2 轮审查实锤)。双 fork 后立刻 setsid 逃逸、且从没被任一次扫描抓到的
   * 守护进程超出本方法能力,属已知边界。
   */
  async terminate(
    sessionId: string,
    projectId?: string,
    timeouts?: { termMs?: number; killMs?: number },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const session = this.session(sessionId, projectId);
    if (!session) return { ok: true };
    const groupId = session.process.pid;
    // 后代快照要在**发信号 + 早退判定之前**拿齐:实时再抓一次(shell 还活着就能抓到最新
    // 后代),并入会话存续期累积的那份(shell 已 exit、树断了就只剩它)。早退绝不能只看
    // 组长的原组 —— job-control 后台作业在自己的独立组里,shell 先 exit 后原组空、作业还
    // 在跑,只看原组会把它谎报成「已结束」(第 2 轮自由审查实锤)。
    const live = await snapshotDescendants(groupId);
    for (const pgid of live.pgids) session.descendantPgids.add(pgid);
    const descendants: DescendantSnapshot = { pids: live.pids, pgids: [...session.descendantPgids] };
    const cleared = () => session.exitCode !== null && !groupAlive(groupId)
      && descendants.pgids.every((pgid) => !groupAlive(pgid))
      && descendants.pids.every((pid) => !processAlive(pid));
    if (cleared()) return { ok: true };
    session.stoppedByUser = true;
    this.signalTree(session, "SIGTERM", descendants);
    if (await this.waitForGroupExit(session, timeouts?.termMs ?? 3000, descendants)) return { ok: true };
    this.signalTree(session, "SIGKILL", descendants);
    if (await this.waitForGroupExit(session, timeouts?.killMs ?? 2000, descendants)) return { ok: true };
    return {
      ok: false,
      reason: session.exitCode === null
        ? "进程连 SIGKILL 都没响应，可能卡在不可中断的系统调用里"
        : "主进程已退出，但它派生的子进程杀不掉，可能卡在不可中断的系统调用里",
    };
  }

  private signalTree(session: TerminalSession, signal: "SIGTERM" | "SIGKILL", descendants?: DescendantSnapshot): void {
    try {
      // Windows 没有进程组信号这一说,交给 node-pty 收 ConPTY;命令会话在 create 时
      // 已拒绝 win32,这里只是让普通会话也调用得动。
      if (IS_WINDOWS) session.process.kill();
      else process.kill(-session.process.pid, signal);
    } catch {
      // 整组已空(ESRCH):没人可杀,waitForGroupExit 会立刻确认。
      try { session.process.kill(signal); } catch { /* already gone */ }
    }
    // job control 的后台作业在自己的组里,逐组、逐 pid 补刀(快照见 snapshotDescendants;
    // 逐 pid 是兜底 —— 覆盖 setpgid 到快照外新组的边角)。
    for (const pgid of descendants?.pgids ?? []) {
      try { process.kill(-pgid, signal); } catch { /* already gone */ }
    }
    for (const pid of descendants?.pids ?? []) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }

  /**
   * 等「组长的 exitCode 落了 **且** 进程组里没有任何存活成员 **且** 快照里的后代
   * 进程/进程组全部消失」;超时返回 false,由调用方决定升级还是报失败。组长先死不算完
   * —— 组号还被子进程占着(kill(-pgid, 0) 探测),job control 的后台作业还占着自己的组。
   */
  private waitForGroupExit(session: TerminalSession, timeoutMs: number, descendants?: DescendantSnapshot): Promise<boolean> {
    const groupId = session.process.pid;
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const cleared = session.exitCode !== null && !groupAlive(groupId)
          && (descendants?.pgids ?? []).every((pgid) => !groupAlive(pgid))
          && (descendants?.pids ?? []).every((pid) => !processAlive(pid));
        if (cleared) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * 结束并移除一个会话:先走 terminate 的进程组级确认(TERM→整组清空→KILL 兜底),
   * 确认杀净才从 Map 删除。close() 只对组长单发一次信号,交互 shell 里忽略 HUP/TERM
   * 的后台作业会被 PID 1 收养、而控制把手已被删掉(第 1 轮自由审查实锤)——所以
   * 「关 tab = 结束会话」必须走这里;杀不净时会话保留在 Map 里,失败如实回给调用方。
   */
  async destroy(
    sessionId: string,
    projectId?: string,
    timeouts?: { termMs?: number; killMs?: number },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await this.terminate(sessionId, projectId, timeouts);
    if (result.ok) this.close(sessionId, projectId);
    return result;
  }

  /**
   * 删项目前的清场:该项目的全部会话(交互 shell + 常用命令)逐个 destroy。任何一个
   * 杀不净都如实报失败,由调用方**拒绝删项目**——项目行一删,这些会话就再没有任何
   * UI/API 把手,只能占着全局会话槽等 server 重启(第 1 轮自由审查实锤)。
   */
  async destroyProject(projectId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (const session of this.listForProject(projectId)) {
      const result = await this.destroy(session.id, projectId);
      if (!result.ok) return { ok: false, reason: `「${session.name}」${result.reason}` };
    }
    return { ok: true };
  }

  /** 进入项目删除态。由 project-routes 的 DELETE 用 try/finally 括住整个删除流程。 */
  beginProjectShutdown(projectId: string): void { this.closingProjects.add(projectId); }
  /**
   * 退出删除态。deleted=true(删库成功)时把 projectId 转入 deletedProjects **永久**留存,
   * 让删除开始前就已进入创建路由、删除完成后才走到 create 的在途慢请求**永远**拿不到创建
   * 资格 —— 只在删除执行期维护一个布尔 Set 封不住这条竞态(第 3 轮自由审查实锤)。deleted=false
   * (删库失败、需重试)时只撤销执行期标记,不留永久墓碑。
   */
  endProjectShutdown(projectId: string, deleted = false): void {
    this.closingProjects.delete(projectId);
    if (deleted) this.deletedProjects.add(projectId);
  }
  /** 项目是否正在删除或已删除:命令 start/restart、终端 create 据此拒绝,别把正在被杀/已无
   *  归宿的会话当「已在跑」交还,也别为已删项目起无主 shell。 */
  isProjectClosing(projectId: string): boolean {
    return this.closingProjects.has(projectId) || this.deletedProjects.has(projectId);
  }

  /**
   * shell 每产出一批输出就(限流地)触发一次后代扫描。job-control 起后台作业时会打印
   * `[1] <pid>`、命令自己也会有 stdout —— 这些都是「shell 还活着且刚可能起了新作业」的
   * 信号,借它把独立组 pgid 在毫秒级记进 descendantPgids,把「起作业后很快关 shell」的
   * 漏记窗口从「一个周期」压到「一次限流」。它**不是**正确性来源(异步 ps 仍可能慢于
   * shell 退出),只是收窄窗口;真正兜底的是结束/退出时的实时快照 + 周期扫。
   */
  private maybeScanFromData(): void {
    if (Date.now() - this.lastDescendantScanAt < DESCENDANT_DATA_THROTTLE_MS) return;
    void this.trackDescendants();
  }

  /**
   * 持续累积每个活会话见过的后代进程组 pgid。一次 ps 覆盖全部活 shell(命令会话也扫,
   * 无害)。由 constructor 的定时器每 DESCENDANT_SCAN_MS 调一次,外加 onData 的限流触发
   * (maybeScanFromData)。幂等只累积、门闩防重入、记录本次扫描时刻给限流用。
   * 已知边界:后台作业启动**又**在任何一次扫描落地前(周期 + data 触发都没赶上)关掉 shell,
   * 这一个独立组 pgid 会漏记 —— shell 一 exit 树就断、macOS 又无从按会话/SID 反查孤儿
   * (sess 列被 SIP 抹成 0、无数字 sid、控制 tty 被吊销),这一残留超出本层能力,如实记录。
   */
  private async trackDescendants(): Promise<void> {
    if (this.scanningDescendants) return;
    const shells = [...this.sessions.values()].filter((session) => session.exitCode === null);
    if (!shells.length) return;
    this.scanningDescendants = true;
    try {
      const table = await readProcessTable();
      if (!table) return;
      for (const session of shells) {
        for (const pgid of descendantsFromTable(table, session.process.pid).pgids) {
          session.descendantPgids.add(pgid);
        }
      }
    } finally {
      this.lastDescendantScanAt = Date.now();
      this.scanningDescendants = false;
    }
  }

  /**
   * server 退出前的清场:对每个还活着的会话**整组 + 后代 pgid** SIGTERM+SIGKILL 连发。
   * 必须同步('exit' 钩子里没有 await),但同步 ps 是可以的(readProcessTableSync)——
   * 一次读全表,给每个会话就地补一份**实时**后代快照(shell 此刻还活着就能抓全独立组),
   * 与存续期累积的 descendantPgids 合并。不能只读累积值:那会漏掉「起了作业但还没被任何
   * 一次扫描记下」的独立组(第 2、3 轮自由审查实锤)。ps 不可用时退回只用累积值。命令会话
   * 跑的是 dev server/watch 这类可随时重启的进程,强杀可接受;不杀的代价是它们被 PID 1
   * 收养成孤儿,ash 重启后 UI/API 失忆显示「未启动」、旧进程却还占着端口。不能走 close():
   * 它每会话各跑一次同步 ps,退出路径上 N 个会话就是 N 次 ps,这里合成一次。
   */
  shutdown(): void {
    clearInterval(this.sweeper);
    clearInterval(this.descendantScanner);
    const table = readProcessTableSync();
    for (const session of [...this.sessions.values()]) {
      session.listeners.clear();
      // 无条件连发,不按 exitCode 筛:组长退了组不一定空(daemonize 形状),而对已空的组
      // 发信号只是 ESRCH,signalTree 兜得住 —— 少一个条件就少一类漏杀。后代 = 实时快照
      // (若 ps 可用)∪ 存续期累积,job-control 的独立组全靠这两份。
      const live = table ? descendantsFromTable(table, session.process.pid) : { pids: [], pgids: [] };
      const descendants: DescendantSnapshot = {
        pids: live.pids,
        pgids: [...new Set([...session.descendantPgids, ...live.pgids])],
      };
      this.signalTree(session, "SIGTERM", descendants);
      this.signalTree(session, "SIGKILL", descendants);
      this.sessions.delete(session.id);
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
      if (this.sessionAlive(session)) continue;
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
   * restart 的容量预检:排除同命令会话(活的会被 terminate、死的会被 create 清掉,
   * 都会让位)后还有没有槽。restart 的顺序是先杀旧再建新,若 create 注定因上限失败,
   * 必须在动手前拒绝 —— 「重启失败」绝不能落成「服务被停了」(第 1 轮审查实锤)。
   */
  hasSlotForCommand(projectId: string, commandId: string): boolean {
    let occupied = 0;
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.commandId === commandId) continue;
      occupied++;
    }
    return occupied < MAX_SESSIONS;
  }

  private session(sessionId: string, projectId?: string): TerminalSession | null {
    const session = this.sessions.get(sessionId) ?? null;
    if (session && (!projectId || session.projectId === projectId)) return session;
    return null;
  }

  private info(session: TerminalSession): TerminalSessionInfo {
    const { id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode, stoppedByUser } = session;
    return {
      id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode, stoppedByUser,
      // 即时探测,不是缓存值:组长退没退(exitCode)和组里有没有活人是两件事。
      groupAlive: this.sessionAlive(session),
    };
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

export function resolveTerminalDirectory(repoPath: string | null | undefined): string | null {
  const resolved = expandHome(repoPath);
  try { return resolved && statSync(resolved).isDirectory() ? resolved : null; } catch { return null; }
}
