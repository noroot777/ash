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
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { instanceAdminOnly } from "./auth/context.js";
import { IS_WINDOWS } from "./platform.js";
import { probePorts, stopByPorts, type PortState } from "./service-ports.js";
import { openConfinement, type Confinement } from "./executors/kernel-confine.js";
import { groupAlive } from "./terminal-process-tree.js";
import { resolveTerminalDirectory, terminalSessions, type TerminalSessionInfo } from "./terminal.js";
import { id } from "./util.js";
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

/**
 * 这条命令最近一次会话(还在跑的优先,否则最后开的那条)。「还在跑」的口径与
 * terminal.ts 的 sessionRunning、弹层的 bestSession 逐字一致 —— 只认 groupAlive 会在
 * 守护化形状下挑中一条更早的死会话,于是停止落到错的现场上。
 */
function latestSession(projectId: string, commandId: string): TerminalSessionInfo | null {
  const mine = terminalSessions.listCommandSessions()
    .filter((session) => session.projectId === projectId && session.commandId === commandId);
  return mine.find((session) => session.groupAlive || session.portsAlive)
    ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/**
 * 这条命令现在「开着」吗 —— **前端那颗按钮亮不亮用的是同一套口径**
 * (web/src/workspace/CommandsLauncher.tsx 的 serviceOpen),两边必须一致,否则会出现
 * 「停止按钮摆在那儿、点下去什么都没发生」。
 *
 * 活会话 = 确定在跑。启动脚本退了但**它打印过的本机端口还有人在听**也算开着 —— 真·守护化
 * 的服务(双 fork + setsid)从进程归属里全逃了,端口是仅剩的线索,而且顺着它能真杀到
 * (service-ports.ts),所以这一档**不要求配停止命令**。再往下,**配了停止命令**时,正常退出
 * (exit 0)又没被停过的那次启动也算开着:`docker compose up -d` 这类服务连端口都未必打在
 * 本机(容器里、远端),会话死了不代表它停了,那条停止命令就是用户给的线索。三档都不沾边才
 * 算真停了。
 */
async function openSession(
  projectId: string,
  commandId: string,
  stopScript: string | null,
): Promise<TerminalSessionInfo | null> {
  const session = latestSession(projectId, commandId);
  if (!session) return null;
  if (session.groupAlive || session.portsAlive) return session;
  // 缓存的 portsAlive 是按拍刷的(terminal-session-watch.ts),停止是用户动作、等得起一次
  // lsof:**现问一遍**它打印过的端口。不现问就会出现「刚启动完、扫描还没跑到,点停止却
  // 被当成没在跑」,那条守护化的服务从此脱管(第 1 轮审查发现 3)。
  if (session.ports.length && (await probePorts(session.ports)) !== "free") return session;
  if (!stopScript) return null;
  return session.exitCode === 0 && !session.stoppedByUser ? session : null;
}

/**
 * 「停止命令留空 = 杀掉启动命令起来的东西」的最后一档:进程归属那三条线索断了之后,按这次
 * 启动自己打印过的端口回去找人,归属靠环境里的启动记号核验(service-ports.ts 顶部)。
 *
 * **判成功的依据是端口的终态,不是「我杀掉了几个」**:同一次启动可能打印了多个端口,
 * 杀掉其中一个也会让 `killed` 非空 —— 早先据此直接报成功,于是「部分停止」被说成已停止、
 * 运行事实还被一并抹掉(第 1 轮审查 E2)。所以这里杀完一律回头再问一遍全部端口,只有
 * **确认全空**才算停净;还有人听、或者问不出来,都如实报错。
 */
async function stopLaunchPorts(open: TerminalSessionInfo, graceMs?: number): Promise<string | null> {
  if (!open.ports.length) return null;
  const token = terminalSessions.launchTokenOf(open.id);
  const result = token ? await stopByPorts(open.ports, { launchToken: token, graceMs }) : null;
  const state = await probePorts(open.ports);
  if (state === "free") return null;
  const where = `端口 ${open.ports.join("、")}`;
  if (state === "unknown") {
    return `${where} 的状态查不出来（lsof 没答上来），没法确认服务已经停了。请稍后再点一次停止，或者在「管理常用命令」里给这个服务填一条停止命令。`;
  }
  const spared = result?.spared[0];
  const who = spared
    ? `占着它的是 pid ${spared.holder.pid}（${spared.holder.command.slice(0, 60)}），${spared.reason}`
    : token
      ? "但查不到是谁占着"
      : "这条会话没有启动记号（多半是 ash 重启前起的），核不上归属所以没敢动它";
  return `${where} 上还有人在听，${who}。要停掉它，请在「管理常用命令」里给这个服务填一条停止命令。`;
}

/**
 * 停止命令跑完之后的**终态核验**:它说自己成功了(exit 0)不等于服务真的停了 ——
 * 一条 `true` 也会 exit 0(第 1 轮审查 E2:填一条返回零但什么都不做的脚本,界面照样报
 * 「已停止」、停止按钮消失,服务还在听)。这里不替用户强杀(他写那段脚本正是不想让 ash
 * 直接 kill),只是**不许宣称已停止**:原地报失败、留着可重试的现场。
 */
async function verifyStopScript(open: TerminalSessionInfo): Promise<string | null> {
  if (!open.ports.length) return null;
  const state: PortState = await probePorts(open.ports);
  if (state === "free") return null;
  if (state === "unknown") return `停止命令跑完了，但端口 ${open.ports.join("、")} 的状态查不出来（lsof 没答上来），没法确认服务已经停了`;
  return `停止命令跑完了，但端口 ${open.ports.join("、")} 上还有人在听 —— 服务没停下来，去看看那段脚本`;
}

/**
 * PowerShell 的 stderr 被重定向时写的不是人话,是 CLIXML:开头一行 `#< CLIXML`,后面整坨
 * `<Objs>` XML。原样塞进给用户看的那句话里就成了「已经一起杀掉：#< CLIXML」(真机
 * 192.168.1.187 实测)。把真正的错误文字(`<S S="Error">…</S>`)抽出来,抽不到就当它没说话。
 */
function plainStderr(err: string): string {
  if (!err.includes("#< CLIXML")) return err;
  const said = [...err.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => match[1].replaceAll("_x000D__x000A_", "\n").replaceAll(/&[a-z]+;/g, " ").trim())
    .filter(Boolean);
  return said.join("\n");
}

/** 停止脚本失败时给用户看的那几行:有 stderr 就说 stderr,只留最后 3 行、封顶 300 字。 */
function outputTail(out: string, err: string): string {
  const said = plainStderr(err);
  const tail = (said.trim() ? said : out)
    .split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).join(" / ");
  return tail.length > 300 ? `${tail.slice(0, 299)}…` : tail;
}

const runFile = promisify(execFile);
/** 超时收尾后核验残留的时限:只是读一眼,别让它反过来把那把命令锁又占住。 */
const CLEANUP_VERIFY_MS = 5_000;

/**
 * 超时那一发,打在**整次运行**上,而不是那层壳上。
 *
 * POSIX:spawn 时 `detached` 起的独立进程组,`kill(-pid)` 覆盖它拉起的一切。
 *
 * Windows 没有进程组,单发 `child.kill()` 只杀得到 PowerShell 这层壳 —— 它正在跑的原生
 * 清理程序(docker.exe 之类)会活下来,稍后还可能把用户刚重启的服务关掉,而那一刻我们已经
 * 释放了命令锁、还跟用户说「已经一起杀掉了」(第 1 轮审查发现 4;真机 192.168.1.187 实测:
 * 壳 11608 退了、它的子程序 880 仍存活)。那边改成两层一起上:
 *   ① **内核圈定**(executors/kernel-confine.ts 的 Job Object):spawn 之后立刻把壳圈进去,
 *      它此后 fork 的一切都继承这个归属,整圈下刀;
 *   ② `taskkill /T /F` 按 ppid 树补刀 —— 圈定是 spawn 之后才写的(`since-enroll`),
 *      理论上存在「fork 到那一笔写入之间」的窗口,这一发把那一类接住。
 *
 * 然后**核验**:圈里还有成员、或者进程组还活着,就如实说「还有残留」,不再嘴硬说杀干净了。
 */
async function killScriptRun(child: ChildProcess, confine: Confinement | null): Promise<string> {
  const pid = child.pid;
  if (!IS_WINDOWS) {
    try { if (pid !== undefined) process.kill(-pid, "SIGKILL"); else child.kill("SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } }
  } else {
    confine?.killAll("SIGKILL");
    if (pid !== undefined) {
      await runFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: CLEANUP_VERIFY_MS, windowsHide: true })
        .catch(() => undefined); // 进程已经没了时 taskkill 退非零,不是故障
    }
    try { child.kill("SIGKILL"); } catch { /* 已经没了 */ }
  }
  const residue = await verifyScriptGone(child, confine);
  confine?.dispose();
  return residue
    ? `已经发了强杀，但${residue} —— 它可能还在后台动作，必要时去系统里确认一下`
    : "已经把它和它拉起的进程一起杀掉";
}

/**
 * 残留核验:有就返回一句人话,没有返回 null。「问不出来」不算没有,如实说问不出来。
 *
 * 两个平台手里的证据不一样。POSIX 有进程组,`groupAlive` 直接问内核;**Windows 一条都没有**
 * —— `groupAlive`/`readProcessTableSync` 在那边全是短路,唯一的来源就是 Job Object。所以那边
 * 圈没建起来(第一次 enroll 要等守圈进程启动,约 180 ms,比它短命的运行圈不住)或者查不出来
 * 时,只能说「按 ppid 树杀过一遍,脱离了父子关系的后代核不到」。借 POSIX 那条路的沉默去说
 * 「已经一起杀掉了」,跟把 lsof 失灵读成「端口空了」是同一类错(第 1 轮审查 E2)。
 */
async function verifyScriptGone(child: ChildProcess, confine: Confinement | null): Promise<string | null> {
  const deadline = Date.now() + CLEANUP_VERIFY_MS;
  for (;;) {
    const read = confine?.read();
    const members = read?.kind === "members" ? read.members.length : 0;
    const groupLeft = !IS_WINDOWS && child.pid !== undefined && groupAlive(child.pid);
    if (!members && !groupLeft) {
      if (read?.kind === "unqueryable") return `核不出它是不是真的清空了（${read.why}）`;
      // 「集合为空」是内核给的权威答案,只有它算核过了;absent / 压根没圈都不算。
      if (IS_WINDOWS && read?.kind !== "members") {
        return "这次没圈起来（Job Object 不可用），只按 ppid 树杀过一遍 —— 脱离了父子关系的后代核不到";
      }
      return null;
    }
    if (Date.now() >= deadline) {
      return members ? `圈里还剩 ${members} 个进程没退` : "它的进程组里还有人活着";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
 * 到点那一发打在**整次运行**上(killScriptRun:POSIX 是整个进程组,Windows 是 Job Object +
 * taskkill /T),否则只杀掉 shell、它拉起的东西继续跑;杀完**核验一眼残留**再落地,核验自带
 * 5 秒上限 —— 既不嘴硬说「已经一起杀掉了」,也不让那把锁跟着一起卡死。不等它的 exit:
 * 万一它卡在不可中断的系统调用里,exit 可能永远不来。
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
    // 圈定只在 Windows 用:POSIX 那边 detached 起的进程组本身就是内核级的容器,而这台设备
    // 在 macOS 上没有等价物(openConfinement 会返回 null 并打一句弃权)。
    const confine = IS_WINDOWS && child.pid !== undefined ? openConfinement(`ash-stop-${id()}`) : null;
    if (child.pid !== undefined) confine?.enroll(child.pid);
    let out = "";
    let err = "";
    let settled = false;
    let timedOut = false;
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
      // 超时那一路已经在收尾了:它要等残留核验完才落地,这里别抢着把结论写成「被信号中断」。
      if (timedOut) return;
      confine?.dispose();
      if (code === 0) { settle({ ok: true }); return; }
      fail(code === null ? `停止命令被信号 ${signal} 中断` : `停止命令退出码 ${code}`);
    });
    timer = setTimeout(() => {
      timedOut = true;
      void killScriptRun(child, confine).then((cleanup) => {
        fail(`停止命令超过 ${Math.round(timeoutMs / 1000)} 秒还没结束，${cleanup}`);
      });
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
    // 幂等门认的是**还有东西在跑吗**(runningCommandSession:进程归属 ∪ 端口还有人听),
    // 不是「进程还在吗」。守护化的服务只剩端口这一条线索,照 liveCommandSession 判会得出
    // 「没在跑」,于是同一个服务被起第二份 —— 两个实例抢一个端口(第 1 轮审查发现 3)。
    const live = terminalSessions.runningCommandSession(projectId, command.id);
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
  /** 端口兜底那一档给进程留的收尾时间;回归同样拿它缩短等待。 */
  options: { portGraceMs?: number } = {},
): Promise<CommandActionResult> {
  return withCommandLock(projectId, commandId, async () => {
    const open = await openSession(projectId, commandId, stop?.script ?? null);
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
    }
    // 走哪条路都要**核到终态**才敢说停了。没配停止命令:进程那条线索走完了,再按这次启动
    // 打印过的端口兜一次(连杀带核验)。配了停止命令:不替用户强杀,但它说自己成功了也得
    // 核一遍端口 —— 不然一条 `true` 就能把「已停止」骗出来。
    const stuck = stop ? await verifyStopScript(open) : await stopLaunchPorts(open, options.portGraceMs);
    if (stuck) return { status: 502 as const, body: { error: `停止失败：${stuck}` } };
    // 启动脚本早就退了(服务在 ash 的进程树之外):没有进程可杀,但「我点过停止」要留下来。
    if (!live) terminalSessions.markCommandStopped(projectId, commandId);
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
        // 现场要在**动手之前**取:terminate 之后再去问 openSession,拿到的是已经被改过的
        // 状态(端口缓存刚被刷成 false、停止标记刚落上),旧服务的端口现场会被整段跳过,
        // 于是新实例一起来就撞上还占着端口的旧服务(第 1 轮审查发现 3)。
        const before = await openSession(projectId, command.id, command.stopCommand);
        if (command.stopCommand && before) {
          const ran = await runStopScript(cwd, command.stopCommand, STOP_SCRIPT_TIMEOUT_MS);
          if (!ran.ok) return { status: 502 as const, body: { error: `重启失败：旧服务没停下来（${ran.reason}）` } };
          await waitForSessionGone(projectId, command.id);
        }
        const live = terminalSessions.liveCommandSession(projectId, command.id);
        if (live) {
          const result = await terminalSessions.terminate(live.id, projectId);
          if (!result.ok) return { status: 502 as const, body: { error: `重启失败：旧进程停不下来（${result.reason}）` } };
        }
        // 旧服务可能是守护化的(进程树里早没了、端口还占着)。不先收掉它,新的一起来就会
        // 因为端口被占而挂 —— 那种失败看起来像「重启按钮坏了」。配了停止命令的同样要核:
        // 脚本说成功不等于端口让出来了(verifyStopScript)。
        const stuck = before
          ? command.stopCommand ? await verifyStopScript(before) : await stopLaunchPorts(before)
          : null;
        if (stuck) return { status: 502 as const, body: { error: `重启失败：旧服务没停下来（${stuck}）` } };
        // 核到终态了,把「这一份已经停了」落回会话事实 —— 否则它还会被当成「还在跑」,
        // 新会话的容量预留会撞上「旧命令会话尚未停止」。
        if (before) terminalSessions.markCommandStopped(projectId, command.id);
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
