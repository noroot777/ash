import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as pty from "node-pty";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { expandHome } from "./git.js";
import { id } from "./util.js";

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
};

function terminalSize(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function shellCommand(): { shell: string; args: string[] } {
  const shell = process.env.SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
  return { shell, args: ["-l"] };
}

function ptyEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", HARNESS_TERMINAL: "1" };
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  create(projectId: string, cwd: string, options: CreateOptions = {}): TerminalSessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("终端会话数量已达上限");
    const fallback = shellCommand();
    const shell = options.shell ?? fallback.shell;
    const args = options.shellArgs ?? fallback.args;
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
      name: basename(cwd) || cwd,
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
      this.publish(session, { type: "exit", exitCode, signal });
    });
    return info;
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

  private session(sessionId: string, projectId?: string): TerminalSession | null {
    const session = this.sessions.get(sessionId) ?? null;
    if (session && (!projectId || session.projectId === projectId)) return session;
    return null;
  }

  private info(session: TerminalSession): TerminalSessionInfo {
    const { id: sessionId, projectId, cwd, shell, name } = session;
    return { id: sessionId, projectId, cwd, shell, name };
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

  private sweep(): void {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const session of this.sessions.values()) {
      if (session.lastAccessedAt < cutoff) this.close(session.id);
    }
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
