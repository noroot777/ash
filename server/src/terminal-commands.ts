// 常用命令(shared/src/project-commands.ts)的启停路由。运行载体是 terminal.ts 的
// 命令会话(commandId 非空的那类 pty):
//
//   启动   = 起一个 `shell -lc <command>` 的会话,进程退出即会话结束(exitCode 落会话上)
//   停止   = terminate 活会话:进程组 SIGTERM → 超时 SIGKILL → 仍不退如实报 502。
//            会话**保留**(日志可回看、状态显示「已停止」),不是删除 —— 见 terminate 注释。
//            service 配了 stopCommand 就先跑那段脚本(runStopScript),再确认会话退了 ——
//            杀进程仍是兜底,不是「脚本跑过就算停了」。
//   重启   = 先停旧的(配了 stopCommand 就走同一条停法),**确认旧进程退了**再用
//            restartCommand || command 起新会话(否则新旧抢端口,新的挂、旧的失控)。
//            restartCommand 替换的是「重新启动用什么命令」(例如 `expo start -c`),
//            不是「不杀进程的原地重载」。
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
import { spawn, type ChildProcess } from "node:child_process";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { instanceAdminOnly } from "./auth/context.js";
import { IS_WINDOWS } from "./platform.js";
import { resolveTerminalDirectory, terminalSessions, type TerminalSessionInfo } from "./terminal.js";
import { commandLaunch } from "./terminal-shell.js";

/**
 * 会话层跑的一条命令。restartCommand / stopCommand 只有项目级 service 才有(配置见
 * shared/src/project-commands.ts):普通命令的重启一律「杀掉再跑一遍 command」,停止一律杀进程组。
 */
export type RunnableCommand = {
  id: string;
  name: string;
  command: string;
  restartCommand: string | null;
  stopCommand: string | null;
};

/** 停止命令跑多久算卡住。优雅下线可能要十几秒(容器停、缓存落盘),但不能无限占着那把命令锁。 */
const STOP_SCRIPT_TIMEOUT_MS = 60_000;
/** 停止脚本的两路输出各留这么多,够回显最后几行就行(自己截,不靠 execFile 的 maxBuffer)。 */
const STOP_OUTPUT_KEEP = 64 * 1024;
/** 停止脚本跑完,再给启动会话这么久自己退场 —— 它刚被脚本停掉,多半正在收尾,不必急着补一发 TERM。 */
const STOP_GRACE_MS = 3_000;

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
    command = { ...found, restartCommand: null, stopCommand: null };
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

/** 这条命令最近一次会话(活的优先,否则最后开的那条)。口径与弹层的 bestSession 一致。 */
function latestSession(projectId: string, commandId: string): TerminalSessionInfo | null {
  const mine = terminalSessions.listCommandSessions()
    .filter((session) => session.projectId === projectId && session.commandId === commandId);
  return mine.find((session) => session.groupAlive) ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/**
 * 这条命令现在「开着」吗 —— **前端那颗按钮亮不亮用的是同一套口径**
 * (web/src/workspace/CommandsLauncher.tsx 的 serviceOpen),两边必须一致,否则会出现
 * 「停止按钮摆在那儿、点下去什么都没发生」。
 *
 * 活会话 = 确定在跑。**配了停止命令**时,正常退出(exit 0)又没被停过的那次启动也算开着:
 * `docker compose up -d`、`pm2 start` 这类启动脚本跑完自己就退,服务活在 ash 的进程树之外,
 * 会话死了不代表它停了。没配停止命令就不作这个推断 —— 那条路只能杀进程,进程没了就是停了。
 */
function openSession(projectId: string, commandId: string, stopScript: string | null): TerminalSessionInfo | null {
  const session = latestSession(projectId, commandId);
  if (!session) return null;
  if (session.groupAlive) return session;
  if (!stopScript) return null;
  return session.exitCode === 0 && !session.stoppedByUser ? session : null;
}

/** 停止脚本失败时给用户看的那几行:有 stderr 就说 stderr,只留最后 3 行、封顶 300 字。 */
function outputTail(out: string, err: string): string {
  const tail = (err.trim() ? err : out)
    .split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).join(" / ");
  return tail.length > 300 ? `${tail.slice(0, 299)}…` : tail;
}

/** 超时那一发:POSIX 打在整个进程组(下面是 detached 起的组),Windows 没有进程组,只杀它自己。 */
function killScriptGroup(child: ChildProcess): void {
  try {
    if (!IS_WINDOWS && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } }
}

/**
 * 跑用户配置的停止命令,**保证在时限内落地**。方言跟启动同一套(commandLaunch:POSIX 是
 * `shell -lc`,Windows 是 PowerShell `-EncodedCommand`),但**不开 pty、不建会话**:停止没有
 * 「现场」可看,它只有成或不成 —— 新开一条会话只会搅乱会话表(那边按 commandId 认人),
 * 失败时把最后几行输出带回去就够。
 *
 * 自己计时、自己收敛,**不能用 execFile 的 timeout**:那一档到点只补发一次 SIGTERM,脚本
 * 写了 `trap '' TERM` 就彻底拖住 —— 回调绑在 stdio 的 close 上,promise 永不落地,外面那把
 * withCommandLock 跟着永远不释放,这条命令的启停全部排队到死(第 1 轮审查 E2 实锤)。
 * 同理只等 `exit`、不等 `close`:脚本把服务拉到后台、子进程继承了管道时,close 要等那个
 * 后台进程也退出才来(E3),而「停止脚本跑完了」说的是**脚本自己**退了。
 * 到点那一发打在整个进程组上,否则只杀掉 shell、它拉起的东西继续跑;杀完立刻落地,不等
 * 它的 exit —— 万一它卡在不可中断的系统调用里,那把锁不能跟着一起卡死。
 */
function runStopScript(cwd: string, script: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  type Result = { ok: true } | { ok: false; reason: string };
  let launch: { shell: string; args: string[] };
  try { launch = commandLaunch(script); }
  catch (error) { return Promise.resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) }); }
  return new Promise<Result>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.shell, launch.args, {
        cwd,
        detached: !IS_WINDOWS, // 独立进程组:超时要连它拉起的东西一起收掉
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, reason: `停止命令跑不起来（${error instanceof Error ? error.message : String(error)}）` });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: Result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const fail = (why: string) => {
      const tail = outputTail(out, err);
      settle({ ok: false, reason: tail ? `${why}：${tail}` : why });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => { out = (out + text).slice(-STOP_OUTPUT_KEEP); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => { err = (err + text).slice(-STOP_OUTPUT_KEEP); });
    child.on("error", (error) => fail(`停止命令跑不起来（${error.message}）`));
    child.on("exit", (code, signal) => {
      if (code === 0) { settle({ ok: true }); return; }
      fail(code === null ? `停止命令被信号 ${signal} 中断` : `停止命令退出码 ${code}`);
    });
    timer = setTimeout(() => {
      killScriptGroup(child);
      fail(`停止命令超过 ${Math.round(timeoutMs / 1000)} 秒还没结束，已经把它和它拉起的进程一起杀掉`);
    }, timeoutMs);
  });
}

/** 停止脚本跑完后等启动会话自己退场(到点就算了,后面还有 terminate 兜底)。 */
async function waitForSessionGone(projectId: string, commandId: string): Promise<void> {
  const deadline = Date.now() + STOP_GRACE_MS;
  while (terminalSessions.liveCommandSession(projectId, commandId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
      const session = await terminalSessions.createAsync(projectId, cwd, {
        command: { id: command.id, name: resolved.name, script: resolved.script },
      });
      return { status: 201 as const, body: { session } };
    } catch (error) {
      return { status: 500 as const, body: { error: `启动失败：${error instanceof Error ? error.message : String(error)}` } };
    }
  });
}

/**
 * 停止。本来就没在跑也回 200(调用方要的是「停着」这个终态);但杀不死绝不谎报。
 *
 * stop 带着脚本来(service 配了停止命令)时:先跑脚本,再确认启动会话退了 —— 没退照样
 * terminate,**停止命令是更体面的前半程,不是「脚本跑过就算停了」的免责**。反过来,脚本
 * 自己失败时原地报错、不强杀:用户写那段脚本正是不想让 ash 直接 kill,这时留着现场让他看
 * 日志、改脚本、再点一次更对(真要硬停,终端里关掉那条会话仍然会杀进程组)。
 */
export function stopCommand(
  projectId: string,
  commandId: string,
  /** timeoutMs 缺省就是 STOP_SCRIPT_TIMEOUT_MS;回归拿它把一分钟缩成毫秒级,不必真等。 */
  stop: { script: string; cwd: string; timeoutMs?: number } | null = null,
): Promise<CommandActionResult> {
  return withCommandLock(projectId, commandId, async () => {
    const open = openSession(projectId, commandId, stop?.script ?? null);
    if (!open) return { status: 200 as const, body: { stopped: false } };
    if (stop) {
      const ran = await runStopScript(stop.cwd, stop.script, stop.timeoutMs ?? STOP_SCRIPT_TIMEOUT_MS);
      if (!ran.ok) return { status: 502 as const, body: { error: `停止失败：${ran.reason}` } };
      await waitForSessionGone(projectId, commandId);
    }
    const live = terminalSessions.liveCommandSession(projectId, commandId);
    if (live) {
      const result = await terminalSessions.terminate(live.id, projectId);
      if (!result.ok) return { status: 502 as const, body: { error: `停止失败：${result.reason}` } };
    } else {
      // 启动脚本早就退了(服务在 ash 的进程树之外):没有进程可杀,但「我点过停止」要留下来。
      terminalSessions.markCommandStopped(projectId, commandId);
    }
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
    // 占位符也在杀之前填 —— 同一个理由:取值不合法就该原地拒绝,而不是先把服务停了。
    const resolved = resolveScript(command, command.restartCommand ?? command.command, values);
    if (!resolved.ok) return resolved.result;
    try {
      const reservation = terminalSessions.reserveCommand(projectId, command.id);
      try {
        // 配了停止命令:重启的前半程也走它 —— 否则同一个服务,点停止是优雅下线、点重启却被
        // 直接 kill,两颗按钮对不上。停不下来就别起新的(端口还占着,新的只会挂)。
        if (command.stopCommand && openSession(projectId, command.id, command.stopCommand)) {
          const ran = await runStopScript(cwd, command.stopCommand, STOP_SCRIPT_TIMEOUT_MS);
          if (!ran.ok) return { status: 502 as const, body: { error: `重启失败：旧服务没停下来（${ran.reason}）` } };
          await waitForSessionGone(projectId, command.id);
        }
        const live = terminalSessions.liveCommandSession(projectId, command.id);
        if (live) {
          const result = await terminalSessions.terminate(live.id, projectId);
          if (!result.ok) return { status: 502 as const, body: { error: `重启失败：旧进程停不下来（${result.reason}）` } };
        }
        const session = await reservation.create(cwd, { name: resolved.name, script: resolved.script });
        return { status: 201 as const, body: { session } };
      } finally { reservation.release(); }
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
    const projectId = c.req.param("projectId");
    const commandId = c.req.param("commandId");
    // 配置可能刚被删掉、现场却还在跑:停止是对**现场**的动作,拿不到配置就退回默认的
    // 「杀掉进程组」,绝不因为配置没了就停不下来(所以这里不像 start/restart 那样 404)。
    const target = await commandTarget(projectId, commandId);
    const stop = target.ok && target.command.stopCommand
      ? { script: target.command.stopCommand, cwd: target.cwd }
      : null;
    const result = await stopCommand(projectId, commandId, stop);
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
