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
import { and, desc, eq, like, isNull } from "drizzle-orm";
import {
  MONITOR_BATCH_MS,
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_LINE_CHARS,
  MONITOR_MAX_LINES_PER_PUSH,
  MONITOR_MAX_PER_TASK,
  MONITOR_TAIL_DEFAULT_LINES,
  MONITOR_TAIL_MAX_BYTES,
  MONITOR_TAIL_MAX_LINES,
  mergeMonitorEventText,
  monitorBlockedReason,
  normalizeMonitorTimeout,
  monitorMessageOrigin,
  type MonitorStatus,
  type TaskMonitor,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { monitors, projects, scheduledMessages, sessions, tasks } from "./db/schema.js";
import { killByPid } from "./executors/spawn.js";
import { monitorLogPath, readLogTail, spawnMonitor, tailLines, type Tailer } from "./monitor-spawn.js";
import { enqueueMessage, flushPendingForTask, publishPendingMessages } from "./pending-messages.js";
import { isSameProcess, inspectProcess } from "./proc.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id, now } from "./util.js";

type Row = typeof monitors.$inferSelect;

export const toTaskMonitor = (r: Row): TaskMonitor => ({
  id: r.id,
  taskId: r.taskId,
  command: r.command,
  description: r.description,
  cwd: r.cwd,
  status: r.status as MonitorStatus,
  pid: r.pid,
  events: r.events,
  exitCode: r.exitCode,
  startedAt: r.startedAt,
  expiresAt: r.expiresAt,
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

function serialize<T>(monitorId: string, job: () => Promise<T>): Promise<T> {
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

export type StartMonitorResult = { ok: true; monitor: TaskMonitor } | { ok: false; status: 400 | 404 | 409; error: string };

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
    // 入口与出口同一份判据（`monitorBlockedReason`）。只判归档、不判终态的话，已完成的
    // 任务上照样起得来一个真进程，而 `pushToTask` 会把它推的每一条都按终态拒掉——命令
    // 在后台烧着，任务永远不醒（第 2 轮审查实测）。
    const blocked = monitorBlockedReason(task);
    if (blocked) return { ok: false, status: 409, error: blocked };

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
      startedAt: now(),
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      endedAt: null,
      endedReason: null,
      ownerUserId: input.ownerUserId ?? null,
    };
    try {
      await db.insert(monitors).values(row);
    } catch (e) {
      // 登记失败就把刚起的进程收回来：留着它就是一个谁都看不见、也停不掉的后台命令。
      killByPid(spawned.pid);
      return { ok: false, status: 409, error: `哨兵登记失败，已回收它的进程：${e instanceof Error ? e.message : String(e)}` };
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
    // 接管路径没有 ChildProcess，只能自己探活。pid 会被复用，所以必须连启动时刻一起认。
    const liveness = setInterval(() => {
      if (!isSameProcess(row.pid ?? 0, row.pidStartedAt)) {
        void finish(row.id, "exited", "命令已经不在了（server 重启期间跑完的，拿不到退出码）", null);
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

/**
 * 把一段事件文本送到任务头上。
 *
 * **先合并、再新建**：这个哨兵名下还有一条没送出去（也没人正在送）的消息时，直接往它后面
 * 追加。任务正忙的那几分钟里攒下的十几条事件于是只唤醒它一次；而不是排十几行、醒十几轮。
 * 带着投递租约的那一行不能碰 —— 它正在被送进会话，改它等于改一句已经出口的话。
 */
async function pushToTask(row: Row, text: string): Promise<boolean> {
  // 任务自己已经结束/归档了就不再往它头上排事件——排了就是在某个深夜把一个 done 的任务
  // 重新叫起来跑一轮（第 1 轮审查实测：总线真实走了 done → running → done）。这道判断
  // 放在**唯一出口**上而不是散在调用点：收尾路径有五条（过期 / 自己退出 / 被停 / 推满
  // 上限 / 重启后补读），逐条去加漏一条就等于没防。
  const task = (await db
    .select({ status: tasks.status, archived: tasks.archived })
    .from(tasks)
    .where(eq(tasks.id, row.taskId))).at(0);
  if (!task || monitorBlockedReason(task) !== null) return false;

  const origin = monitorMessageOrigin(row.id);
  const existing = (await db
    .select()
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.taskId, row.taskId),
      eq(scheduledMessages.origin, origin),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
    ))).at(0) ?? null;
  await mergeOrEnqueueMonitorEvent(row, text, existing);
  flushPendingForTask(row.taskId);
  return true;
}

/**
 * 「追加进那一行」还是「另起一条」。
 *
 * 合并那一发是一次 CAS（条件就是「租约还空着」），**它可以合法地落空**：上面查到这一行
 * 之后、这里改到它之前，投递方完全可能刚好抢走租约。落空就必须另起一条新消息，不能当成
 * 改成功了 —— 那一批行既没进任何一条消息、位置还会跟着前进，于是整批进展静默消失
 * （第 2 轮审查实测：events=2、read_offset 已越过第二条，而消息里只有第一条）。
 *
 * **单独成一个函数是为了让那个窗口能被测到**：`existing` 由调用方传进来，于是回归测试
 * 可以先查出这一行、再真的抢走租约、然后拿着那份**已经过期**的 `existing` 调它 —— 这正
 * 是竞态产生的那个现场，而且走的是生产代码本身，不需要往产线里埋测试钩子。
 */
export async function mergeOrEnqueueMonitorEvent(
  row: Row,
  text: string,
  existing: typeof scheduledMessages.$inferSelect | null,
): Promise<void> {
  const merged = existing
    ? await db
      .update(scheduledMessages)
      .set({ text: mergeMonitorEventText(existing.text, text) })
      .where(and(eq(scheduledMessages.id, existing.id), isNull(scheduledMessages.deliveringSince)))
      .returning({ id: scheduledMessages.id })
    : [];
  if (merged.length > 0) {
    publishPendingMessages(row.taskId);
  } else {
    await enqueueMessage({ taskId: row.taskId, text, origin: monitorMessageOrigin(row.id), ownerUserId: row.ownerUserId });
  }
}

// ── 停 ───────────────────────────────────────────────────────────────────────

/**
 * 收尾。三条路都可能到这儿（过期、进程自己退出、有人点停），只做一次。
 *
 * `notify=false` 用在「任务自己已经结束了」那一路：那时候再推一条收尾事件就等于把一个
 * 已经 done 的任务重新叫起来跑一轮，纯属倒忙。
 */
async function finish(
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
  if (row.pid && isSameProcess(row.pid, row.pidStartedAt)) killByPid(row.pid);
  await db
    .update(monitors)
    .set({ status, endedAt: now(), endedReason: reason, exitCode })
    .where(eq(monitors.id, monitorId));
  publish(row.taskId);
  const code = exitCode === null ? "" : `，退出码 ${exitCode}`;
  const total = (await db.select({ events: monitors.events }).from(monitors).where(eq(monitors.id, monitorId))).at(0)?.events ?? row.events;
  await appendTaskTimeline(row.taskId, `哨兵结束：${row.description}${code}。${reason}（共推送 ${total} 条事件）`);
  if (notify) await pushToTask(row, `【哨兵结束】${row.description}（monitorId=${row.id}）${code}。${reason}`);
}

export async function stopMonitor(monitorId: string, reason = "被停掉了"): Promise<TaskMonitor | null> {
  const before = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!before) return null;
  if (before.status !== "running") return toTaskMonitor(before);
  // 用户/agent 主动停的不回推收尾事件：他就是为了不再被它叫醒才点的停。但已经攒在缓冲里
  // 的行要照常推完——那是已经发生的事实，而且任务还活着，收得下。
  await finish(monitorId, "stopped", reason, null, { notify: false });
  const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  return toTaskMonitor(after ?? before);
}

/**
 * 把一个任务名下还活着的哨兵全停掉。调用点是任务**自己**结束的那一刻（落 done/failed/
 * canceled、归档、删除）。
 *
 * 为什么任务一结束就连坐：哨兵唯一的出口是「唤醒这个任务」，任务都结束了，它再醒来也只是
 * 花钱。要让哨兵继续盯，这一轮该用 pause_task 收尾而不是 complete_task —— 这句话同时写在
 * MCP 工具的说明里，是 agent 做选择时唯一能看到的判据。
 *
 * **跟创建走同一条 `task:<id>` 队列**：不排队的话「正在创建」和「任务刚结束」会并发——
 * 创建那边数完活着的哨兵、起完进程、还没插库，连坐这边已经扫完了一遍，于是新起的那个
 * 谁也没停，它会一直跑到自己结束或到期，而它推的每一条都被终态挡回（第 2 轮审查第 3 条
 * 要求一并护住的那个窗口）。排上队之后两种顺序都收口：连坐先跑 → 创建在锁里读到终态、
 * 直接拒；创建先跑 → 连坐看得见那一行、照常停它。
 */
export async function stopMonitorsForTask(taskId: string, reason: string): Promise<number> {
  return serialize(`task:${taskId}`, () => stopMonitorsForTaskLocked(taskId, reason));
}

async function stopMonitorsForTaskLocked(taskId: string, reason: string): Promise<number> {
  const all = await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.taskId, taskId));
  const live = await liveMonitorsOf(taskId);
  for (const m of live) await finish(m.id, "stopped", reason, null, { notify: false, keepBuffered: false });
  // 收尾只清得掉**还在缓冲里**的行。已经开始推的那一批不受影响：它手里拿着自己的
  // `lines`、也早就过了状态闸，落库会发生在清理之后——于是作废那一步扫不到它，它排进
  // 队列、把一个已经 done 的任务重新叫起来（第 3 轮审查实测：done → running → done）。
  // 所以先往每条哨兵自己的队列尾上排一个空活并等它轮到：轮到了就说明那一批已经写完。
  for (const m of all) await serialize(m.id, async () => {});
  // 停掉进程还不够：这一刻**已经排在待发队列里**的哨兵事件同样会把任务重新拉起来。
  await cancelPendingMonitorEvents(taskId);
  return live.length;
}

/**
 * 作废这个任务名下还没送出去的哨兵事件。
 *
 * 只动 `origin` 是哨兵的那些。真人写的排队追问要原样留着——他排的时候就知道任务可能
 * 正要结束，那条消息的意思是「下次醒来处理」，替他取消等于把他的话吞了。
 *
 * **带着投递租约的那一行不碰，但「租约 ≠ 已送达」**：那一行归抢下它的那位投递者，由它在
 * 真正起这一轮的入口上按最新状态自己撤回并取消（`pending-messages.ts` 的 `monitorWakeGuard`
 * —— 第 4 轮审查指出的就是这个窗口：资格只在扫描那一层判过一次，租约抢下之后再没人问）。
 * 为什么不干脆在这里把它一起作废：`markSent` 的 CAS 条件是 `status='pending'`，这边先改成
 * canceled 的话，一条**已经进了会话**的事件会在时间线上留下一句「未发送，已取消」——比漏掉
 * 它更糟。所以这一行只有一个主人，就是正在送它的那位。
 */
async function cancelPendingMonitorEvents(taskId: string): Promise<void> {
  if (dbClient.closed) return;
  await db
    .update(scheduledMessages)
    .set({ status: "canceled", sentAt: null, deliveringSince: null })
    .where(and(
      eq(scheduledMessages.taskId, taskId),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
      like(scheduledMessages.origin, "monitor:%"),
    ));
  publishPendingMessages(taskId);
}

async function liveMonitorsOf(taskId: string): Promise<Row[]> {
  return db.select().from(monitors).where(and(eq(monitors.taskId, taskId), eq(monitors.status, "running")));
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
 */
export async function reattachMonitors(): Promise<{ attached: number; lost: number }> {
  const rows = await db.select().from(monitors).where(eq(monitors.status, "running"));
  let attached = 0;
  let lost = 0;
  for (const row of rows) {
    if (row.pid && isSameProcess(row.pid, row.pidStartedAt)) {
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
      await finishOffline(row, "lost", "server 重启后这个进程已经不在了（它在停服期间跑完的，拿不到退出码）");
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
