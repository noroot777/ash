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
// 两段邻居:用户那条停止命令怎么跑(超时、整次运行清杀、输出回显)在
// terminal-stop-script.ts;「上一次停止留下了什么责任」怎么记、怎么合并在
// terminal-stop-facts.ts;终态判定与那几句话在 terminal-stop-notices.ts。这里只做动作。
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
import { launchSurvivors } from "./terminal-launch-survivors.js";
import {
  leftoverNotice,
  membersNotice,
  processStopVerdict,
  scriptLeftoverNotice,
  truncatedNotice,
  type Enumeration,
  type StopVerdict,
} from "./terminal-stop-notices.js";
import {
  launchMembers, PORT_TIER_AVAILABLE, probeOwnedPorts, stopByPorts, survivingMembers,
  type LaunchMember, type LaunchSnapshot,
} from "./service-ports.js";
import { processAlive } from "./terminal-process-tree.js";
import { resolveTerminalDirectory, terminalSessions, type StopFact, type TerminalSessionInfo } from "./terminal.js";
import type { StopResolution } from "./terminal-session-facts.js";
import { liveLeftovers } from "./terminal-stop-facts.js";
import { runStopScript } from "./terminal-stop-script.js";

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
  return mine.find((session) => session.running)
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
  // 这一档在这台机器上不存在(Windows / 没装 lsof)时**整档跳过**:probeOwnedPorts 在那种
  // 平台上恒为 unknown,当成「可能还在跑」会让每条打印过网址的命令永远停不掉也起不动。
  // 问的是**归属**:端口上坐着的核实了不是这次起来的(stranger),这次启动就是不在了 ——
  // 把它读成「还开着」,一条只打印了网址的命令会被邻居的服务永久钉在「运行中」,而那个邻居
  // 核不上归属、一个字都不许动,于是这条命令既起不动也停不掉(第 3 轮审查发现 3)。
  if (PORT_TIER_AVAILABLE && session.ports.length) {
    const { state } = await probeOwnedPorts(session.ports, terminalSessions.launchTokenOf(session.id));
    terminalSessions.recordCommandPortState(session.id, projectId, state);
    if (state === "ours" || state === "unknown") return terminalSessions.get(session.id, projectId);
  }
  if (liveLeftovers(session.stop).length > 0) return session;
  if (!stopScript) return null;
  return session.exitCode === 0 && !session.stoppedByUser ? session : null;
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
/**
 * 按启动记号扫一遍,**发现即落账**。
 *
 * 落账放在这儿而不是判定分支里,理由同 `oweOnFailedStop`:这一趟之后监听者/组长就没了,
 * 不当场记下,下一遍再点停止时这个号**再也不会被发现**,端口一空就会判成停净
 * (第 5、6 轮审查在端口那条道上实测过同一个形状)。
 */
async function owedSurvivors(open: TerminalSessionInfo): Promise<number[]> {
  const survivors = await launchSurvivors(terminalSessions.launchTokenOf(open.id));
  if (survivors.length) {
    terminalSessions.oweCommandLeftovers(open.id, open.projectId, survivors,
      `这次启动起来的 pid ${survivors.join("、")} 还活着（环境里带着这次启动的记号），`
      + "它们已经脱离了进程组和会话，默认停法点不到它们");
  }
  return survivors;
}

async function stopLaunchPorts(open: TerminalSessionInfo, killed: Enumeration, graceMs?: number): Promise<StopVerdict> {
  if (!PORT_TIER_AVAILABLE || !open.ports.length) return processStopVerdict(open, false, killed, await owedSurvivors(open));
  const token = terminalSessions.launchTokenOf(open.id);
  const result = token ? await stopByPorts(open.ports, { launchToken: token, graceMs }) : null;
  const where = `端口 ${open.ports.join("、")}`;
  // **发现即落账**,在任何 return 之前。下面每一条分支都可能是失败分支(端口问不出来、还有
  // 人听),把这一趟的发现留到成功分支再交,失败时就原地丢了 —— 下一遍再点停止,监听者已经
  // 死了,同组那个工人再也不会被发现,于是端口一空就判 verified(第 5 轮审查发现 1 实测)。
  const found = (result?.leftovers ?? []).filter((one) => processAlive(one.pid));
  if (found.length) {
    const pids = found.map((one) => one.pid);
    terminalSessions.oweCommandLeftovers(open.id, open.projectId, pids, leftoverNotice(where, found));
  }
  if (result?.membersIncomplete) {
    terminalSessions.oweCommandLeftovers(open.id, open.projectId, [], membersNotice(open, false), false);
  }
  if (open.portsTruncated) {
    terminalSessions.oweCommandLeftovers(open.id, open.projectId, [], truncatedNotice(open, false), false);
  }
  const probe = await probeOwnedPorts(open.ports, token);
  if (probe.state === "unknown") {
    return { kind: "stuck", reason: `${probe.why}，没法确认服务已经停了。请稍后再点一次停止，或者在「管理常用命令」里给这个服务填一条停止命令。` };
  }
  // 只有**核实是这次启动起来的**东西还在听才叫没停下来。端口上坐着别人的服务(stranger)
  // 跟这次启动还在不在是两件事 —— 当成没停下来,这条命令就永远停不掉(发现 3)。
  if (probe.state === "ours") {
    const spared = result?.spared[0];
    const who = spared
      ? `占着它的是 pid ${spared.holder.pid}（${spared.holder.command.slice(0, 60)}），${spared.reason}`
      : "TERM 和 KILL 都没让它停下来";
    return { kind: "stuck", reason: `${where} 上还有这次启动起来的进程在听，${who}。要停掉它，请在「管理常用命令」里给这个服务填一条停止命令。` };
  }
  if (found.length) {
    return { kind: "unresolved", notice: leftoverNotice(where, found), leftovers: found.map((one) => one.pid), complete: !open.portsTruncated && !result?.membersIncomplete };
  }
  if (open.portsTruncated) return { kind: "unresolved", leftovers: [], notice: truncatedNotice(open, false), complete: false };
  if (result?.membersIncomplete) return { kind: "unresolved", leftovers: [], notice: membersNotice(open, false), complete: false };
  return { kind: "stopped" };
}

async function verifyStopScript(
  open: TerminalSessionInfo,
  /** 跑脚本**之前**照的成员相(launchMembers)。null = 这条路没照相(没有停止脚本)。 */
  snapshot: LaunchSnapshot | null,
  killed: Enumeration,
): Promise<StopVerdict> {
  if (!PORT_TIER_AVAILABLE || !open.ports.length) return processStopVerdict(open, true, killed, await owedSurvivors(open));
  const survived = await surviveCheck(open, snapshot);
  const probe = await probeOwnedPorts(open.ports, terminalSessions.launchTokenOf(open.id));
  if (probe.state === "ours") {
    return { kind: "stuck", reason: `停止命令跑完了，但端口 ${open.ports.join("、")} 上还有这次启动起来的进程在听 —— 服务没停下来，去看看那段脚本` };
  }
  const left = survived.members;
  if (probe.state === "unknown") return { kind: "stuck", reason: `停止命令跑完了，但${probe.why}，没法确认服务已经停了` };
  if (left.length) {
    return { kind: "unresolved", leftovers: left.map((one) => one.pid), notice: scriptLeftoverNotice(left), complete: survived.complete && !open.portsTruncated };
  }
  // 监听这边核过了,但线索本身可能不全 —— 同 stopLaunchPorts:没记下的端口谁都没问过,
  // 相也可能没照全,用户那段脚本到底收没收干净,这里给不出证据,于是不许宣称停净
  // (第 3 轮审查发现 1 / 第 5 轮发现 1)。
  if (open.portsTruncated) return { kind: "unresolved", leftovers: [], notice: truncatedNotice(open, true), complete: false };
  if (!survived.complete) return { kind: "unresolved", leftovers: [], notice: membersNotice(open, true), complete: false };
  return { kind: "stopped" };
}

/**
 * 用户那条停止脚本动过手之后,**谁还活着** —— 并且当场落账。
 *
 * 「还活着」是两份并集(survivingMembers):停止前那张相里没被收掉的,加上停止期间那几个组里
 * **新冒出来的**。后一份不能省:脚本 kill 监听者时,监听者的 TERM handler 可以现 fork 一个
 * 工人,它出生在照相之后,只比旧相就永远发现不了它(第 6 轮审查 E2 在脚本路径上的同形)。
 *
 * 落账放在这儿而不是各个判断分支里,是为了让**每一条出口都已经落过账** —— 包括脚本自己
 * 失败、探测失败这些提前返回的分支。那正是 E1 实测到的洞:首次停止 502、工人还活着,而
 * `stop.kind` 仍是 none;再点一次,监听者早没了、端口一空就判 verified,工人照旧活着。
 */
/**
 * 一次停止动作**失败收场**时的落账。
 *
 * 脚本自己失败、或者进程杀不动,都不等于「什么都没做成」:脚本的典型形状是「先收掉监听者,
 * 再做别的收尾,然后某一步挂了」—— 监听者这会儿已经死了,而它 fork 的工人还在跑。这一笔不
 * 当场记下,下一遍再点停止时端口已经空了,那个工人**再也不会被发现**,于是端口一空就判
 * verified(第 6 轮审查 E1 实测:首次 502 而 stop.kind 仍是 none;再点一次 200 stopped、
 * 停止按钮消失,工人照旧活着)。
 *
 */
async function oweOnFailedStop(open: TerminalSessionInfo, snapshot: LaunchSnapshot | null): Promise<void> {
  if (!snapshot || !PORT_TIER_AVAILABLE || !open.ports.length) return;
  await surviveCheck(open, snapshot);
}

async function surviveCheck(
  open: TerminalSessionInfo,
  snapshot: LaunchSnapshot | null,
): Promise<{ members: LaunchMember[]; complete: boolean }> {
  if (!snapshot) return { members: [], complete: true };
  const survived = await survivingMembers(snapshot, terminalSessions.launchTokenOf(open.id));
  if (survived.members.length) {
    terminalSessions.oweCommandLeftovers(
      open.id, open.projectId,
      survived.members.map((one) => one.pid),
      scriptLeftoverNotice(survived.members),
    );
  }
  if (!survived.complete) {
    terminalSessions.oweCommandLeftovers(open.id, open.projectId, [], membersNotice(open, true), false);
  }
  if (open.portsTruncated) {
    terminalSessions.oweCommandLeftovers(open.id, open.projectId, [], truncatedNotice(open, true), false);
  }
  return survived;
}

/** StopVerdict → 落进会话事实的那笔账(stuck 不走这里:它压根没核到终态)。 */
function resolutionOf(verdict: Exclude<StopVerdict, { kind: "stuck" }>): StopResolution {
  return verdict.kind === "unresolved"
    ? { kind: "unresolved", pids: verdict.leftovers, why: verdict.notice, complete: verdict.complete }
    : { kind: "verified" };
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
    // 相要在动手**之前**照:脚本跑完再去枚举,它收掉的那些早没了,留下的工人也就无从比对
    // (verifyStopScript 的注释)。
    const snapshot = stop ? await launchMembers(open.ports, terminalSessions.launchTokenOf(open.id)) : null;
    if (stop) {
      const ran = await runStopScript(stop.cwd, stop.script, stop.timeoutMs ?? STOP_SCRIPT_TIMEOUT_MS);
      if (!ran.ok) {
        // **脚本自己失败了,它已经做成的那部分照样要落账。** 脚本的典型形状是「先收掉监听者,
        // 再做别的收尾,然后某一步失败」:监听者这会儿已经死了,而它 fork 的工人还在跑。这一趟
        // 不落账,下一遍再点停止时端口已经空了,那个工人**再也不会被发现**,于是端口一空就判
        // verified(第 6 轮审查 E1 实测:首次 502 而 stop.kind 仍是 none;再点一次 200
        // verified、停止按钮消失,工人照旧活着)。
        await oweOnFailedStop(open, snapshot);
        return { status: 502 as const, body: { error: `停止失败：${ran.reason}` } };
      }
      await waitForSessionGone(projectId, commandId);
    }
    const live = terminalSessions.liveCommandSession(projectId, commandId);
    // `killed` = terminate 那一趟的成员枚举全不全。没有活会话可杀时它是 null:这一趟压根
    // 没枚举过,不能跟「问全了」混成一个值(processStopVerdict 据此决定措辞)。
    let enumerated: boolean | null = null;
    if (live) {
      const result = await terminalSessions.terminate(live.id, projectId);
      // 同上:杀不动也不能把这一趟已经发现的责任丢掉。
      if (!result.ok) {
        await oweOnFailedStop(open, snapshot);
        return { status: 502 as const, body: { error: `停止失败：${result.reason}` } };
      }
      enumerated = result.complete;
    }
    // `groupGone` 必须在收尾动作**之后**读:动手前那张现场里它当然还活着。
    const killed: Enumeration = { complete: enumerated,
      groupGone: terminalSessions.get(open.id, projectId)?.groupAlive === false };
    // 走哪条路都要**核到终态**才敢说停了。没配停止命令:进程那条线索走完了,再按这次启动
    // 打印过的端口兜一次(连杀带核验)。配了停止命令:不替用户强杀,但它说自己成功了也得
    // 核一遍端口 —— 不然一条 `true` 就能把「已停止」骗出来。
    const verdict = stop ? await verifyStopScript(open, snapshot, killed) : await stopLaunchPorts(open, killed, options.portGraceMs);
    if (verdict.kind === "stuck") return { status: 502 as const, body: { error: `停止失败：${verdict.reason}` } };
    // 「我点过停止」要留下来 —— 启动脚本早就退了(服务在 ash 的进程树之外)时尤其:没有进程
    // 可杀,但刷新回来还得看得出停过(根 AGENTS.md)。**无条件标**:活进程那条路里
    // terminate 只标它自己那条会话,缓存的 portsAlive 还可能是旧的 true,于是紧接着点启动会
    // 被幂等门拿一条已经退出的会话顶回去(第 2 轮审查发现 1)。
    // 没核销的号一并落进会话事实:下次点停止还看得见,刷新也不丢。回给用户的是**落账之后**
    // 的终态,不是这一次的结论 —— 上一次留下的责任还挂着时,这次停止也不该报「干净」
    // (落账是单调的,见 terminal-stop-facts.ts 的 mergeStop)。
    const settled = terminalSessions.markCommandStopped(open.id, projectId, resolutionOf(verdict));
    return settled.kind === "unresolved"
      ? { status: 200 as const, body: { stopped: true, unresolved: settled.pids, notice: settled.why } }
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
        const snapshot = command.stopCommand && before
          ? await launchMembers(before.ports, terminalSessions.launchTokenOf(before.id))
          : null;
        if (command.stopCommand && before) {
          const ran = await runStopScript(cwd, command.stopCommand, STOP_SCRIPT_TIMEOUT_MS);
          // 重启跟停止是同一条停法,于是同一个洞也在这儿(第 6 轮审查 F1 点明「不是只修停止
          // 按钮就够」):失败出口先落账,再报错。
          if (!ran.ok) {
            await oweOnFailedStop(before, snapshot);
            return { status: 502 as const, body: { error: `重启失败：旧服务没停下来（${ran.reason}）` } };
          }
          await waitForSessionGone(projectId, command.id);
        }
        const live = terminalSessions.liveCommandSession(projectId, command.id);
        let enumerated: boolean | null = null;
        if (live) {
          const result = await terminalSessions.terminate(live.id, projectId);
          if (!result.ok) {
            if (before) await oweOnFailedStop(before, snapshot);
            return { status: 502 as const, body: { error: `重启失败：旧进程停不下来（${result.reason}）` } };
          }
          enumerated = result.complete;
        }
        const killed: Enumeration = { complete: enumerated,
          groupGone: before !== null && terminalSessions.get(before.id, projectId)?.groupAlive === false };
        // 旧服务可能是守护化的(进程树里早没了、端口还占着)。不先收掉它,新的一起来就会
        // 因为端口被占而挂 —— 那种失败看起来像「重启按钮坏了」。配了停止命令的同样要核:
        // 脚本说成功不等于端口让出来了(verifyStopScript)。
        const verdict: StopVerdict = before
          ? command.stopCommand ? await verifyStopScript(before, snapshot, killed) : await stopLaunchPorts(before, killed)
          : { kind: "stopped" };
        if (verdict.kind === "stuck") {
          return { status: 502 as const, body: { error: `重启失败：旧服务没停下来（${verdict.reason}）` } };
        }
        // 核到终态了,把「这一份已经停了」落回会话事实 —— 否则它还会被当成「还在跑」,
        // 新会话的容量预留会撞上「旧命令会话尚未停止」。
        const stop: StopFact = before
          ? terminalSessions.markCommandStopped(before.id, projectId, resolutionOf(verdict))
          : { kind: "verified" };
        // 旧账上还有**确认活着**的号时不许起第二份:那几个进程还端着端口和状态,再起一份
        // 只会撞上去(看起来像「重启按钮坏了」),而旧那条记录是触达它们的唯一把手、删不得
        // (terminal.ts 的 register 为此拦着替换)。直接在这里以 502 + 那句话退出,比让
        // register 抛一句「旧命令会话尚未停止」(500,且不说是谁还活着)诚实得多。
        // pids 为空的那种 unresolved(证据不全)不走这条路:没有活号可举,照旧起新的。
        const alive = liveLeftovers(stop);
        if (alive.length) return { status: 502 as const, body: { error: `重启失败：${stop.kind === "unresolved" ? stop.why : ""}` } };
        const session = await reservation.create(cwd, { name: resolved.name, script: resolved.script });
        // 旧服务的监听停了、新的起来了,但旧账上那几个核不上归属的号还活着 —— 照实说一句,
        // 别让「重启成功」把它盖过去。
        return stop.kind === "unresolved"
          ? { status: 201 as const, body: { session, notice: stop.why } }
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
