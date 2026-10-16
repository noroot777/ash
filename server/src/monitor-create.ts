// 哨兵的**创建协议**:起一条哨兵这件事本身。运行时(盯、推、停、接回)在 monitors.ts,
// 进程与放行闸在 monitor-spawn.ts,来源归属在 monitor-session.ts。
//
// ── 不变量:**命令开工 ⇒ 身份已经可恢复** ───────────────────────────────────────
//
// 等价说法:身份没落库 ⇒ 那条命令一个字都没跑过。它不是讲究,是第 7 轮审查 F3 实测的那一幕
// 的根:原来的顺序是「先 spawn,再 insert」——
//   1. 命令已经独立跑起来了,ash 才去登记;
//   2. 登记失败时只能**事后**追它(落责任 → 发信号 → 确认退出 → 销账);
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
// 一行」写法),所以 ③ 失败时命令可能已经在跑。那一档仍然**有身份行**(id/命令/工作目录/日志
// 路径都在,面板看得见、能点停),不等于 F3 那种无主创建;收不回来时会如实写进那一行的结束
// 原因,接回那一侧也按「没能记下 pid」单独说(monitors.ts 的 `reattachMonitors`)。
// **未在 Windows 真机验证**(约定见根 AGENTS.md)。
import { desc, eq } from "drizzle-orm";
import { MONITOR_MAX_PER_TASK, normalizeMonitorTimeout, type TaskMonitor } from "@ash/shared/monitor";
import { db } from "./db/index.js";
import { monitors, projects, sessions, tasks } from "./db/schema.js";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { reclaimMonitorProcess, settleReclaim } from "./monitor-reclaim-debts.js";
import { monitorSourceGate, type MonitorCaller } from "./monitor-session.js";
import { monitorLogPath, spawnMonitor } from "./monitor-spawn.js";
import {
  attach, liveMonitorsOf, publish, serialize, toTaskMonitor, type Row,
} from "./monitors.js";
import { inspectProcess } from "./proc.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id, now } from "./util.js";

export type StartMonitorInput = {
  taskId: string;
  command: string;
  description?: string;
  cwd?: string | null;
  timeoutMs?: number;
  ownerUserId?: string | null;
  /**
   * **这次创建是谁发起的**,由入口核验后交上来(见 `monitor-session.ts` 的 `MonitorCaller`)。
   * 必填:哨兵唯一的出口是「唤醒这个任务」,而唤醒哪条会话由来源决定 —— 让它可缺省就等于
   * 默许「不知道就按执行者算」,那正是第 7 轮审查 F2 要消掉的那一种静默(审查者挂的哨兵
   * 把实现者叫起来烧一个回合,审查那条会话继续等不到人)。
   */
  caller: MonitorCaller;
};

export type StartMonitorResult =
  | { ok: true; monitor: TaskMonitor }
  /** `needsWakeTarget` = 拒绝的理由是「说不清醒来叫谁」:调用方指定一个唤醒目标就能再来。 */
  | { ok: false; status: 400 | 404 | 409; error: string; needsWakeTarget?: true };

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
 * 那条命令**从未开工**,所以这条意图行也不该留下来:删掉它,面板上就跟没点过一样。
 * 删不掉也不致命 —— 它的 pid 是空的,接回那一侧按「没能记下 pid」单独收口。
 */
async function dropIntent(monitorId: string): Promise<void> {
  try {
    await db.delete(monitors).where(eq(monitors.id, monitorId));
  } catch (e) {
    console.error(`[ash] 哨兵登记行清不掉 monitor=${monitorId}（它没有 pid，启动恢复会把它判掉）:`, detail(e));
  }
}

/**
 * **pid 没能记下来**:收掉这个进程,然后照实说。单独一个函数是为了让它能被直接钉住 ——
 * 走到这里的两条路(回填失败、以及 win32 上没有闸时的同一个失败点)共用它,而它要判的那件
 * 事正是前几轮审查反复指的那一条:**收不干净的时候不许冒充收干净**。
 *
 * 仍然走完整的回收圈(落责任 → 发信号 → 确认退出 → 销账):POSIX 上壳停在闸前、不 trap 信号,
 * 那一刀必中,所以绝大多数时候真的是 `reclaimed`;而 win32 那一侧没有闸,命令可能已经在跑,
 * 这一圈是它唯一的回收路径。
 *
 * 两档结局分得很开:
 * - `reclaimed`(确认它退了)⇒ 它从未开工过,**意图行删掉**,界面上跟没点过一样;
 * - 其余两档(还没确认退出 / 连责任都没落库)⇒ **身份行必须留着**,那是这个进程唯一的线索
 *   (面板看得见、能点停、启动恢复枚举得到)。结局尽力写在那一行上,写不进去就只剩返回的
 *   这句话和日志 —— 哪一档都不许说成「已回收」。
 */
export async function abandonRegistration(row: Row, cause: string): Promise<StartMonitorResult> {
  const verdict = await settleReclaim(
    await reclaimMonitorProcess(row, "哨兵的 pid 没能记下来，进程一并收回", { fresh: true }),
  );
  if (verdict === "reclaimed") {
    await dropIntent(row.id);
    return { ok: false, status: 409, error: `哨兵登记失败，已回收它的进程：${cause}` };
  }
  const note = verdict === "owed"
    ? "没能记下它的 pid，进程还没确认退出，回收责任已记下（开机会再收一次）"
    : "没能记下它的 pid，而回收责任也没能落库（见 server 日志里的 pid，必要时手工收掉）";
  try {
    await db.update(monitors).set({ status: "lost", endedAt: now(), endedReason: note })
      .where(eq(monitors.id, row.id));
  } catch (inner) {
    console.error(`[ash] 哨兵 ${row.id} 的结局也写不进库:`, detail(inner));
  }
  publish(row.taskId);
  return { ok: false, status: 409, error: `哨兵登记失败，${note}：${cause}` };
}

/**
 * **放行之前被撤销**(用户点停 / 任务开始删除 / 记录已经没了):命令一个字都没跑过,但那个壳
 * 还在闸前面站着,所以照旧补一刀并走回收圈。
 *
 * 跟 `abandonRegistration` 的区别只有一条:**这里不碰那一行**。它上面写的是用户自己点出来
 * 的「已停止」,或者删除流程的中间态 —— 把它改掉或删掉就等于把「我停过」这件事从界面上
 * 抹掉(根 AGENTS.md:停止必须留下持久可见的状态)。
 */
async function cancelRegistration(row: Row, why: string): Promise<StartMonitorResult> {
  const verdict = await settleReclaim(
    await reclaimMonitorProcess(row, `${why}（放行前撤销，命令未开工）`, { fresh: true }),
  );
  if (verdict !== "reclaimed") {
    // 收不干净:责任在账本上(`owed`)或连账本都没写上(`unaccounted`,那一档 settleReclaim
    // 自己已经打到日志里并挂了补记梯子)。两档都不许说成「已经收掉了」。
    console.error(`[ash] 哨兵放行前被撤销，进程未确认退出 monitor=${row.id} pid=${row.pid}（${verdict}）`);
  }
  return {
    ok: false,
    status: 409,
    error: verdict === "reclaimed"
      ? `${why}，那条命令没有开工`
      : `${why}，那条命令没有开工；但它的壳还没确认退出，回收责任已记下`,
  };
}

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
  if (input.description !== undefined && input.description !== null && text(input.description) === null)
    return { ok: false, status: 400, error: "description 必须是字符串" };
  if (input.cwd !== undefined && input.cwd !== null && text(input.cwd) === null)
    return { ok: false, status: 400, error: "cwd 必须是字符串" };
  const description = text(input.description) || command;

  return serialize(`task:${input.taskId}`, async () => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, input.taskId))).at(0);
    if (!task) return { ok: false, status: 404, error: "任务不存在" };
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

    const live = await liveMonitorsOf(input.taskId);
    if (live.length >= MONITOR_MAX_PER_TASK)
      return { ok: false, status: 409, error: `这个任务已经有 ${live.length} 个哨兵在盯了（上限 ${MONITOR_MAX_PER_TASK}），先停掉一个` };

    const cwd = await resolveCwd(input.taskId, input.cwd);
    if (!cwd) return { ok: false, status: 409, error: "定位不到工作目录，显式传 cwd" };

    const monitorId = id();
    const logPath = monitorLogPath(input.taskId, monitorId);
    const timeoutMs = normalizeMonitorTimeout(input.timeoutMs);
    const startedAt = new Date();
    const intent: Row = {
      id: monitorId,
      taskId: input.taskId,
      command,
      description,
      cwd,
      status: "running",
      // **这两列先空着**：进程还没起，而身份行必须先落（见文件头的创建协议）。③ 回填。
      pid: null,
      pidStartedAt: null,
      logPath,
      offset: 0,
      events: 0,
      exitCode: null,
      // **同一个瞬间**算两列：分别取 Date.now() 会差 1ms，而对外那个到期时刻是
      // `started_at + timeout_ms` 现算的（见 toTaskMonitor），差值会变成「库里写的」与
      // 「卡片显示的」不一致。
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
      endedAt: null,
      endedReason: null,
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

    // ① 身份先落库。**这一步失败时什么都还没起**，所以没有任何要回收的东西 —— 不必落责任、
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
      spawned = spawnMonitor({ command, cwd, logPath });
    } catch (e) {
      await dropIntent(monitorId);
      return { ok: false, status: 409, error: `哨兵起不来，那条命令一个字都没开始跑：${detail(e)}` };
    }
    if ("error" in spawned) {
      await dropIntent(monitorId);
      return { ok: false, status: 409, error: spawned.error };
    }

    // ③ 把 pid 补上。补不上就**不放行** —— 命令从未开工，而不是「先跑起来再想办法追它」。
    const pid = spawned.pid;
    const row: Row = { ...intent, pid, pidStartedAt: inspectProcess(pid)?.startedAt ?? null };
    try {
      await db.update(monitors).set({ pid: row.pid, pidStartedAt: row.pidStartedAt })
        .where(eq(monitors.id, monitorId));
    } catch (e) {
      spawned.abandon();   // 关掉写端：壳读到 EOF，在 exec 之前自己退出
      return await abandonRegistration(row, detail(e));
    }

    // ④ **放行之前再核一次「这条命令现在还该不该开工」**。
    //
    // 身份齐全只是一半,另一半是「这条生命周期没被撤销」。创建是一段时间:①—③ 之间有真实的
    // 等待,而撤销有两条不排这条队的路 ——
    //  · 用户点停:`stopMonitor` 读到一条 pid 还空着的行时,会**先把「我停过」落盘**再进这条
    //    队列(见 monitors.ts)。上一版这里拿本地那份 running 快照无条件放行:页面已经显示
    //    停止、库里是 stopped,命令却随后才开工,而且再点停也停不下来(第 8 轮审查 F1 实测
    //    `storedStatus=stopped` + `commandStarted=true` + `aliveAfterSecondStop=true`);
    //  · 任务被删:`beginTaskRevocation` 是同步关闸、之后才去抢这条队列,所以入口那一问
    //    (`monitorSourceGate` 的第一行)可能在关闸之前就过了。
    // 读库那一份、不读本地快照:本地那份是 ① 写出去的,它答不出这中间发生过什么。
    const fresh = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    const revoked = isTaskRevoked(input.taskId);
    if (!fresh || fresh.status !== "running" || revoked) {
      spawned.abandon();   // 不放行:壳读到 EOF,在 exec 之前自己退出
      return await cancelRegistration(row, !fresh
        ? "创建还没完成，这条哨兵的记录已经没了"
        : revoked
          ? "创建还没完成，这个任务已经开始删除"
          : `创建还没完成，这条哨兵已经被停掉了（${fresh.endedReason ?? "已停止"}）`);
    }

    // ⑤ **先挂运行时、再放行**。顺序反过来有个安静的洞:`echo x` 这种瞬间跑完的命令会在
    //    `attach` 之前就 exit。那个洞现在由 spawn 层的一次性结局缓冲兜住(晚订阅也收得到),
    //    但顺序照旧按「挂好再放行」排 —— 让「订阅不到」这件事连发生的机会都没有。
    // 「已起」这一行排在 attach 之前:挂上运行时的那一刻结局可能**已经发生**(壳自己就退了,
    // 一次性结局缓冲会当场把它结算成 exited),那时再写「已起」就排在「结束」后面了。
    await appendTaskTimeline(row.taskId, `哨兵已起：${row.description}（${command}）`);
    attach(row, spawned.onExit);
    // ⑥ 放行。命令从这一刻才真正开工,而它的身份在 ① 就已经可恢复、撤销资格在 ④ 刚核过。
    spawned.release();
    publish(row.taskId);
    return { ok: true, monitor: toTaskMonitor(row) };
  });
}
