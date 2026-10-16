// 哨兵（Monitor）的运行时：起、盯、推、停，以及 server 重启后把它们认回来。
// 语义和上限在 shared/src/monitor.ts，进程与 tail 在 monitor-spawn.ts，HTTP 在
// monitor-routes.ts；这里只管编排。
//
// 两条贯穿全文件的设计：
//
// ① **事件走既有的待发送消息链路，不另开一条唤醒通道。** 一条事件要做的事
//    （任务在跑就等它跑完、空闲就立刻续会话、归档就作废、server 重启后不丢、界面托盘
//    里看得见、用户能撤）pending-messages.ts 全都已经做对了，而且每一条都踩过坑。
//    哨兵只负责把事件写成一行字排进去，`origin` 标明是谁推的。
//
// ② **一条事件 = 唤醒一次 = 一个真实的模型回合。** 所以合并是第一位的：同一个哨兵还没
//    送出去的事件直接往那一行后面追加，agent 一次醒来看完全部；而不是一行一个回合。
//
// ③ **这个文件是真正拥有哨兵进程的那一层**,所以「回收责任」这一圈归它走:凡是把一条哨兵
//    写成非运行态的地方(用户点停、到期、推满上限、命令自己退出、启动接回判无出口、创建
//    后登记失败),都必须先落责任、再发信号、确认退出才销账。只装在删除/审查收尾那两个
//    包装函数里是不够的 —— 其余每一条停止路径都会绕过它(第 5 轮审查 F1,现场见
//    monitor-reclaim-debts.ts 文件头)。
import { and, desc, eq } from "drizzle-orm";
import {
  MONITOR_BATCH_MS,
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_LINE_CHARS,
  MONITOR_MAX_LINES_PER_PUSH,
  MONITOR_MAX_PER_TASK,
  MONITOR_TAIL_DEFAULT_LINES,
  MONITOR_TAIL_MAX_BYTES,
  MONITOR_TAIL_MAX_LINES,
  normalizeMonitorTimeout,
  monitorExactExpiry,
  type MonitorStatus,
  type TaskMonitor,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { monitors, projects, sessions, tasks } from "./db/schema.js";
import { reclaimMonitorProcess, reclaimState, settleReclaim } from "./monitor-reclaim-debts.js";
import { monitorLogPath, readLogTail, spawnMonitor, tailLines, type Tailer } from "./monitor-spawn.js";
import { pushToTask } from "./monitor-events.js";
import { monitorSourceGate, monitorWakeGate, type MonitorCaller } from "./monitor-session.js";
import { inspectProcess } from "./proc.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id, now } from "./util.js";

type Row = typeof monitors.$inferSelect;

/**
 * 「这一行是 ash 自己起的进程吗」——**所有碰进程、碰日志的查询都必须带上它**。
 *
 * 表里混着 claude 内置 Monitor 的只读投影（`kind='claude'`，见 shared/src/monitor.ts
 * 文件头）：那些行 `pid` 是 null、`log_path` 是空串。漏掉这道过滤的后果按调用点各不相同，
 * 但没有一个是良性的——`reattachMonitors` 会拿 null pid 去问身份然后把一堆
 * 投影行判成 `lost`（它们明明还在 agent 那边跑着）；`liveMonitorsOf` 会让投影行占掉
 * 每任务 4 个的创建配额；`stopMonitorsForTask` 会对着它们空跑一遍 finish。
 *
 * 唯一**不带**这道过滤的是 `listMonitors` / `getMonitor`：面板要的就是两种一起。
 */
// 回收层(monitor-reclaim.ts)跟这里是同一摊账,所以这三样对它公开:哪些行算 ash 自己的、
// 每条哨兵自己的那条队列、以及「把一条哨兵收尾」。它只做资格判断,不另起一套运行时。
export const isAshKind = eq(monitors.kind, "ash");

export const toTaskMonitor = (r: Row): TaskMonitor => ({
  id: r.id,
  taskId: r.taskId,
  kind: (r.kind === "claude" ? "claude" : "ash"),
  nativeId: r.nativeId,
  lifetime: (r.sourceLifetime === "persistent" || r.sourceLifetime === "unknown" ? r.sourceLifetime : "bounded"),
  command: r.command,
  sourceRole: r.sourceRole === "reviewer" ? "reviewer" : r.sourceRole === "single" ? "single" : null,
  description: r.description,
  cwd: r.cwd,
  status: r.status as MonitorStatus,
  pid: r.pid,
  events: r.events,
  exitCode: r.exitCode,
  startedAt: r.startedAt,
  // 到期时刻**现算，不读 `expires_at` 那一列**：判据与算式都在 `monitorExactExpiry` 里，
  // 时长和起点各自的证据少一样就只给时长。为什么不能读列见那个函数的注释——`expires_at`
  // 是 NOT NULL 列，期限未知时存的是占位值，而「读列 + 开关判断」漏过两类占位值。
  expiresAt: monitorExactExpiry(r),
  /** 时长独立于起点：起点不确定时这一列仍然有值，卡片改说「总共盯 X（起点不确定）」。 */
  timeoutMs: r.timeoutMs ?? null,
  endedAt: r.endedAt,
  endedReason: r.endedReason,
});

type Runtime = {
  tail: Tailer;
  timers: NodeJS.Timeout[];
  buffer: string[];
  /** 缓冲里这批行读到文件的哪个字节。**事件落库之后**才跟着推进（见 pushLines）。 */
  readTo: number | null;
  flush: NodeJS.Timeout | null;
  /** 收尾只做一次：过期定时器、进程退出、用户点停，三条路可能同时到。 */
  closing: boolean;
};
const runtimes = new Map<string, Runtime>();
/** 同一个哨兵的推送串行化：两批事件同时落库会把 offset / events 互相写回去。 */
const chains = new Map<string, Promise<unknown>>();

export function serialize<T>(monitorId: string, job: () => Promise<T>): Promise<T> {
  const prev = chains.get(monitorId) ?? Promise.resolve();
  const next = prev.then(job, job);
  chains.set(monitorId, next.catch(() => {}));
  return next;
}

const publish = (taskId: string) => bus.publish({ type: "task.monitors", taskId });

// ── 起 ───────────────────────────────────────────────────────────────────────

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

export type StartMonitorResult =
  | { ok: true; monitor: TaskMonitor }
  /** `needsWakeTarget` = 拒绝的理由是「说不清醒来叫谁」:调用方指定一个唤醒目标就能再来。 */
  | { ok: false; status: 400 | 404 | 409; error: string; needsWakeTarget?: true };

const text = (value: unknown): string | null => (typeof value === "string" ? value.trim() : null);

/**
 * 起一个哨兵。
 *
 * **整段按任务串行**：「数一数在跑几个」和「插进去一条」之间隔着 spawn 和好几个 await，
 * 并发打进来时每一个都在别人落库之前数完了数，于是六个请求能一起过 4 个的闸、真的起六个
 * 长跑进程（第 1 轮审查实测 successfulStarts=6）。既有的 `serialize` 按 monitorId 排队，
 * 护不到「还没有 id」的创建期，所以这里按 `task:<id>` 另排一条队。
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
    const spawned = spawnMonitor({ command, cwd, logPath });
    if ("error" in spawned) return { ok: false, status: 409, error: spawned.error };

    const timeoutMs = normalizeMonitorTimeout(input.timeoutMs);
    const startedAt = new Date();
    const row: Row = {
      id: monitorId,
      taskId: input.taskId,
      command,
      description,
      cwd,
      status: "running",
      pid: spawned.pid,
      pidStartedAt: inspectProcess(spawned.pid)?.startedAt ?? null,
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
    try {
      await db.insert(monitors).values(row);
    } catch (e) {
      // 登记失败就把刚起的进程收回来：留着它就是一个谁都看不见、也停不掉的后台命令。
      // 走的是跟 `finish` 同一圈(落责任 → 发信号 → 确认退出 → 销账):这一行没进库,
      // **责任表是它唯一的线索**,少了这一笔就等于谁都不知道它存在过。
      const verdict = await settleReclaim(
        await reclaimMonitorProcess(row, "哨兵登记失败，进程一并收回", { fresh: true }),
      );
      // **三种结果各说各的**。`unaccounted` 时这个进程既没有身份行、也没有责任行,只剩
      // 这句话和日志 —— 不许冒充「已记下」(第 6 轮审查 F1)。
      const tail = verdict === "reclaimed" ? "已回收它的进程"
        : verdict === "owed" ? "进程还没确认退出，回收责任已记下（开机会再收一次）"
        : "**进程可能还在后台跑着，而回收责任也没能落库**（见 server 日志里的 pid，必要时手工收掉）";
      return { ok: false, status: 409, error: `哨兵登记失败，${tail}：${e instanceof Error ? e.message : String(e)}` };
    }
    attach(row, spawned.onExit);
    publish(row.taskId);
    await appendTaskTimeline(row.taskId, `哨兵已起：${row.description}（${command}）`);
    return { ok: true, monitor: toTaskMonitor(row) };
  });
}

// ── 盯 ───────────────────────────────────────────────────────────────────────

function attach(row: Row, onExit?: (cb: (code: number | null) => void) => void): void {
  if (runtimes.has(row.id)) return;
  // rt 先成形、tail 后挂：tail 的回调必须闭包引用**这一个** rt，不能回头去查注册表。
  // 查注册表的写法有个安静的洞——`finish` 为了防重入会先把自己摘出注册表，再 drain
  // 一次把进程临死前那几行吸干；那时候回调查到的是 undefined，于是最后一批事件被整批
  // 丢掉（实测：命令吐 3 行，只收到 2 行）。
  const rt: Runtime = { tail: null as unknown as Tailer, timers: [], buffer: [], readTo: null, flush: null, closing: false };
  rt.tail = tailLines(row.logPath, row.offset, (lines, offset) => {
    // 收尾中也照收：`finish` 会先 drain 一次再推，进程死前最后几行不该因为「已经在停了」
    // 就丢掉。收尾时不另起定时器——那一批由 finish 自己同步推出去。
    for (const line of lines) if (line.trim()) rt.buffer.push(line);
    // 读到的全是空行：没有事件要落，位置可以直接前进（不存在「推进了却丢事件」的风险）。
    if (!rt.buffer.length) {
      void serialize(row.id, () => commitOffset(row.id, offset));
      return;
    }
    rt.readTo = offset;
    if (!rt.flush && !rt.closing) {
      rt.flush = setTimeout(() => {
        rt.flush = null;
        void serialize(row.id, () => flushBuffer(row.id, rt));
      }, MONITOR_BATCH_MS);
      (rt.flush as { unref?: () => void }).unref?.();
    }
  });
  runtimes.set(row.id, rt);

  const remaining = Math.max(0, new Date(row.expiresAt).getTime() - Date.now());
  const expiry = setTimeout(() => {
    void finish(row.id, "expired", `盯满了约定的时长（${row.expiresAt}）`, null);
  }, remaining);
  (expiry as { unref?: () => void }).unref?.();
  rt.timers.push(expiry);

  if (onExit) {
    onExit((code) => void finish(row.id, "exited", "命令自己跑完了", code));
  } else {
    // 接管路径没有 ChildProcess,只能自己探活。pid 会被复用,所以必须连启动时刻一起认 ——
    // 但**「问不出来」不是「已经退了」**:ps 短暂不可用时身份这一问答不出东西,照它收尾就会
    // 在界面上写一句「命令已经不在了」,而那个命令还在跑(第 6 轮审查 F1)。所以只有能判出
    // 结果的那两档才收尾,`unknown` 就等下一个两秒再问 —— 而「判得出」的判据只有
    // `processIdentity` 那一份(一次快照、纯比较),不是某个布尔的假值(第 7 轮审查 F1)。
    const liveness = setInterval(() => {
      const state = reclaimState(row.pid ?? 0, row.pidStartedAt);
      if (state === "gone") {
        void finish(row.id, "exited", "命令已经不在了（server 重启期间跑完的，拿不到退出码）", null);
      } else if (state === "not-ours") {
        void finish(row.id, "exited", "这个号现在是另一个进程了（原命令在停服期间结束，拿不到退出码）", null);
      }
    }, 2000);
    (liveness as { unref?: () => void }).unref?.();
    rt.timers.push(liveness);
  }
}

async function commitOffset(monitorId: string, offset: number): Promise<void> {
  if (dbClient.closed) return;
  await db.update(monitors).set({ offset }).where(eq(monitors.id, monitorId)).catch(() => {});
}

function trim(line: string): string {
  return line.length > MONITOR_MAX_LINE_CHARS ? `${line.slice(0, MONITOR_MAX_LINE_CHARS)}…（本行已截断）` : line;
}

/**
 * 把一批行变成一条事件消息，**消息落库之后**才推进事件计数和读取位置。
 *
 * 这个顺序是硬要求，不是讲究：位置先走、消息后落的话，中间哪怕只隔那 300ms 的批量窗口，
 * server 一停这几行就永远没人读了——游标已经越过去，内容还躺在日志里，任务却一个字都
 * 收不到（第 1 轮审查复现：read_offset=13、events=0、消息为空，日志里那行完好无损）。
 * 反过来排的代价只是重启后可能把同一批行再推一次，重复远比静默丢失便宜。
 */
async function pushLines(row: Row, lines: string[], readTo: number | null): Promise<number> {
  const shown = lines.slice(0, MONITOR_MAX_LINES_PER_PUSH).map(trim);
  const omitted = lines.length - shown.length;
  const head = `【哨兵事件】${row.description}（monitorId=${row.id}）`;
  const tail = omitted > 0 ? `\n…（这一批共 ${lines.length} 行，上面只列了前 ${shown.length} 行）` : "";
  const delivered = await pushToTask(row, `${head}\n${shown.join("\n")}${tail}`);
  // `events` 数的是「**唤醒过任务几次**」，不是「读到过几行」。没投出去的那几行一次唤醒
  // 都没造成，计进去只会让卡片显示「已有 3 条事件」而任务那边一声没响——用户据此以为
  // 通知已经处理过了（第 2 轮审查实测：终态任务上卡片显示 1 条事件、待发消息数 0）。
  // 位置同理不推进：这批行没人读过，留着让日志回看还能看到。
  const events = delivered ? row.events + lines.length : row.events;
  await db
    .update(monitors)
    .set({ events, ...(delivered && readTo !== null ? { offset: readTo } : {}) })
    .where(eq(monitors.id, row.id));
  publish(row.taskId);
  return events;
}

async function flushBuffer(monitorId: string, rtOverride?: Runtime): Promise<void> {
  const rt = rtOverride ?? runtimes.get(monitorId);
  if (!rt || !rt.buffer.length || dbClient.closed) return;
  const lines = rt.buffer.splice(0, rt.buffer.length);
  const readTo = rt.readTo;
  rt.readTo = null;
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!row || row.status !== "running") return;

  const events = await pushLines(row, lines, readTo);

  if (events >= MONITOR_MAX_EVENTS) {
    // **不能 await**：这里正跑在 `serialize(monitorId, …)` 的队列里，而 finish 收尾时
    // 还要往同一条队列里排一次最后的 flush。await 它就是等自己后面那一位，当场死锁。
    void finish(monitorId, "stopped", `推够了 ${MONITOR_MAX_EVENTS} 条事件自动停——每条事件都要唤醒任务跑一轮，再盯下去就是白烧回合。真要继续，换一条过滤更紧的命令重起一个`, null);
  }
}

// ── 停 ───────────────────────────────────────────────────────────────────────

/**
 * 收尾。三条路都可能到这儿（过期、进程自己退出、有人点停），只做一次。
 *
 * `notify=false` 用在「任务自己已经结束了」那一路：那时候再推一条收尾事件就等于把一个
 * 已经 done 的任务重新叫起来跑一轮，纯属倒忙。
 */
export async function finish(
  monitorId: string,
  status: Exclude<MonitorStatus, "running">,
  reason: string,
  exitCode: number | null,
  opts: { notify?: boolean; keepBuffered?: boolean } = {},
): Promise<void> {
  const notify = opts.notify ?? true;
  const keepBuffered = opts.keepBuffered ?? true;
  const rt = runtimes.get(monitorId);
  if (rt) {
    if (rt.closing) return;
    rt.closing = true;
    runtimes.delete(monitorId);
    for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
    if (rt.flush) clearTimeout(rt.flush);
    if (keepBuffered) {
      // 进程刚死那一瞬写进去的最后几行也算数：先把文件吸干，再把缓冲里剩下的一并推出去。
      rt.tail.drain();
      rt.tail.stop();
      await serialize(monitorId, () => flushBuffer(monitorId, rt)).catch(() => {});
    } else {
      // 任务自己已经结束的那一路：缓冲里这几行一个都不推。`notify=false` 只挡住最后那条
      // 「哨兵结束」，挡不住这一批——它照样会排进待发队列，而紧接着的 flushPendingForTask
      // 会立刻把它送进会话（第 1 轮审查实测：任务 done 之后被重新拉起跑了一轮）。
      rt.tail.stop();
      rt.buffer.length = 0;
      rt.readTo = null;
    }
  }
  if (dbClient.closed) return;
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!row || row.status !== "running") return;
  // **回收这个进程的责任从这里起**(见文件头第 ③ 条)。`fresh: true` 的依据就是上面那一行
  // 判断:这一行此刻还是 running,进程是我们自己起的或刚接回的,所以「组长死了、组里还有人」
  // 这一档也敢下刀 —— 那几个只可能是它的后代。
  //
  // 记账排在**改状态之前**:顺序一反,中间崩一下这一行就成了「显示已停止、责任没人认、
  // pid 线索下一步就被删除抹掉」(第 4、5 轮审查 F1 都是这个现场)。
  const outcome = await reclaimMonitorProcess(row, reason, { fresh: true });
  await db
    .update(monitors)
    .set({ status, endedAt: now(), endedReason: reason, exitCode })
    .where(eq(monitors.id, monitorId));
  publish(row.taskId);
  const code = exitCode === null ? "" : `，退出码 ${exitCode}`;
  const total = (await db.select({ events: monitors.events }).from(monitors).where(eq(monitors.id, monitorId))).at(0)?.events ?? row.events;
  await appendTaskTimeline(row.taskId, `哨兵结束：${row.description}${code}。${reason}（共推送 ${total} 条事件）`);
  if (notify) await pushToTask(row, `【哨兵结束】${row.description}（monitorId=${row.id}）${code}。${reason}`);
  // **确认退出放在最后**:状态、时间线、通知都已落定,这一步只负责「能销的账销掉」。
  // 它会等到补刀生效(有界,见 `confirmReclaimed`)—— 于是这个函数返回时,要么进程确认不在了,
  // 要么责任稳稳地留在账本上。
  //
  // 第三种(`unaccounted`:库写不进去)这里只能出声:**身份还在**(这一行没被删,pid 和启动
  // 时刻都还在上面),开机时 `reclaimUnconfirmedStops` 会按非运行态把它重问一遍。真正不能
  // 放过它的是**销毁身份**那条路 —— 那边整笔中止(见 monitor-reclaim.ts)。
  if (await settleReclaim(outcome) === "unaccounted") {
    console.error(
      `[ash] 哨兵收尾时既没确认退出、回收责任也没落库 monitor=${monitorId} pid=${row.pid}`
      + `（哨兵行还留着它的身份，开机会再问一遍）`,
    );
  }
}

export type StopMonitorResult =
  | { ok: true; monitor: TaskMonitor }
  | { ok: false; status: 404 | 409; error: string };

/**
 * 停一个哨兵。
 *
 * claude 内置 Monitor 的投影行**一律拒绝**而不是静默忽略：它的进程在 agent 自己的进程树
 * 里，`TaskStop` 是 claude 进程内的工具，ash 没有任何手柄够得着。假装停掉（把状态改成
 * stopped 就返回）比报错坏得多——那个进程还在那边跑着、还会继续唤醒任务，而界面上写着
 * 「已停止」，用户再也不会回头看它。前端据此根本不给 claude 那种卡渲染停止按钮，这里是
 * 第二道闸（API 直调、旧前端）。
 */
export async function stopMonitorChecked(monitorId: string, reason = "被停掉了"): Promise<StopMonitorResult> {
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!row) return { ok: false, status: 404, error: "哨兵不存在" };
  if (row.kind === "claude") {
    return {
      ok: false,
      status: 409,
      error: "这是 claude 自己起的 Monitor，ash 只能看不能停——它的进程在智能体的进程树里。要停只能让智能体自己 TaskStop，或者停掉整个任务。",
    };
  }
  const monitor = await stopMonitor(monitorId, reason);
  return monitor ? { ok: true, monitor } : { ok: false, status: 404, error: "哨兵不存在" };
}

export async function stopMonitor(monitorId: string, reason = "被停掉了"): Promise<TaskMonitor | null> {
  const before = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!before) return null;
  if (before.kind === "claude") return toTaskMonitor(before);
  if (before.status !== "running") return toTaskMonitor(before);
  // 用户/agent 主动停的不回推收尾事件：他就是为了不再被它叫醒才点的停。但已经攒在缓冲里
  // 的行要照常推完——那是已经发生的事实，而且任务还活着，收得下。
  await finish(monitorId, "stopped", reason, null, { notify: false });
  const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  return toTaskMonitor(after ?? before);
}

async function liveMonitorsOf(taskId: string): Promise<Row[]> {
  return db.select().from(monitors).where(and(eq(monitors.taskId, taskId), eq(monitors.status, "running"), isAshKind));
}

export async function listMonitors(taskId: string): Promise<TaskMonitor[]> {
  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId)).orderBy(desc(monitors.startedAt));
  return rows.map(toTaskMonitor);
}

export async function getMonitor(monitorId: string): Promise<TaskMonitor | null> {
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  return row ? toTaskMonitor(row) : null;
}

/**
 * 哨兵日志的尾巴。界面要能回答「它这会儿到底在吐什么」——只给事件数的话，一个「0 条事件」
 * 既可能是命令还没开始吐，也可能是过滤条件写错了把什么都滤没了，而这两件事的处理方式相反。
 *
 * 读的是**日志全文的尾巴**，而不是事件正文的回放：单批超过上限时事件里只留条数、合并
 * 超长时最早那截会被掐掉，被省掉的那些行只有这里还找得到。
 */
export async function readMonitorTail(
  monitorId: string,
  maxLines = MONITOR_TAIL_DEFAULT_LINES,
): Promise<{ lines: string[]; truncated: boolean } | null> {
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!row) return null;
  // claude 那种没有日志文件：它的输出进了 agent 自己的会话，ash 这边一个字节都没有。
  // 返回空而不是读 `logPath`（空串）——后者会变成一次对仓库根目录的读取尝试。
  if (row.kind === "claude") return { lines: [], truncated: false };
  const limit = Math.min(MONITOR_TAIL_MAX_LINES, Math.max(1, Math.round(maxLines)));
  const tail = readLogTail(row.logPath, MONITOR_TAIL_MAX_BYTES);
  return tail.lines.length > limit
    ? { lines: tail.lines.slice(-limit), truncated: true }
    : tail;
}

// ── 重启后认回来 ─────────────────────────────────────────────────────────────

/**
 * 进程已经不在了的那一路：**先把日志里没读过的那段补完**，再落终态。
 *
 * 不补的代价是整段工作白跑——而「一件事要跑两小时」恰恰是哨兵存在的全部理由：命令在
 * ash 关闭期间跑完，重启后只看到一句「进程已不在」，那两小时的进展和结束结果一个字都
 * 不会到任务头上（第 1 轮审查复现：日志里有 OFFLINE_DONE，任务一条通知都没有）。
 *
 * 退出码确实拿不到，如实记 null —— 不拿 0 冒充跑成功了。
 */
async function finishOffline(
  row: Row,
  status: Exclude<MonitorStatus, "running">,
  reason: string,
): Promise<void> {
  const collected: string[] = [];
  let readTo = row.offset;
  const tail = tailLines(row.logPath, row.offset, (lines, offset) => {
    for (const line of lines) if (line.trim()) collected.push(line);
    readTo = offset;
  });
  tail.drain();
  tail.stop();

  let events = row.events;
  if (collected.length) events = await pushLines(row, collected, readTo);
  else if (readTo !== row.offset) await commitOffset(row.id, readTo);

  await db
    .update(monitors)
    .set({ status, endedAt: now(), endedReason: reason, exitCode: null })
    .where(eq(monitors.id, row.id));
  publish(row.taskId);
  await appendTaskTimeline(row.taskId, `哨兵结束：${row.description}。${reason}（共推送 ${events} 条事件）`);
  await pushToTask(row, `【哨兵结束】${row.description}（monitorId=${row.id}）。${reason}`);
}

/**
 * 开机把上一个 server 留下的哨兵接回来。进程本来就没跟着死（这是整件事的全部意义），
 * 所以这里要做的只有两件：确认那个 pid 还是当初那个进程，然后从 `offset` 接着读。
 * 重启那几十秒里产出的行都还在文件里，一条不漏。
 *
 * 认不出来的（进程没了、或 pid 被别人复用了）落 `lost`，但**落之前先把它留下的输出读完**：
 * 「进程不在了」说的是这一刻，不是说它这段时间什么都没干。
 *
 * **接回也是一道资格判断,不只是认人**(第 3、4 轮审查 F1):事实已经落库、而回收那一刀还
 * 没落下去就崩了的话,照着「同代还活着 + 没到期」接回来的是一个**已经没有出口**的命令 ——
 * 它推的每一条都会被出口闸拒回,一直烧到自己到期。所以这里问的就是出口那一份资格本身
 * (`monitorWakeGate`:归档、任务终态、来源审查那一轮还在不在),而不是挨个补某一种 reason。
 */
/**
 * 这一行**现在**还有出口吗 —— 跟创建、事件出口共用 `monitorWakeGate`(见 monitor-session.ts)。
 *
 * 任务行都没了是另一回事:那是删除中途崩了的残留,接回来谁也叫不醒。
 */
async function reattachBlockedReason(row: Row): Promise<string | null> {
  const task = (await db
    .select({ id: tasks.id, status: tasks.status, archived: tasks.archived })
    .from(tasks)
    .where(eq(tasks.id, row.taskId))).at(0);
  if (!task) return "它的任务已经不在了";
  return monitorWakeGate(task, { reviewRun: row.sourceReviewRun, reviewRound: row.sourceReviewRound });
}

export async function reattachMonitors(): Promise<{ attached: number; lost: number }> {
  // 只认 ash 自己起的：claude 的投影行没有 pid，拿去问身份必然认不出来，会被
  // 整批误判成 lost——而它们此刻多半还在 agent 那边好好跑着。它们的真实归宿由
  // `loseClaudeMonitorsOfSession` 在 agent 进程真的结束时统一收口。
  const rows = await db.select().from(monitors).where(and(eq(monitors.status, "running"), isAshKind));
  let attached = 0;
  let lost = 0;
  for (const row of rows) {
    // **「问不出来」要跟「它不在了」分开**(第 6 轮审查 F1)。`unknown` = ps 这一问自己失败
    // 了,那就什么都不许声称:**照旧接回来**。这样它仍然在界面上、仍然能被点停、日志还在
    // 收,而 ps 恢复之后探活那一问会自己把结果判出来(见 `attach` 里的 liveness)。原来这里
    // 按一个布尔一刀切,ps 短暂不可用就把一条还活着的哨兵写成「这个进程已经不在了」——
    // 既在界面上撒谎,又让它从此无法叫停。同一个错还有第二种犯法:身份比较自己去补一次
    // 查询,**第二次**失败时被写成确证的 `not-ours`(第 7 轮审查 F1,现在判定收在
    // `processIdentity` 一次快照里)。
    const state = row.pid ? reclaimState(row.pid, row.pidStartedAt) : "gone";
    if (state === "ours-alive" || state === "unknown") {
      // 它还有出口吗(归档 / 任务终态 / 起它的那次审查那一轮还在不在)。没有就收掉,别接回来
      // 继续烧。先接上再收尾:attach 把 tail 建起来,finish 的 drain 才读得到停服期间那一段,
      // 也由它负责杀进程。
      const blocked = await reattachBlockedReason(row);
      if (blocked) {
        attach(row);
        await finish(row.id, "stopped", `${blocked}（server 重启期间发生的）`, null);
        lost += 1;
        continue;
      }
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        // 先接上再收尾：attach 把 tail 建起来，finish 的 drain 才读得到停服期间那一段；
        // 它同时负责把这个还活着、但已经超时的进程杀掉。
        attach(row);
        await finish(row.id, "expired", "盯满了约定的时长（server 重启期间到期）", null);
        continue;
      }
      attach(row);
      attached += 1;
    } else {
      // 剩下三档各有各的说法,**不能共用一句话**:`gone` 真的退了;`not-ours` 这个号现在是
      // 别人的(原来那个退没退证明不了);`ours-orphans` 组长退了、组里还有后代。后两档都要
      // 先把回收责任记下来 —— `fresh: false`,隔了一次重启不敢对孤儿组下刀,这个号可能已经
      // 被别人当组长用过(判据见 reclaimMonitorProcess 那张表)。
      const outcome = await reclaimMonitorProcess(row, "server 重启后它的身份对不上", { fresh: false });
      await finishOffline(row, "lost", state === "gone"
        ? "server 重启后这个进程已经不在了（它在停服期间跑完的，拿不到退出码）"
        : state === "not-ours"
          ? "server 重启后这个号已经是另一个进程了（原命令在停服期间结束，拿不到退出码）；原进程退出未确认，已记下回收责任"
          : "server 重启后它的组长已经退出、组里还有后代（拿不到退出码），已记下回收责任，开机会再收一次");
      // 这里不等补刀(启动期要一行一行过,别把开机吊住):责任已落盘,交给紧随其后的
      // `reclaimUnconfirmedStops` / `sweepMonitorReclaimDebts` 和梯子。
      if (await settleReclaim(outcome, 0) === "unaccounted") {
        console.error(`[ash] 接回时既没确认退出、回收责任也没落库 monitor=${row.id} pid=${row.pid}`);
      }
      lost += 1;
    }
  }
  return { attached, lost };
}

/** 只给测试用：把内存里的 tail/定时器全撤了，进程不动。 */
export function detachAllMonitors(): void {
  for (const [, rt] of runtimes) {
    rt.closing = true;
    for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
    if (rt.flush) clearTimeout(rt.flush);
    rt.tail.stop();
  }
  runtimes.clear();
}
