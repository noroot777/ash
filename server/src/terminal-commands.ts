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
import { PORT_TIER_AVAILABLE, probePorts, stopByPorts, type PortState } from "./service-ports.js";
import { openConfinement, type Confinement } from "./executors/kernel-confine.js";
import { groupAlive, processAlive } from "./terminal-process-tree.js";
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
 *
 * **「还在跑的优先」不是排序偏好,是正确性**:同一条命令可能同时挂着一条还在跑的旧会话和
 * 一条更新的死记录(旧会话的守护进程晚一步才把端口听上、而中间那次启动当场失败)。只看
 * 「最后开的那条」就会放过那条还在跑的,start 于是起第二份(第 2 轮审查发现 1 的同一类)。
 */
function latestSession(projectId: string, commandId: string): TerminalSessionInfo | null {
  const mine = terminalSessions.listCommandSessions()
    .filter((session) => session.projectId === projectId && session.commandId === commandId);
  return mine.find((session) => session.groupAlive || session.portsAlive || session.unresolved.length > 0)
    ?? mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/**
 * 这条命令现在「开着」吗 —— **前端那颗按钮亮不亮用的是同一套口径**
 * (web/src/workspace/CommandsLauncher.tsx 的 serviceOpen),两边必须一致,否则会出现
 * 「停止按钮摆在那儿、点下去什么都没发生」。
 *
 * 活会话 = 确定在跑。启动脚本退了但**它打印过的本机端口还有人在听**也算开着 —— 真·守护化
 * 的服务(双 fork + setsid)从进程归属里全逃了,端口是仅剩的线索,而且顺着它能真杀到
 * (service-ports.ts),所以这一档**不要求配停止命令**。再往下,**上一次停止留下了没核销的号**
 * (核不上归属所以没敢动,见 StopVerdict)也算这次启动还没了结。最后,**配了停止命令**时,
 * 正常退出(exit 0)又没被停过的那次启动也算开着:`docker compose up -d` 这类服务连端口都
 * 未必打在本机(容器里、远端),会话死了不代表它停了,那条停止命令就是用户给的线索。
 * 四档都不沾边才算真停了。
 *
 * **这是唯一的权威判据** —— 启动幂等、停止、重启全走它(`startCommand` 曾经另问一个只认
 * 缓存的同义函数,于是「停止接口认为它开着、启动接口认为它没开」,同一个服务被起第二份:
 * 第 2 轮审查发现 1 实测两个独立 PID 同时活着)。函数名统一不算统一,**调用点统一才算**。
 */
async function openSession(
  projectId: string,
  commandId: string,
  stopScript: string | null,
): Promise<TerminalSessionInfo | null> {
  const session = latestSession(projectId, commandId);
  if (!session) return null;
  if (session.groupAlive || session.portsAlive) return session;
  // 缓存的 portsAlive 是按拍刷的(terminal-session-watch.ts),这几个动作都是用户点出来的、
  // 等得起一次 lsof:**现问一遍**它打印过的端口。不现问就会出现「刚启动完、扫描还没跑到,
  // 点停止却被当成没在跑」,那条守护化的服务从此脱管(第 1 轮审查发现 3)。
  // 这一档在这台机器上不存在(Windows / 没装 lsof)时**整档跳过**:probePorts 在那种平台上
  // 恒为 unknown,当成「可能还在跑」会让每条打印过网址的命令永远停不掉也起不动。
  if (PORT_TIER_AVAILABLE && session.ports.length && (await probePorts(session.ports)) !== "free") return session;
  if (session.unresolved.some((pid) => processAlive(pid))) return session;
  if (!stopScript) return null;
  return session.exitCode === 0 && !session.stoppedByUser ? session : null;
}

/**
 * 一次停止动作的**三种**终态。两种不够用:早先只有「停了」和「没停下来」,于是
 * 「这几个端口让出来了」被直接升级成「这次启动起来的东西都停了」(第 2 轮审查发现 2)。
 *
 *  · `stopped`    —— 核验过:端口全空,而且没留下没核销的号;
 *  · `unresolved` —— 监听确实停了,但同组还有**核不上归属所以一个字都没动**的号活着。
 *                    不杀它是对的(没有归属凭据),但也**不能顺手把它从账上划掉** ——
 *                    如实报给用户,并把这几个号留在会话事实里(刷新回来还看得见);
 *  · `stuck`      —— 端口还有人听,或者问不出来:不许宣称已停止,留着可重试的现场。
 */
type StopVerdict =
  | { kind: "stopped" }
  | { kind: "unresolved"; notice: string; leftovers: number[] }
  | { kind: "stuck"; reason: string };

/** 核不上归属的那几个号 → 一句给用户看的话。 */
function leftoverNotice(where: string, leftovers: { pid: number; reason: string }[]): string {
  const who = leftovers.slice(0, 3).map((one) => `pid ${one.pid}`).join("、");
  const more = leftovers.length > 3 ? `等 ${leftovers.length} 个` : "";
  return `${where}已经让出来了，但跟它同组的 ${who}${more} 还活着：${leftovers[0].reason}`
    + ` —— 没有归属凭据，ash 不敢动它们，所以没法说这次启动起来的东西都停了。`
    + `要连它们一起收，请在「管理常用命令」里给这个服务填一条停止命令。`;
}

/**
 * 「停止命令留空 = 杀掉启动命令起来的东西」的最后一档:进程归属那三条线索断了之后,按这次
 * 启动自己打印过的端口回去找人,归属靠环境里的启动记号核验(service-ports.ts 顶部)。
 *
 * **判成功的依据是终态,不是「我杀掉了几个」**:同一次启动可能打印了多个端口,杀掉其中一个
 * 也会让 `killed` 非空 —— 早先据此直接报成功,于是「部分停止」被说成已停止、运行事实还被
 * 一并抹掉(第 1 轮审查 E2)。所以杀完一律回头再问一遍全部端口;而且**端口全空也只说明
 * 监听停了**,同组那些核不上归属的号要单独交代(发现 2)。
 */
async function stopLaunchPorts(open: TerminalSessionInfo, graceMs?: number): Promise<StopVerdict> {
  // 这一档不存在就没有「它的结论」可言:前面 terminate 的三层击杀已经按它自己的口径核过,
  // 这里不另加一条拿不到证据的断言(Windows 上完全脱离启动会话的服务仍不在覆盖范围内 ——
  // 这是已知且已交代的边界,不是这一档失灵)。
  if (!PORT_TIER_AVAILABLE || !open.ports.length) return { kind: "stopped" };
  const token = terminalSessions.launchTokenOf(open.id);
  const result = token ? await stopByPorts(open.ports, { launchToken: token, graceMs }) : null;
  const state = await probePorts(open.ports);
  const where = `端口 ${open.ports.join("、")}`;
  if (state === "unknown") {
    return { kind: "stuck", reason: `${where} 的状态查不出来（lsof 没答上来），没法确认服务已经停了。请稍后再点一次停止，或者在「管理常用命令」里给这个服务填一条停止命令。` };
  }
  if (state === "listening") {
    const spared = result?.spared[0];
    const who = spared
      ? `占着它的是 pid ${spared.holder.pid}（${spared.holder.command.slice(0, 60)}），${spared.reason}`
      : token
        ? "但查不到是谁占着"
        : "这条会话没有启动记号（多半是 ash 重启前起的），核不上归属所以没敢动它";
    return { kind: "stuck", reason: `${where} 上还有人在听，${who}。要停掉它，请在「管理常用命令」里给这个服务填一条停止命令。` };
  }
  const leftovers = (result?.leftovers ?? []).filter((one) => processAlive(one.pid));
  if (leftovers.length) {
    return { kind: "unresolved", notice: leftoverNotice(where, leftovers), leftovers: leftovers.map((one) => one.pid) };
  }
  // 线索本身不全:这次启动打印的端口超过了记录额度,第 9 个起没进账。记下的都空了,但
  // 「自己 setsid 单开一组、只能从没记下的那个端口找到」的守护进程压根没被问过
  // (terminal.ts 的 recordPorts)。这种情况下不许把「端口都空了」说成「全停了」。
  if (open.portsTruncated) {
    return {
      kind: "unresolved",
      leftovers: [],
      notice: `${where}都让出来了，但这次启动打印的本机端口超过 ${open.ports.length} 个，`
        + `多出来的没能记下来 —— 如果还有服务只听那些端口，ash 没问过它们。`
        + `要确保停净，请在「管理常用命令」里给这个服务填一条停止命令。`,
    };
  }
  return { kind: "stopped" };
}

/**
 * 停止命令跑完之后的**终态核验**:它说自己成功了(exit 0)不等于服务真的停了 ——
 * 一条 `true` 也会 exit 0(第 1 轮审查 E2:填一条返回零但什么都不做的脚本,界面照样报
 * 「已停止」、停止按钮消失,服务还在听)。这里不替用户强杀(他写那段脚本正是不想让 ash
 * 直接 kill),只是**不许宣称已停止**:原地报失败、留着可重试的现场。
 */
async function verifyStopScript(open: TerminalSessionInfo): Promise<StopVerdict> {
  // 同 stopLaunchPorts:这一档在这台机器上不存在时,它给不出证据,也不该给出结论。
  if (!PORT_TIER_AVAILABLE || !open.ports.length) return { kind: "stopped" };
  const state: PortState = await probePorts(open.ports);
  if (state === "free") return { kind: "stopped" };
  if (state === "unknown") return { kind: "stuck", reason: `停止命令跑完了，但端口 ${open.ports.join("、")} 的状态查不出来（lsof 没答上来），没法确认服务已经停了` };
  return { kind: "stuck", reason: `停止命令跑完了，但端口 ${open.ports.join("、")} 上还有人在听 —— 服务没停下来，去看看那段脚本` };
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
 * 壳 11608 退了、它的子程序 880 仍存活)。那边两层一起上,**顺序要紧**:
 *   ① `taskkill /T /F` **先**打:`/T` 是按 ppid 树走的,树根必须**还枚举得到**。反过来先
 *      整圈下刀,根当场就没了,这一发就只剩「找不到 PID」,逃出圈的后代谁也不收
 *      (第 2 轮审查发现 3 真机实测:根 14192 先被圈刀收掉,随后 taskkill 找不到根,
 *      圈前出生的后代 27144 活下来,而读数照旧是「集合为空」);
 *   ② **内核圈定**(executors/kernel-confine.ts 的 Job Object)补刀:ppid 树断掉的那一类
 *      (Start-Process 之后根先退、或者被 reparent)由它按内核记下的归属收。
 *
 * 然后**核验**:圈里还有成员、进程组还活着、或者**这一问本来就答不全**,都如实说出来。
 */
async function killScriptRun(child: ChildProcess, confine: Confinement | null): Promise<string> {
  const pid = child.pid;
  if (!IS_WINDOWS) {
    try { if (pid !== undefined) process.kill(-pid, "SIGKILL"); else child.kill("SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } }
  } else {
    // ① 树根还活着的时候走 ppid 树。退非零有两种:进程已经没了(128),或者这一发没打出去
    // —— 后者要留着说,吞掉等于把一次失败做成静默。
    let treeFailed: string | null = null;
    if (pid !== undefined) {
      treeFailed = await runFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: CLEANUP_VERIFY_MS, windowsHide: true })
        .then(() => null)
        .catch((error: { code?: unknown; stderr?: string }) =>
          error.code === 128 ? null : `taskkill 没能按进程树收掉它（${(error.stderr ?? "").trim() || `退出码 ${String(error.code)}`}）`);
    }
    // ② 逃出 ppid 树的那一类交给圈。
    confine?.killAll("SIGKILL");
    try { child.kill("SIGKILL"); } catch { /* 已经没了 */ }
    const residue = await verifyScriptGone(child, confine);
    confine?.dispose();
    const left = [treeFailed, residue].filter(Boolean).join("；");
    return left
      ? `已经发了强杀，但${left} —— 它可能还在后台动作，必要时去系统里确认一下`
      : "已经把它和它拉起的进程一起杀掉";
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
 * —— `groupAlive`/`readProcessTableSync` 在那边全是短路,唯一的来源就是 Job Object。
 *
 * 而圈的空集合**不能无条件当成「整次运行为空」**:`ConfineRead.coverage` 写明了这一问覆盖
 * 到哪儿(kernel-confine.ts 顶部),`since-enroll` 只覆盖 assign **之后**出生的后代 ——
 * 圈定那一笔是 spawn 之后才写的,它之前出生的后代从头到尾没进过集合,集合空也证明不了
 * 它们没了(第 2 轮审查发现 3 真机实测:圈前出生的 27144 活着,读数仍是空集合)。
 * `executors/cleanup-result.ts` 的 `confinedResidue` 早就是这么判的 —— 只有 `whole-run`
 * 才许从空集合推出「扫净」。新调用者不能从旁边绕过同一条契约。
 *
 * Windows 上 `preExecEnv()` 返回 null(那条路只有 cgroup 有),所以那边**永远拿不到
 * whole-run**:如实说清这一问覆盖到哪儿,而不是把 since-enroll 的空当成全净。
 */
async function verifyScriptGone(child: ChildProcess, confine: Confinement | null): Promise<string | null> {
  const deadline = Date.now() + CLEANUP_VERIFY_MS;
  for (;;) {
    const read = confine?.read();
    const members = read?.kind === "members" ? read.members.length : 0;
    const groupLeft = !IS_WINDOWS && child.pid !== undefined && groupAlive(child.pid);
    if (!members && !groupLeft) {
      if (read?.kind === "unqueryable") return `核不出它是不是真的清空了（${read.why}）`;
      // POSIX 的权威证据是进程组(上面的 groupLeft 已经问过内核),圈只是加一台设备。
      if (!IS_WINDOWS) return null;
      // Windows 只剩圈这一个来源,于是空集合必须连着 coverage 一起用。
      if (read?.kind !== "members") {
        return "这次没圈起来（Job Object 不可用），只按 ppid 树杀过一遍 —— 脱离了父子关系的后代核不到";
      }
      if (read.coverage !== "whole-run") {
        return "圈只覆盖到圈定之后出生的那些（这台平台拿不到全程覆盖），圈前就脱离父子关系的后代核不到";
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
    // 幂等门认的是**这条命令还开着吗** —— 跟停止、重启用的是同一个 openSession,一个字
    // 都不另算。它比「进程还在吗」多三档:端口还有人听(现问一次 lsof,不吃缓存)、上次
    // 停止留下的没核销的号、以及「配了停止命令 + 上次正常退出又没被停过」。
    //
    // 这里曾经另问一个只认缓存的同义函数(runningCommandSession),于是出现:不打印网址的
    // 守护服务 + 配了停止命令 —— 停止接口和界面都认它开着,启动接口认它没开,再点一次启动
    // 就起了第二份(第 2 轮审查发现 1 实测:两个独立 PID 同时活着)。
    const open = await openSession(projectId, command.id, command.stopCommand);
    if (open) return { status: 200 as const, body: { session: open, alreadyRunning: true } };
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
    const verdict = stop ? await verifyStopScript(open) : await stopLaunchPorts(open, options.portGraceMs);
    if (verdict.kind === "stuck") return { status: 502 as const, body: { error: `停止失败：${verdict.reason}` } };
    // 「我点过停止」要留下来 —— 启动脚本早就退了(服务在 ash 的进程树之外)时尤其:没有进程
    // 可杀,但刷新回来还得看得出停过(根 AGENTS.md)。**无条件标**:活进程那条路里
    // terminate 只标它自己那条会话,缓存的 portsAlive 还可能是旧的 true,于是紧接着点启动会
    // 被幂等门拿一条已经退出的会话顶回去(第 2 轮审查发现 1)。
    // 没核销的号一并落进会话事实:下次点停止还看得见,刷新也不丢。
    terminalSessions.markCommandStopped(projectId, commandId, verdict.kind === "unresolved" ? verdict.leftovers : []);
    return verdict.kind === "unresolved"
      ? { status: 200 as const, body: { stopped: true, unresolved: verdict.leftovers, notice: verdict.notice } }
      : { status: 200 as const, body: { stopped: true } };
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
        const verdict: StopVerdict = before
          ? command.stopCommand ? await verifyStopScript(before) : await stopLaunchPorts(before)
          : { kind: "stopped" };
        if (verdict.kind === "stuck") {
          return { status: 502 as const, body: { error: `重启失败：旧服务没停下来（${verdict.reason}）` } };
        }
        // 核到终态了,把「这一份已经停了」落回会话事实 —— 否则它还会被当成「还在跑」,
        // 新会话的容量预留会撞上「旧命令会话尚未停止」。
        if (before) {
          terminalSessions.markCommandStopped(projectId, command.id, verdict.kind === "unresolved" ? verdict.leftovers : []);
        }
        const session = await reservation.create(cwd, { name: resolved.name, script: resolved.script });
        // 旧服务的监听停了、新的起来了,但同组那几个核不上归属的号还活着 —— 照实说一句,
        // 别让「重启成功」把它盖过去。
        return verdict.kind === "unresolved"
          ? { status: 201 as const, body: { session, notice: verdict.notice } }
          : { status: 201 as const, body: { session } };
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
