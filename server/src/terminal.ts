import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as pty from "node-pty";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { resolveBin } from "./executors/bin-resolve.js";
import { expandHome } from "./git.js";
import { IS_WINDOWS } from "./platform.js";
import { id } from "./util.js";
import { instanceAdminOnly } from "./auth/context.js";

const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_SESSIONS = 16;
const IDLE_TTL_MS = 30 * 60 * 1000;

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

/** 进程组里还有没有活人:信号 0 只探测不打扰,整组已空时抛 ESRCH。Windows 没有进程组。 */
function groupAlive(groupId: number): boolean {
  if (IS_WINDOWS) return false;
  try { process.kill(-groupId, 0); return true; } catch { return false; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const execFileAsync = promisify(execFile);

type DescendantSnapshot = { pids: number[]; pgids: number[] };

/**
 * 组长进程的全部后代(pid)与它们**自己的进程组**(pgid)。交互 shell 开着 job control:
 * 每个后台作业 setpgid 进独立进程组,`kill(-组长pgid)` 够不着它们 —— 忽略 HUP/TERM 的
 * 后台作业会被 PID 1 收养继续跑(第 1 轮自由审查实锤)。必须在**发信号之前**快照:组长
 * 一死后代就被收养,ppid 树的线索当场断掉。ps 不可用时退回空快照(= 只杀组长的组,
 * 即原有行为)。pgid ≤ 1 一律不收:kill(-1) 是「向所有能杀的进程广播」,绝不能碰。
 */
async function snapshotDescendants(rootPid: number): Promise<DescendantSnapshot> {
  if (IS_WINDOWS) return { pids: [], pgids: [] };
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid="]);
    const children = new Map<number, number[]>();
    const pgidOf = new Map<number, number>();
    for (const line of stdout.split("\n")) {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      if (!pid || Number.isNaN(ppid) || Number.isNaN(pgid)) continue;
      pgidOf.set(pid, pgid);
      const siblings = children.get(ppid) ?? [];
      siblings.push(pid);
      children.set(ppid, siblings);
    }
    const pids: number[] = [];
    const pgids = new Set<number>();
    const queue = [rootPid];
    while (queue.length) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (child <= 1) continue;
        pids.push(child);
        const pgid = pgidOf.get(child);
        if (pgid !== undefined && pgid > 1 && pgid !== rootPid) pgids.add(pgid);
        queue.push(child);
      }
    }
    return { pids, pgids: [...pgids] };
  } catch {
    return { pids: [], pgids: [] };
  }
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

  constructor() {
    this.sweeper = setInterval(() => this.sweepIdleSessions(), 60_000);
    this.sweeper.unref?.();
  }

  create(projectId: string, cwd: string, options: CreateOptions = {}): TerminalSessionInfo {
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
    };
    this.sessions.set(info.id, session);
    processHandle.onData((data) => this.publish(session, { type: "data", data }));
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

  close(sessionId: string, projectId?: string): boolean {
    const session = this.session(sessionId, projectId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.listeners.clear();
    try { session.process.kill(); } catch { /* the shell already exited */ }
    return true;
  }

  /**
   * 停止一个会话但**保留现场**:会话不删、缓冲日志不丢,退出码照常经 onExit 落在会话上
   * —— 停止是用户动作,刷新页面后要看得出「我停过」(根 AGENTS.md 的硬要求),所以它和
   * close(关掉 tab、连日志一起丢)是两个动词。
   *
   * 杀的是**整个进程组 + 发信号前快照到的全部后代**(pty 子进程 fork 后 setsid,组长就是
   * 它自己,dev server 派生的子进程都在组里;交互 shell 的 job control 会把后台作业挪进
   * 独立进程组,靠快照逐组覆盖):SIGTERM 给进程收尾的机会,等不到**整组+后代清空**再
   * SIGKILL 兜底;两轮都压不住(基本只剩 D 状态)就如实返回失败,绝不把「没杀死」报成
   * 「已停」—— 会话还在,UI 可重试。判定必须是「组长退了 **且** 组里没人 **且** 快照后代
   * 全消失」:`cmd & wait` 这种形状下组长(shell)收 TERM 先死,忽略信号的后台子进程还
   * 占着端口,只看组长就会漏杀(第 2 轮审查实锤)。双 fork 后立刻被 PID 1 收养的守护
   * 进程在快照前就断了树的线索,超出本方法能力,属已知边界。
   */
  async terminate(
    sessionId: string,
    projectId?: string,
    timeouts?: { termMs?: number; killMs?: number },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const session = this.session(sessionId, projectId);
    if (!session) return { ok: true };
    const groupId = session.process.pid;
    if (session.exitCode !== null && !groupAlive(groupId)) return { ok: true };
    session.stoppedByUser = true;
    // 后代快照必须在发信号之前拿(见 snapshotDescendants):交互 shell 里 job control
    // 把每个后台作业挪进了独立进程组,只对组长的组发信号会漏杀。
    const descendants = await snapshotDescendants(groupId);
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

  /**
   * server 退出前的清场:对每个还活着的会话**整组** SIGTERM+SIGKILL 连发。必须是同步的
   * ('exit' 钩子里没有 await),所以没有优雅等待窗口 —— 命令会话跑的是 dev server/watch
   * 这类可随时重启的进程,强杀可接受;不杀的代价是它们被 PID 1 收养成孤儿,ash 重启后
   * UI/API 失忆显示「未启动」,旧进程却还占着端口。不能走 close():那只对组长单发一次
   * SIGHUP,`cmd & wait` 里忽略信号的子进程杀不掉。
   */
  shutdown(): void {
    clearInterval(this.sweeper);
    for (const session of [...this.sessions.values()]) {
      session.listeners.clear();
      // 无条件连发,不按 exitCode 筛:组长退了组不一定空(daemonize 形状),而对已空的组
      // 发信号只是 ESRCH,signalTree 兜得住 —— 少一个条件就少一类漏杀。
      this.signalTree(session, "SIGTERM");
      this.signalTree(session, "SIGKILL");
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

  /** 这条会话是否还有活着的进程:组长没退,或组长退了但同组子进程还在(daemonize 形状)。 */
  private sessionAlive(session: TerminalSession): boolean {
    return session.exitCode === null || groupAlive(session.process.pid);
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

async function projectDirectory(projectId: string): Promise<string | null> {
  const project = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  return resolveTerminalDirectory(project?.repoPath);
}

export function resolveTerminalDirectory(repoPath: string | null | undefined): string | null {
  const resolved = expandHome(repoPath);
  try { return resolved && statSync(resolved).isDirectory() ? resolved : null; } catch { return null; }
}

export function mountTerminalRoutes(api: Hono): void {
  // 终端是**实例管理员专属**(§七):它开的是宿主机上的一个真 shell,项目目录只是
  // 起始 cwd —— 一条 `cd /` 就出去了。给普通用户就等于把「护栏」变成一句空话。
  api.use("/projects/:projectId/terminal/*", async (c, next) => {
    const denied = await instanceAdminOnly(c, "终端");
    if (denied) return c.json(denied.body, denied.status);
    return next();
  });

  api.post("/projects/:projectId/terminal/sessions", async (c) => {
    const projectId = c.req.param("projectId");
    const cwd = await projectDirectory(projectId);
    if (!cwd) return c.json({ error: "项目目录不存在，请先在项目设置中填写可用的本地目录" }, 400);
    const body: { cols?: number; rows?: number } = await c.req.json().catch(() => ({}));
    try {
      return c.json(terminalSessions.create(projectId, cwd, body), 201);
    } catch (error) {
      return c.json({ error: `终端启动失败：${error instanceof Error ? error.message : String(error)}` }, 500);
    }
  });

  // 终端抽屉打开时先问一遍「这个项目已经有哪些会话」：常用命令的常驻会话要 attach
  // 而不是新建，普通 shell 则永远新建（它的生命周期跟着前端 tab 走）。项目已删时
  // 404 —— 项目删除会连带清场终端会话,这里再回数据就是在展示幽灵(第 1 轮自由审查)。
  api.get("/projects/:projectId/terminal/sessions", async (c) => {
    const projectId = c.req.param("projectId");
    const row = (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).at(0);
    if (!row) return c.json({ error: "project not found" }, 404);
    return c.json({ sessions: terminalSessions.listForProject(projectId) });
  });

  api.get("/projects/:projectId/terminal/sessions/:sessionId/events", (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    const replay = terminalSessions.eventsAfter(sessionId, projectId, after);
    if (!replay) return c.json({ error: "terminal session not found" }, 404);
    return streamSSE(c, async (stream) => {
      let replaying = true;
      const pending: TerminalEvent[] = [];
      const write = (event: TerminalEvent) => stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
      const unsubscribe = terminalSessions.subscribe(sessionId, projectId, (event) => {
        if (replaying) pending.push(event);
        else void write(event).catch(() => undefined);
      });
      stream.onAbort(() => unsubscribe?.());
      try {
        for (const event of replay) await write(event);
        replaying = false;
        for (const event of pending) await write(event);
        while (!stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "1" });
          await stream.sleep(15_000);
        }
      } catch {
        /* normal disconnect */
      } finally {
        unsubscribe?.();
      }
    });
  });

  api.post("/projects/:projectId/terminal/sessions/:sessionId/input", async (c) => {
    const body: { data?: unknown } = await c.req.json().catch(() => ({}));
    if (typeof body.data !== "string") return c.json({ error: "data required" }, 400);
    if (Buffer.byteLength(body.data) > 64 * 1024) return c.json({ error: "data too large" }, 413);
    if (!terminalSessions.write(c.req.param("sessionId"), c.req.param("projectId"), body.data)) {
      return c.json({ error: "terminal session not found" }, 404);
    }
    return c.body(null, 204);
  });

  api.post("/projects/:projectId/terminal/sessions/:sessionId/resize", async (c) => {
    const body: { cols?: unknown; rows?: unknown } = await c.req.json().catch(() => ({}));
    if (typeof body.cols !== "number" || typeof body.rows !== "number") {
      return c.json({ error: "cols and rows required" }, 400);
    }
    if (!terminalSessions.resize(c.req.param("sessionId"), c.req.param("projectId"), body.cols, body.rows)) {
      return c.json({ error: "terminal session not found" }, 404);
    }
    return c.body(null, 204);
  });

  // 「结束会话」:进程组级终止,确认整组清空才移除会话。杀不净回 502 —— 前端必须
  // 保留 tab 和把手,不能静默收掉(否则忽略 HUP/TERM 的后台作业成 PID 1 孤儿还没人管)。
  api.delete("/projects/:projectId/terminal/sessions/:sessionId", async (c) => {
    const result = await terminalSessions.destroy(c.req.param("sessionId"), c.req.param("projectId"));
    if (!result.ok) return c.json({ error: `结束会话失败：${result.reason}` }, 502);
    return c.body(null, 204);
  });
}
