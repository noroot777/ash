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
// 命令正文可以带 `{{占位符}}`(shared/src/project-commands.ts):前端点执行时先弹框收值,
// 把**取值**(不是最终脚本)发过来,替换在这里做 —— 客户端始终无权指定跑什么,跑的永远是
// 库里存的那条命令。必填项缺失一律 400,绝不把 `{{分支}}` 原样交给 shell。
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
import {
  fillCommandPlaceholders,
  normalizeProjectCommands,
  parseCommandPlaceholders,
  parseCommandValues,
  SERVICE_COMMAND_ID,
} from "@ash/shared/project-commands";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { instanceAdminOnly } from "./auth/context.js";
import { resolveTerminalDirectory, terminalSessions } from "./terminal.js";

/**
 * 会话层跑的一条命令。restartCommand 只有项目级 service 才有(配置见
 * shared/src/project-commands.ts):普通命令的重启一律「杀掉再跑一遍 command」。
 */
export type RunnableCommand = { id: string; name: string; command: string; restartCommand: string | null };

/** service 会话在终端 tab / 状态栏「其他项目」里的显示名。 */
const SERVICE_SESSION_NAME = "服务";

type CommandTarget =
  | { ok: true; cwd: string; command: RunnableCommand }
  | { ok: false; error: string; status: 400 | 404 };

async function commandTarget(projectId: string, commandId: string): Promise<CommandTarget> {
  const project = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  if (!project) return { ok: false, error: "项目不存在", status: 404 };
  const config = normalizeProjectCommands(project.commandsConfig);
  let command: RunnableCommand | null = null;
  if (commandId === SERVICE_COMMAND_ID) {
    // 项目级「启动/重启」:弹层头部的 ▶/⟳,不占普通命令的名额。
    if (config?.service) {
      command = { id: SERVICE_COMMAND_ID, name: SERVICE_SESSION_NAME, ...config.service };
    }
    if (!command) return { ok: false, error: "还没配置启动命令，先在项目设置的常用命令里填写", status: 404 };
  } else {
    const found = (config?.commands ?? []).find((item) => item.id === commandId);
    if (!found) return { ok: false, error: "这条常用命令不存在（可能刚被删除），刷新后再试", status: 404 };
    command = { ...found, restartCommand: null };
  }
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
export type CommandActionResult = { status: 200 | 201 | 400 | 500 | 502; body: Record<string, unknown> };

/** 这次实际要跑的脚本:模板填上占位符取值。必填项缺失 → 400,不落成「启动失败」。 */
type ResolvedScript = { ok: true; script: string; name: string } | { ok: false; result: CommandActionResult };

function resolveScript(command: RunnableCommand, template: string, values: Record<string, string>): ResolvedScript {
  let script: string;
  try {
    script = fillCommandPlaceholders(template, values);
  } catch (error) {
    return { ok: false, result: { status: 400, body: { error: error instanceof Error ? error.message : "占位符取值无效" } } };
  }
  return { ok: true, script, name: sessionName(command.name, template, values) };
}

/**
 * 带占位符的命令,会话名后面缀上这次用的取值 —— 终端 tab 和状态栏「其他项目在跑的」
 * 只显示名字,不缀就看不出「这条 checkout 到底跑的哪个分支」。脚本本身不回显给终端。
 */
function sessionName(name: string, template: string, values: Record<string, string>): string {
  const used = parseCommandPlaceholders(template)
    .map((placeholder) => values[placeholder.name] || placeholder.defaultValue || "")
    .filter(Boolean)
    .join(" ");
  if (!used) return name;
  return `${name} · ${used.length > 40 ? `${used.slice(0, 39)}…` : used}`;
}

/** 启动。幂等:已经在跑就原样返回那条会话(状态栏两个终端里各点一次不该起两份)。 */
export function startCommand(
  projectId: string,
  cwd: string,
  command: RunnableCommand,
  values: Record<string, string> = {},
): Promise<CommandActionResult> {
  return withCommandLock(projectId, command.id, async () => {
    // 项目正在删除:拒绝启动,别把正被 destroyProject 杀掉的旧会话当「已在跑」交还
    // (会误导前端 + 竞态下可能残留,第 2 轮自由审查)。
    if (terminalSessions.isProjectClosing(projectId)) {
      return { status: 500 as const, body: { error: "启动失败：项目正在删除" } };
    }
    const live = terminalSessions.liveCommandSession(projectId, command.id);
    if (live) return { status: 200 as const, body: { session: live, alreadyRunning: true } };
    const resolved = resolveScript(command, command.command, values);
    if (!resolved.ok) return resolved.result;
    try {
      const session = terminalSessions.create(projectId, cwd, {
        command: { id: command.id, name: resolved.name, script: resolved.script },
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

export function restartCommand(
  projectId: string,
  cwd: string,
  command: RunnableCommand,
  values: Record<string, string> = {},
): Promise<CommandActionResult> {
  return withCommandLock(projectId, command.id, async () => {
    // 项目正在删除:拒绝重启(同 startCommand)。
    if (terminalSessions.isProjectClosing(projectId)) {
      return { status: 500 as const, body: { error: "重启失败：项目正在删除" } };
    }
    // 先确认建得出替代会话再动手杀旧的:create 若注定因会话上限失败,「重启失败」
    // 会落成「服务被停了」。同命令会话不占这个判断(它们都会让位)。
    if (!terminalSessions.hasSlotForCommand(projectId, command.id)) {
      return { status: 500 as const, body: { error: "重启失败：终端会话数量已达上限" } };
    }
    // 占位符也在杀之前填 —— 同一个理由:取值不合法就该原地拒绝,而不是先把服务停了。
    const resolved = resolveScript(command, command.restartCommand ?? command.command, values);
    if (!resolved.ok) return resolved.result;
    const live = terminalSessions.liveCommandSession(projectId, command.id);
    if (live) {
      const result = await terminalSessions.terminate(live.id, projectId);
      if (!result.ok) return { status: 502 as const, body: { error: `重启失败：旧进程停不下来（${result.reason}）` } };
    }
    try {
      const session = terminalSessions.create(projectId, cwd, {
        command: { id: command.id, name: resolved.name, script: resolved.script },
      });
      return { status: 201 as const, body: { session } };
    } catch (error) {
      return { status: 500 as const, body: { error: `重启失败：${error instanceof Error ? error.message : String(error)}` } };
    }
  });
}

/** 请求体里的占位符取值（`{ values: { 分支: "main" } }`）。没有 body 也合法 = 没占位符。 */
async function commandValues(c: { req: { json: () => Promise<unknown> } }): Promise<
  { ok: true; values: Record<string, string> } | { ok: false; error: string }
> {
  const body = await c.req.json().catch(() => null);
  try {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>).values : null;
    return { ok: true, values: parseCommandValues(record) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "占位符取值无效" };
  }
}

export function mountProjectCommandRoutes(api: Hono): void {  api.use("/projects/:projectId/commands/*", async (c, next) => {
    const denied = await instanceAdminOnly(c, "常用命令");
    if (denied) return c.json(denied.body, denied.status);
    return next();
  });

  api.post("/projects/:projectId/commands/:commandId/start", async (c) => {
    const projectId = c.req.param("projectId");
    const target = await commandTarget(projectId, c.req.param("commandId"));
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const values = await commandValues(c);
    if (!values.ok) return c.json({ error: values.error }, 400);
    const result = await startCommand(projectId, target.cwd, target.command, values.values);
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
    const values = await commandValues(c);
    if (!values.ok) return c.json({ error: values.error }, 400);
    const result = await restartCommand(projectId, target.cwd, target.command, values.values);
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
