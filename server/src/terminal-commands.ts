// 常用命令(shared/src/project-commands.ts)的启停路由。运行载体是 terminal.ts 的
// 命令会话(commandId 非空的那类 pty):
//
//   启动   = 起一个 `shell -lc <command>` 的会话,进程退出即会话结束(exitCode 落会话上)
//   停止   = terminate 活会话:进程组 SIGTERM → 超时 SIGKILL → 仍不退如实报 502。
//            会话**保留**(日志可回看、状态显示「已停止」),不是删除 —— 见 terminate 注释。
//   重启   = 先 terminate 活会话,**确认旧进程退了**再用 restartCommand || command 起新会话
//            (否则新旧抢端口,新的挂、旧的失控)。重启永远先杀 —— restartCommand 替换的是
//            「重新启动用什么命令」(例如 `expo start -c`),不是「不杀进程的原地重载」。
//
// 三个动作都按 (projectId, commandId) **串行化**(withCommandLock):它们全是
// 「查活会话 → 做点慢事 → 起/停」的形状,并发下两边都查到同一个现场,双双起新会话
// 就是两个实例抢一个端口(第 2 轮审查用并发 restart 实锤)。锁内只有本条命令的操作,
// 不同命令互不排队。路由层是这些服务函数的薄壳,回归测试直接调函数。
//
// 权限与终端同一道门(实例管理员/自用):这些命令是任意 shell,门禁理由见
// terminal.ts mountTerminalRoutes 顶部。
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { ProjectCommandConfig } from "@ash/shared/project-commands";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { instanceAdminOnly } from "./auth/context.js";
import { resolveTerminalDirectory, terminalSessions } from "./terminal.js";

type CommandTarget =
  | { ok: true; cwd: string; command: ProjectCommandConfig }
  | { ok: false; error: string; status: 400 | 404 };

async function commandTarget(projectId: string, commandId: string): Promise<CommandTarget> {
  const project = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  if (!project) return { ok: false, error: "项目不存在", status: 404 };
  const command = (project.commandsConfig ?? []).find((item) => item.id === commandId);
  if (!command) return { ok: false, error: "这条常用命令不存在（可能刚被删除），刷新后再试", status: 404 };
  const cwd = resolveTerminalDirectory(project.repoPath);
  if (!cwd) return { ok: false, error: "项目目录不存在，请先在项目设置中填写可用的本地目录", status: 400 };
  return { ok: true, cwd, command };
}

const commandLocks = new Map<string, Promise<unknown>>();

function withCommandLock<T>(projectId: string, commandId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${projectId}:${commandId}`;
  const prev = commandLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  commandLocks.set(key, tail);
  void tail.finally(() => { if (commandLocks.get(key) === tail) commandLocks.delete(key); });
  return next;
}

/** 服务函数统一返回 HTTP 形状,路由原样透传;测试直接调函数、断言 body。 */
export type CommandActionResult = { status: 200 | 201 | 500 | 502; body: Record<string, unknown> };

/** 启动。幂等:已经在跑就原样返回那条会话(状态栏两个终端里各点一次不该起两份)。 */
export function startCommand(projectId: string, cwd: string, command: ProjectCommandConfig): Promise<CommandActionResult> {
  return withCommandLock(projectId, command.id, async () => {
    const live = terminalSessions.liveCommandSession(projectId, command.id);
    if (live) return { status: 200 as const, body: { session: live, alreadyRunning: true } };
    try {
      const session = terminalSessions.create(projectId, cwd, {
        command: { id: command.id, name: command.name, script: command.command },
      });
      return { status: 201 as const, body: { session } };
    } catch (error) {
      return { status: 500 as const, body: { error: `启动失败：${error instanceof Error ? error.message : String(error)}` } };
    }
  });
}

/** 停止。本来就没在跑也回 200(调用方要的是「停着」这个终态);但杀不死绝不谎报。 */
export function stopCommand(projectId: string, commandId: string): Promise<CommandActionResult> {
  return withCommandLock(projectId, commandId, async () => {
    const live = terminalSessions.liveCommandSession(projectId, commandId);
    if (!live) return { status: 200 as const, body: { stopped: false } };
    const result = await terminalSessions.terminate(live.id, projectId);
    if (!result.ok) return { status: 502 as const, body: { error: `停止失败：${result.reason}` } };
    return { status: 200 as const, body: { stopped: true } };
  });
}

export function restartCommand(projectId: string, cwd: string, command: ProjectCommandConfig): Promise<CommandActionResult> {
  return withCommandLock(projectId, command.id, async () => {
    const live = terminalSessions.liveCommandSession(projectId, command.id);
    if (live) {
      const result = await terminalSessions.terminate(live.id, projectId);
      if (!result.ok) return { status: 502 as const, body: { error: `重启失败：旧进程停不下来（${result.reason}）` } };
    }
    try {
      const script = command.restartCommand ?? command.command;
      const session = terminalSessions.create(projectId, cwd, {
        command: { id: command.id, name: command.name, script },
      });
      return { status: 201 as const, body: { session } };
    } catch (error) {
      return { status: 500 as const, body: { error: `重启失败：${error instanceof Error ? error.message : String(error)}` } };
    }
  });
}

export function mountProjectCommandRoutes(api: Hono): void {
  api.use("/projects/:projectId/commands/*", async (c, next) => {
    const denied = await instanceAdminOnly(c, "常用命令");
    if (denied) return c.json(denied.body, denied.status);
    return next();
  });

  api.post("/projects/:projectId/commands/:commandId/start", async (c) => {
    const projectId = c.req.param("projectId");
    const target = await commandTarget(projectId, c.req.param("commandId"));
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const result = await startCommand(projectId, target.cwd, target.command);
    return c.json(result.body, result.status);
  });

  api.post("/projects/:projectId/commands/:commandId/stop", async (c) => {
    const result = await stopCommand(c.req.param("projectId"), c.req.param("commandId"));
    return c.json(result.body, result.status);
  });

  api.post("/projects/:projectId/commands/:commandId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const target = await commandTarget(projectId, c.req.param("commandId"));
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const result = await restartCommand(projectId, target.cwd, target.command);
    return c.json(result.body, result.status);
  });

  // 全局汇总(所有项目的命令会话,含刚退出还没回收的):状态栏「运行中 N」和它的弹层
  // 都吃这一个端点 —— 任务模式(G T)下没有锚定项目,徽标必须是跨项目的总数才不撒谎。
  api.get("/terminal-commands", async (c) => {
    const denied = await instanceAdminOnly(c, "常用命令");
    if (denied) return c.json(denied.body, denied.status);
    return c.json({ sessions: terminalSessions.listCommandSessions() });
  });
}
