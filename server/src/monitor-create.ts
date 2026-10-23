// 哨兵的**创建协议**:起一条哨兵这件事本身。运行时(盯、推、停、接回)在 monitors.ts,
// 进程与放行闸在 monitor-spawn.ts,来源归属在 monitor-session.ts。
//
// ── 不变量:**命令开工 ⇒ 身份已经可恢复** ───────────────────────────────────────
//
// 等价说法:身份没落库 ⇒ 那条命令一个字都没跑过。它不是讲究,是第 7 轮审查 F3 实测的那一幕
// 的根:原来的顺序是「先 spawn,再 insert」——
//   1. 命令已经独立跑起来了,ash 才去登记;
//   2. 登记失败时只能**事后**追它(落责任 → 发信号 → 追到线索空 → 收档);
//   3. 而当身份查询那一刻也不可用、责任表又写不进去时(两张表都被注入写失败),那个进程的
//      唯一线索只剩 `scheduleReclaimPersist` 的内存参数 —— unref 定时器,活不过服务退出;
//   4. 重启恢复只枚举 monitors 和债表,两张表都没有它:命令还在后台跑着,谁都再也找不到它。
// 「以后定时再保存」不构成资源交接,所以这一层不靠它,而是**换顺序**:
//
//   ① 先落身份行(pid 还空着 = 创建意图)。落不下去 ⇒ 什么都没起,干净地 409。
//   ② 起进程 —— 它停在放行闸前面,还没 exec 用户的命令(POSIX,见 monitor-spawn.ts)。
//   ③ 把 pid 补上。补不上 ⇒ **不放行**,命令从未开工;照旧补一刀 + 走回收圈兜底。
//   ④ 挂上运行时(tail、到期定时器、退出回调)—— 这时它还停在闸前面,必然还活着。
//   ⑤ 放行。命令从这一刻才开工,而它的身份早在 ① 就落库了。
//
// 残余窗口只有一处,**在 win32**:那一侧没有放行闸(`cmd.exe` 里没有可靠的「从第 3 号句柄读
// 一行」写法),所以 ③ 之前命令可能已经在跑。**但它不再是「找不回来」**:`spawn` 一返回就把
// `{pid, 这一刻}` 同步写进日志旁边的身份边条(monitor-spawn.ts),重启那一侧拿它按代次认回来
// (`processStartedNear`,见 monitors.ts 的 `reattachMonitors`)。剩下的差别只有「闸」本身:
// win32 上命令可能在身份落库之前就开工,**这条差别未在 Windows 真机验证**(约定见根 AGENTS.md)。
//
// 而那个边条自己也会写不下来(盘满、目录权限)。两样都没有时,那条命令可能已经开工而**重启后
// 谁都再也定位不到它** —— 这正是 ① 换顺序要消掉的那一幕,只是从「库」挪到了「闸与边条」。所以
// 交接可不可恢复由 spawn 层显式答(`handoverRecoverable`),答不出是就**拒这次创建**:就地拿
// 句柄收掉它、照实说。POSIX 恒有闸,所以这一档只可能在 win32 出现(第 10 轮审查 F2-C)。
//
// ── 不变量:**起了进程 ⇒ 这段生命周期只有一个出口**(第 9 轮审查 F2)─────────────────
//
// ②(spawn 成功)到 ⑥(运行时接管完成)之间的每一个 await 都可能抛,而抛出去的那一刻:进程
// 已经存在、库里那行写着 running、却没有 tail、没有到期定时器、没有退出回调 —— 它不会到期
// 收尾,也不会产生任何结束事件,除了重启或人工再也没有人碰它(第 9 轮审查 F2 实测:只让回填
// pid 之后的第一次读库抛一次,`stored.status=running` + `shellAliveAfterDeadline=true`)。
// 「在新发现的那个 await 前面再补一次读」治不了这个 —— 下一次新增的 await 又会漏在外面。
// 所以这一段整体包在**一个所有权边界**里:任何异常、任何提前返回,都走同一个收尾
// (`abortRegistration` 一处)—— 关闸、拿句柄杀、拿句柄确认退出,确认不了
// 才落回收责任。
//
// ── 不变量:**身份不全不许开工**(第 9 轮审查 F3)─────────────────────────────────
//
// 「可恢复」指的是**跨代可恢复**:光有 pid 不够,pid 会被复用,所以回收那一侧必须能证明
// 「这个号上现在还是当初那一个」。启动时刻问不出来时(ps 抽一下)原来照旧回填、照旧放行,
// 于是留下一行 `pid_started_at` 为空的身份 —— 回收判据在那一档上退化成存在性检查,原命令
// 跑完、号被复用之后,接回/清扫/重复停止三条路都会拿着别人的进程当我们的下刀
// (判据已收紧在 proc.ts 的 `unverifiable` 档)。所以这里**拒绝**:身份问不全就不放行,
// 而那一刻要收掉的进程由**句柄**证明所有权,不经过 pid 身份那条路。
import { desc, eq } from "drizzle-orm";
import { MONITOR_MAX_PER_TASK, normalizeMonitorTimeout, type TaskMonitor } from "@ash/shared/monitor";
import { neverExitsVerdict } from "@ash/shared/command-never-exits";
import { endConditionAdvice, endConditionDemand, parseEndCondition } from "@ash/shared/monitor-end-condition";
import { db } from "./db/index.js";
import { monitors, projects, sessions, tasks } from "./db/schema.js";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { monitorSourceGate, type MonitorCaller } from "./monitor-session.js";
import { monitorLogPath, spawnMonitor } from "./monitor-spawn.js";
import {
  abandonRegistration, abortRegistration, settleIntent,
} from "./monitor-create-abort.js";
import {
  armRow, completeIdentity, diagnoseArm, noteProcessClue,
} from "./monitor-create-arm.js";
import {
  attach, liveMonitorsOf, publish, serialize, toTaskMonitor, type Row,
} from "./monitors.js";
import { holdCompletionForNewMonitor, terminalLandingInFlight } from "./task-complete.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id } from "./util.js";
import { prepareRegressionCommand } from "./regression-checks.js";

export type StartMonitorInput = {
  taskId: string;
  command: string;
  description?: string;
  cwd?: string | null;
  timeoutMs?: number;
  regression?: boolean;
  ownerUserId?: string | null;
  /**
   * **这次创建是谁发起的**,由入口核验后交上来(见 `monitor-session.ts` 的 `MonitorCaller`)。
   * 必填:哨兵唯一的出口是「唤醒这个任务」,而唤醒哪条会话由来源决定 —— 让它可缺省就等于
   * 默许「不知道就按执行者算」,那正是第 7 轮审查 F2 要消掉的那一种静默(审查者挂的哨兵
   * 把实现者叫起来烧一个回合,审查那条会话继续等不到人)。
   */
  caller: MonitorCaller;
  /**
   * **约定的结束条件**:哪一行一出现就收工。
   *
   * 「命令结束」本来就是第一优先的唤醒条件,但跟随型命令(`tail -F`、`while true`)自己永远不会
   * 结束,于是那条唤醒条件在它身上形同虚设。这一项把「结束」还给那一类命令:命中的那一行
   * 照常推给 agent,随后这条哨兵就收工(状态 `matched`)。
   *
   * **它不是正则,是字样**(`BUILD OK|FAILED`,`^` / `$` 作行首行尾锚)—— 理由见 shared 的
   * `monitor-end-condition.ts` 文件头 ①:调用方的正则会在服务唯一那条线程上回溯到停不下来。
   */
  stopWhen?: string | null;
  /**
   * **「我本来就是要盯到到期」**:显式声明之后,跟随型命令照原样放行。
   *
   * 它不是一个「关掉检查」的开关,而是三种合法意图里的第三种(每出现一次叫我一次、盯外部状态
   * 变化)。做成显式声明是因为那一类与「忘了加结束条件」在命令本身上长得一模一样 ——
   * 系统分不开,只有写命令的人分得开,所以让他说一句。
   */
  untilExpiry?: boolean;
};

export type StartMonitorResult =
  /** `notice` = 这次创建顺带改变了别的东西,调用方要原样带给 agent(目前只有一种:撤掉了它手里那份完成确认)。 */
  | { ok: true; monitor: TaskMonitor; notice?: string }
  /** `needsWakeTarget` = 拒绝的理由是「说不清醒来叫谁」:调用方指定一个唤醒目标就能再来。 */
  /** `needsEndCondition` = 拒绝的理由是「这条命令自己不会结束、又没约定结束条件」:给一条再来。 */
  | { ok: false; status: 400 | 404 | 409; error: string; needsWakeTarget?: true; needsEndCondition?: true };

// 创建没走完时的那一套在 monitor-create-abort.ts(意图行结局 + 进程收口 + 对外措辞),
// 身份与上膛在 monitor-create-arm.ts。**出口仍只有这一个门**:`abandonRegistration` 原地
// 再导出一次,免得导入方得知道它搬到哪儿去了。
export { abandonRegistration } from "./monitor-create-abort.js";

/** 哨兵在哪儿跑：显式指定 > 任务最近一条会话的工作目录 > 项目仓库目录。 */
async function resolveCwd(taskId: string, explicit?: string | null): Promise<string | null> {
  if (explicit?.trim()) return explicit.trim();
  const session = (await db
    .select({ cwd: sessions.cwd })
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(desc(sessions.startedAt))).find((s) => s.cwd);
  if (session?.cwd) return session.cwd;
  const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task?.projectId) return null;
  const project = (await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, task.projectId))).at(0);
  return project?.repoPath ?? null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value.trim() : null);
const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));


/**
 * 起一个哨兵。
 *
 * **整段按任务串行**：「数一数在跑几个」和「插进去一条」之间隔着好几个 await，并发打进来时
 * 每一个都在别人落库之前数完了数，于是六个请求能一起过 4 个的闸、真的起六个长跑进程（第 1
 * 轮审查实测 successfulStarts=6）。既有的 `serialize` 按 monitorId 排队，护不到「还没有
 * id」的创建期，所以这里按 `task:<id>` 另排一条队。
 */
export async function startMonitor(input: StartMonitorInput): Promise<StartMonitorResult> {
  // 参数一律在**起进程之前**校验并规范化。顺序反过来的话，一个 description: 7 就能让
  // trim 抛在 spawn 之后：进程已经脱离 ash 跑起来了，记录却没落，于是它既不在列表里、
  // 也没有到期定时器，谁都停不掉（第 1 轮审查复现：HTTP 500 + 一个无主的 shell 还活着）。
  const command = text(input.command);
  if (!command) return { ok: false, status: 400, error: "command 不能为空" };
  if (input.regression !== undefined && typeof input.regression !== "boolean")
    return { ok: false, status: 400, error: "regression 必须是 true/false" };
  if (input.regression && (input.stopWhen || input.untilExpiry))
    return { ok: false, status: 400, error: "回归记录必须等原始测试命令正常退出，不能使用 stopWhen 或 untilExpiry" };
  if (input.description !== undefined && input.description !== null && text(input.description) === null)
    return { ok: false, status: 400, error: "description 必须是字符串" };
  if (input.cwd !== undefined && input.cwd !== null && text(input.cwd) === null)
    return { ok: false, status: 400, error: "cwd 必须是字符串" };
  const description = text(input.description) || command;
  // **结束条件在起进程之前算清楚**(理由同上:校验抛在 spawn 之后会留下无主进程)。
  //
  // 两步,顺序不能反:先看给的那个条件本身能不能用(解析不出来的 = 一个永远不会命中的条件,
  // 放进去只会变成另一条「只能等到期」的哨兵,而调用方还以为自己设过了)—— 就是下面这一句;
  // 再看这条命令**需不需要**结束条件,那一问在下面的锁里（它要等工作目录定下来才算得全,见
  // `assumptionsHold`）,仍然远在 spawn 之前。
  //
  // **「需不需要」只决定要不要你必须给一个,不决定你能不能给**(第 1 轮审查 F3):任何命令都
  // 收结束条件 —— 判据认不出来的跟随器(脚本封装、`eval`)到处都是,拿同一份猜测去决定配置
  // 资格,等于让漏判顺手把那条命令的出路也一起没收了。
  const stopWhen = parseEndCondition(input.stopWhen);
  if (!stopWhen.ok) return { ok: false, status: 400, error: stopWhen.error };

  return serialize(`task:${input.taskId}`, async () => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, input.taskId))).at(0);
    if (!task) return { ok: false, status: 404, error: "任务不存在" };
    // 工作目录在这儿就定下来:下面那一问要用它（见 `assumptionsHold`）。
    const cwd = await resolveCwd(input.taskId, input.cwd);
    if (!cwd) return { ok: false, status: 409, error: "定位不到工作目录，显式传 cwd" };
    // 「这条命令**需不需要**结束条件」:判据与三条出路的措辞都在 shared，前端那个手动挂哨兵
    // 的表单用的是同一份。它排在别的 409 前面（来源、终态、上限），因为它答的是「这次请求本身
    // 缺一个决定」，不是「此刻的状态不许」—— 先说状态只会让调用方改完状态再吃同一句。
    //
    // **判定压着一个没人核得了的前提时,这里只提示、不拦**（`unprovable`，见判据文件头 ⑨⑩）:
    // 它要盯的那个文件执行到那一步时还在不在、远端那个 pod 在不在、下游会不会一直读到头 ——
    // 这几种的「它永远不会结束」是个没人核过的假设,拿它去 409 就是把一件做得成的事变成做不成
    // （两轮审查一共实测了十二条）。那句话随这次创建一起回给调用方。
    //
    // **这里不再自己核文件系统**:上一版拿 `existsSync` 核过一遍路径前提,而它读得到的是「创建
    // 这一刻在不在」、判定要的是「执行到那一句时在不在」—— `rm ./doomed.log; tail -f doomed.log`
    // 创建时文件在、跑到那句时已经没了,实测退出 0 却被 409（第 2 轮审查 F1）。时刻不对的核查
    // 不是证明,所以那一档整个移到了提示那一侧,这里只剩「有没有压着前提」这一问。
    let advice: string | null = null;
    if (!stopWhen.cond && !input.untilExpiry) {
      const forever = neverExitsVerdict(command);
      if (forever?.unprovable) advice = endConditionAdvice(forever.what, forever.unprovable);
      // 409 而不是 400:它不是参数写错了,是「这次创建缺一个决定」—— 三条出路任选一条再来。
      else if (forever) {
        return {
          ok: false, status: 409, error: endConditionDemand(forever.what), needsEndCondition: true as const,
        };
      }
    }
    // 入口与出口同一份判据（创建问 `monitorSourceGate`、出口问 `monitorWakeGate`，两者
    // 共用 shared 的 `monitorBlockedReason`）。只判归档、不判终态的话，已完成的任务上照样
    // 起得来一个真进程，而 `pushToTask` 会把它推的每一条都按终态拒掉——命令在后台烧着，
    // 任务永远不醒（第 2 轮审查实测）。
    // 那一份判据里还含着「审查还在进行」这条豁免：审查跑在已经 done 的任务上，不豁免的话
    // 审查者一个哨兵都挂不上。它同时回答「是谁挂的、属于哪次审查」——按**入口核验过的调用
    // 来源**判，不是按「此刻哪个 agent 进程还活着」猜（见 monitor-session.ts 文件头）。
    const source = await monitorSourceGate(task, input.caller);
    if (source.blocked) {
      return { ok: false, status: 409, error: source.blocked, ...(source.needsWake ? { needsWakeTarget: true as const } : {}) };
    }
    if (input.regression && (input.caller.kind !== "turn" || !input.caller.bound ||
      !["single", "implementer"].includes(input.caller.role ?? "") || input.caller.review || task.reviewOf)) {
      return { ok: false, status: 409, error: "只有本任务已核验的执行回合能登记回归测试，审查/验证旁路回合不能冒充执行者" };
    }
    // ⑤-b **这个任务此刻正在落一个会收走哨兵的终态** —— 一个字都不许起。
    //
    // 上面那道 `monitorSourceGate` 读的是**库里的状态**，而终态行是在它落库之前就已经决定好
    // 了的：结算先核一遍阻塞物（放行）、随后才写 `done` 那一行。两件事之间的那条缝里，这里
    // 读到的仍是 `running`，于是创建照旧放行 —— 紧接着的终态清理把它当场停掉（第 2 轮审查
    // R2-1 实测 `OLD_F1_FINAL_SETTLEMENT_RACE`：`startMonitor:true` → `monitorAfter:"stopped"`）。
    //
    // 结算那一关**在同一把 `task:<id>` 锁里**置的这个闩（见 task-complete.ts 的
    // `beginTerminalLanding`），所以这里是一句同步判断就能答的事实，不是又一次「读库猜」。
    if (terminalLandingInFlight(input.taskId)) {
      return {
        ok: false,
        status: 409,
        error: "这个任务正在落终态（本回合已经在结算了），这一刻挂不上哨兵 —— 挂上去也会被终态清理"
          + "当场停掉。命令一个字都没跑；要盯的事情还在的话，等这一轮结算完、任务被重新唤醒后再挂。",
      };
    }

    const live = await liveMonitorsOf(input.taskId);
    if (live.length >= MONITOR_MAX_PER_TASK)
      return { ok: false, status: 409, error: `这个任务已经有 ${live.length} 个哨兵在盯了（上限 ${MONITOR_MAX_PER_TASK}），先停掉一个` };

    const monitorId = id();
    const logPath = monitorLogPath(input.taskId, monitorId);
    let launchedCommand = command;
    if (input.regression) {
      try { launchedCommand = prepareRegressionCommand(input.taskId, monitorId, command, cwd); }
      catch (error) { return { ok: false, status: 409, error: `回归证据准备失败，测试未启动：${detail(error)}` }; }
    }
    // **这一次创建独有的资源记号**:它随环境种进那个壳,整棵树都带着它(见 platform.ts 的
    // `MONITOR_UNIT_ENV`)。生成在**插意图行之前**,所以它跟 pid 不一样 —— 从第一条语句起就
    // 已经落库、跨重启认得回来,而不是靠事后回填。归属与整项退出这两问都只认它
    // (第 12 轮审查 F1:命令原文不是凭证)。
    const unitToken = `${monitorId}.${id()}`;
    const timeoutMs = normalizeMonitorTimeout(input.timeoutMs);
    const startedAt = new Date();
    const intent: Row = {
      id: monitorId,
      taskId: input.taskId,
      command: launchedCommand,
      description,
      cwd,
      status: "running",
      // **这两列先空着**：进程还没起，而身份行必须先落（见文件头的创建协议）。③ 回填。
      pid: null,
      pidStartedAt: null,
      unitToken,
      logPath,
      offset: 0,
      events: 0,
      exitCode: null,
      // 约定的结束条件**原样落库**:运行时每推一批就拿它比一次(monitors.ts 的 flushBuffer),
      // 跨重启接回来的那一份也照旧认它。
      stopWhen: input.stopWhen?.trim() || null,
      // 还没开始跑,自然一行都没命中过（这一列的语义见 schema-monitors.ts 的 `hitLine`）。
      hitLine: null,
      // **同一个瞬间**算两列：分别取 Date.now() 会差 1ms，而对外那个到期时刻是
      // `started_at + timeout_ms` 现算的（见 toTaskMonitor），差值会变成「库里写的」与
      // 「卡片显示的」不一致。
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
      endedAt: null,
      endedReason: null,
      // 「谁让它停的」只在真被停下来时才有值（见 schema 的 ended_by）。
      endedBy: null,
      // 「它的结果我不要了」也只在有人真这么说过时才有值（见 schema 的 results_abandoned_at）。
      resultsAbandonedAt: null,
      resultsAbandonedReason: null,
      // 结束通知的交接凭证只在收尾那一刻写（见 schema 的 result_handoff_at）。
      resultHandoffAt: null,
      resultHandoffText: null,
      ownerUserId: input.ownerUserId ?? null,
      kind: "ash",
      nativeId: null,
      cliSessionId: null,
      // 只有 claude 投影才有「起它的那个 tool_use」。
      toolUseId: null,
      // 代次结论与起点下界都是 claude 投影那一侧的事：ash 自己 spawn 的进程有真 pid，
      // 起点就是 spawn 那一刻（见 schema-monitors.ts）。
      sourceRun: null,
      startLowAt: null,
      // **哨兵醒来时该叫哪条会话**：审查是旁路回合，跑在自己那条 reviewer 会话上。认不出
      // 来就留 NULL = 按老样子叫执行者（见 monitor-session.ts）。
      sourceRole: source.role,
      // **它的命跟着哪次审查走**：非空 = 任务终态连坐清理要放过它、事件出口按那次审查
      // 是否还在判、唤醒时按那次审查的执行器续跑（见 schema-monitors.ts）。
      sourceReviewRun: source.reviewRun,
      // **哪一轮**：`nextRound` 复用同一个 run.id（只是把 current_round 加一、状态推回
      // reviewing），所以只记 runId 的话，上一轮遗留的哨兵会被下一轮当成自己的输入重新
      // 解释（见 schema-monitors.ts）。
      sourceReviewRound: source.reviewRound,
      // ash 自己起的：期限是它自己定的，当然知道。
      sourceLifetime: "bounded",
      // ash 自己起的：期限是它自己定的，当然可信；进程就是下面 spawnMonitor 起的那个，
      // 代次由 pid/pidStartedAt 两列（上面）记着，不走 claude 投影那套来源代次。
      lifetimeEvidence: "self",
      sourcePid: null,
      sourcePidStartedAt: null,
      // ash 自己 spawn 的，起点就是这一刻，没有不确定性 —— 误差界 0。两列成对写：少了误差界
      // 这一行就「无法重验」，对外会丢掉期限（见 shared 的 monitorStartTrusted）。
      startEvidence: "observed",
      startAnchorWidthMs: 0,
      timeoutMs,
    };

    // ① 身份先落库。**这一步失败时什么都还没起**,所以没有任何要回收的东西 —— 不必落责任、
    //    也不许声称回收了什么。
    try {
      await db.insert(monitors).values(intent);
    } catch (e) {
      return { ok: false, status: 409, error: `哨兵登记失败，那条命令一个字都没开始跑：${detail(e)}` };
    }

    // ② 起进程。POSIX 上它停在放行闸前面，还没 exec 用户的命令。
    //
    // **同步抛出也要收尾**:这一层的契约是「要么给句柄、要么给一句话」(见 monitor-spawn.ts),
    // 但契约靠调用方兜住才算数 —— 漏在外面的话,一个 `mkdirSync` 失败就会带着整个
    // `startMonitor` 抛出去,留下一条 pid 永远空着的 running 行:没有 tail、没有到期定时器、
    // 还占着每个任务 4 个的名额(第 8 轮审查 F3 的同类项)。
    let spawned: ReturnType<typeof spawnMonitor>;
    try {
      spawned = spawnMonitor({ command: launchedCommand, cwd, logPath, unitToken });
    } catch (e) {
      // 起不起来都一样要**落定**这一行:它是在起进程之前就插进去的,没人会来接管它
      // (没有 attach、没有到期定时器)。删不掉就排重试,不是记一行日志就算完(F3)。
      await settleIntent(intent, { kind: "drop" });
      return { ok: false, status: 409, error: `哨兵起不来，那条命令一个字都没开始跑：${detail(e)}` };
    }
    if ("error" in spawned) {
      await settleIntent(intent, { kind: "drop" });
      return { ok: false, status: 409, error: spawned.error };
    }

    // ── 所有权边界:从这里到 ⑥ 交接完成,**所有出口只有一个**(见文件头)──────────────
    //
    // 边界里的每一个 await 都可能抛,而抛出去的那一刻进程已经存在、行写着 running、运行时却
    // 还没接手:不会到期、不会收尾、不会有结束事件。所以这里不挨个列「哪几个函数会抛」,而是
    // 整段兜住 —— 以后在这一段里新增 await 不必再想一遍这件事。
    const row: Row = { ...intent, pid: spawned.pid };
    const token = input.caller.kind === "turn" ? input.caller.token : null;
    let handed = false;
    let announced = false;    // 时间线上那句「哨兵已起」写出去了吗(失败时要追一句更正)
    try {
      // ③-0 **交接要可恢复**。闸和身份边条两样都没有时(只可能是 win32 + 边条写失败),这条
      //      命令可能已经开工,而 ash 这一刻要是没了就再没有东西能定位它 —— 重启枚举的是
      //      monitors(pid 还空着)和边条(没写成),两边都指不到那个进程。带着这种交接放行等于
      //      把「以后谁都收不掉它」写进系统,所以拒(第 10 轮审查 F2-C;判据在 spawn 层的
      //      `handoverRecoverable`)。要收的那个进程由**句柄**证明所有权,不经过 pid 那条路。
      if (!spawned.recoverable) {
        // pid 照旧落到那一行上:它是此刻唯一的线索(启动时刻留空 = 如实记「无从比对」)。
        await noteProcessClue(row, null);
        return await abandonRegistration(
          row,
          "这次开工交接恢复不了（这一侧没有放行闸，身份边条也写不下来），ash 一重启就再也定位不到它，所以不放行",
          spawned,
        );
      }

      // ③ **身份要齐**。只有号没有代次 = 跨代认不回来,也就不许开工(见文件头第三条不变量)。
      const startedAt = await completeIdentity(spawned.pid);
      if (!startedAt) {
        // pid 仍然要落到那一行上:身份不全不等于没有线索(启动时刻留空 = 如实记「无从比对」)。
        await noteProcessClue(row, null);
        return await abandonRegistration(
          row,
          "问不出它的启动时刻（进程查询不可用），只有 pid 的身份没法跨代认回来，所以不放行",
          spawned,
        );
      }
      row.pidStartedAt = startedAt;

      // ④ 「已起」这一行排在 attach 之前:挂上运行时的那一刻结局可能**已经发生**(壳自己就退
      //    了,一次性结局缓冲会当场把它结算成 exited),那时再写「已起」就排在「结束」后面了。
      //    排在 ⑤ 上膛之前是另一条:上膛到放行之间**不许再有 await**(⑤ 的注释)。没上膛成的
      //    那一路由 `abortRegistration` 追一句「哨兵没能开工」更正。
      await appendTaskTimeline(row.taskId, `哨兵已起：${row.description}（${command}）`);
      announced = true;

      // ⑤ **上膛**:写进完整身份,同一条语句里证明「这次创建此刻仍然该放行」(见 `armRow`)。
      if (!await armRow(row, startedAt, token)) {
        const why = await diagnoseArm(monitorId, input.taskId, token);
        // 不放行,但**身份照旧落到那一行上**:它是那个壳的唯一线索(见 `noteProcessClue`)。
        await noteProcessClue(row, startedAt);
        return await abortRegistration(row, "canceled", why, { handle: spawned, announced: true });
      }
      // 删除不是一个瞬间,而 `beginTaskRevocation` 是**同步**关闸、之后才去抢这条队列 —— 所以
      // 放行前最后再问一次。这一问是纯内存的,**上膛和放行之间因此没有任何 await**。
      if (isTaskRevoked(input.taskId)) {
        return await abortRegistration(
          row, "canceled", "创建还没完成，这个任务已经开始删除", { handle: spawned, announced: true },
        );
      }

      // ⑥ **先挂运行时、再放行**。顺序反过来有个安静的洞:`echo x` 这种瞬间跑完的命令会在
      //    `attach` 之前就 exit。那个洞现在由 spawn 层的一次性结局缓冲兜住(晚订阅也收得到),
      //    但顺序照旧按「挂好再放行」排 —— 让「订阅不到」这件事连发生的机会都没有。
      attach(row, spawned.onExit);
      spawned.release();   // 命令从这一刻才真正开工,而它的身份在 ⑤ 已经完整落库
      handed = true;
      publish(row.taskId);
      // ⑦ **这一刻 agent 手里可能正握着一份完成确认**:它先 complete_task 再 start_monitor,
      //    那份确认已经不成立了 —— 不撤的话结算照旧落 done,刚起的这条当场被连坐停掉
      //    (第 1 轮审查 F1 实测 confirmationStillSet=true / monitorAfter=stopped)。撤它必须
      //    跟「数一数有几个哨兵」排同一条队,所以落在这个 `serialize` 里面;那一句话随创建
      //    结果回给 agent,它读结果的那一眼就看到落位变了。**绝不抛**(见那个函数)。
      const held = await holdCompletionForNewMonitor(row.taskId, row.description);
      // 「核不了的那一环」那句提示跟它拼在一起回出去（见上面的 `advice`）:两句都是对着**这
      // 一次创建**说的落位变化,调用方读结果的那一眼就该看到。
      const notice = [held, advice].filter((n): n is string => !!n).join("");
      return { ok: true, monitor: toTaskMonitor(row), ...(notice ? { notice } : {}) };
    } catch (e) {
      // 交接已经完成 ⇒ 这个进程归运行时了,这里再去收它反而是抢它的东西:原样抛出去。
      if (handed) throw e;
      return await abandonRegistration(row, `这一次创建中途出错了：${detail(e)}`, spawned, announced);
    }
  });
}
