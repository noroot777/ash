// 常用命令(shared/src/project-commands.ts)的启停路由。运行载体是 terminal.ts 的
// 命令会话(commandId 非空的那类 pty):
//
//   启动   = 起一个 `shell -lc <command>` 的会话,进程退出即会话结束(exitCode 落会话上)
//   停止   = 杀掉活会话(pty.kill → shell 整棵收 SIGHUP)
//   重启   = 杀掉活会话后,用 restartCommand || command 起**新**会话。重启永远先杀 ——
//            restartCommand 替换的是「重新启动用什么命令」(例如 `expo start -c`),
//            不是「不杀进程的原地重载」。
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

function startSession(projectId: string, cwd: string, command: ProjectCommandConfig, script: string) {
  return terminalSessions.create(projectId, cwd, {
    command: { id: command.id, name: command.name, script },
  });
}

export function mountProjectCommandRoutes(api: Hono): void {
  api.use("/projects/:projectId/commands/*", async (c, next) => {
    const denied = await instanceAdminOnly(c, "常用命令");
    if (denied) return c.json(denied.body, denied.status);
    return next();
  });

  // 启动。幂等:已经在跑就原样返回那条会话(状态栏两个终端里各点一次不该起两份)。
  api.post("/projects/:projectId/commands/:commandId/start", async (c) => {
    const projectId = c.req.param("projectId");
    const target = await commandTarget(projectId, c.req.param("commandId"));
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const live = terminalSessions.liveCommandSession(projectId, target.command.id);
    if (live) return c.json({ session: live, alreadyRunning: true });
    try {
      return c.json({ session: startSession(projectId, target.cwd, target.command, target.command.command) }, 201);
    } catch (error) {
      return c.json({ error: `启动失败：${error instanceof Error ? error.message : String(error)}` }, 500);
    }
  });

  // 停止。幂等:本来就没在跑也回 200 —— 调用方要的是「停着」这个终态,不是这次调用杀没杀到。
  api.post("/projects/:projectId/commands/:commandId/stop", async (c) => {
    const projectId = c.req.param("projectId");
    const live = terminalSessions.liveCommandSession(projectId, c.req.param("commandId"));
    if (live) terminalSessions.close(live.id, projectId);
    return c.json({ stopped: live !== null });
  });

  api.post("/projects/:projectId/commands/:commandId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const target = await commandTarget(projectId, c.req.param("commandId"));
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const live = terminalSessions.liveCommandSession(projectId, target.command.id);
    if (live) terminalSessions.close(live.id, projectId);
    try {
      const script = target.command.restartCommand ?? target.command.command;
      return c.json({ session: startSession(projectId, target.cwd, target.command, script) }, 201);
    } catch (error) {
      return c.json({ error: `重启失败：${error instanceof Error ? error.message : String(error)}` }, 500);
    }
  });

  // 全局汇总(所有项目的命令会话,含刚退出还没回收的):状态栏「运行中 N」和它的弹层
  // 都吃这一个端点 —— 任务模式(G T)下没有锚定项目,徽标必须是跨项目的总数才不撒谎。
  api.get("/terminal-commands", async (c) => {
    const denied = await instanceAdminOnly(c, "常用命令");
    if (denied) return c.json(denied.body, denied.status);
    return c.json({ sessions: terminalSessions.listCommandSessions() });
  });
}
