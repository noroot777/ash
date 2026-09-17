import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
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
    session.process.write(data);
    return true;
  }

  resize(sessionId: string, projectId: string, cols: number, rows: number): boolean {
    const session = this.session(sessionId, projectId);
    if (!session) return false;
    session.lastAccessedAt = Date.now();
    session.process.resize(terminalSize(cols, 100, 20, 400), terminalSize(rows, 24, 5, 200));
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

  shutdown(): void {
    clearInterval(this.sweeper);
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId);
  }

  sweepIdleSessions(now = Date.now()): number {
    const cutoff = now - IDLE_TTL_MS;
    let closed = 0;
    for (const session of this.sessions.values()) {
      // A subscriber means the CLI is still open, even when the shell is silent.
      if (session.listeners.size > 0 || session.lastAccessedAt >= cutoff) continue;
      // 活着的常用命令会话是「常驻服务」，没人盯着看不是退出的理由 —— 只有它自己退了
      // （exitCode 非 null）才回到普通回收轨道，让退出日志保留半小时可回看。
      if (session.commandId !== null && session.exitCode === null) continue;
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

  /** 某条常用命令当前活着的会话；退了的不算（重启/再启动要在旁边起新会话）。 */
  liveCommandSession(projectId: string, commandId: string): TerminalSessionInfo | null {
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.commandId === commandId && session.exitCode === null) {
        return this.info(session);
      }
    }
    return null;
  }

  private session(sessionId: string, projectId?: string): TerminalSession | null {
    const session = this.sessions.get(sessionId) ?? null;
    if (session && (!projectId || session.projectId === projectId)) return session;
    return null;
  }

  private info(session: TerminalSession): TerminalSessionInfo {
    const { id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode } = session;
    return { id: sessionId, projectId, cwd, shell, name, commandId, startedAt, exitCode };
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
  // 而不是新建，普通 shell 则永远新建（它的生命周期跟着前端 tab 走）。
  api.get("/projects/:projectId/terminal/sessions", (c) => {
    return c.json({ sessions: terminalSessions.listForProject(c.req.param("projectId")) });
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

  api.delete("/projects/:projectId/terminal/sessions/:sessionId", (c) => {
    terminalSessions.close(c.req.param("sessionId"), c.req.param("projectId"));
    return c.body(null, 204);
  });
}
