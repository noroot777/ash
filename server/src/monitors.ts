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
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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

export async function startMonitor(input: StartMonitorInput): Promise<StartMonitorResult> {
  const command = input.command?.trim();
  if (!command) return { ok: false, status: 400, error: "command 不能为空" };
  const task = (await db.select().from(tasks).where(eq(tasks.id, input.taskId))).at(0);
  if (!task) return { ok: false, status: 404, error: "任务不存在" };
  if (task.archived) return { ok: false, status: 409, error: "任务已归档，不能再挂哨兵" };

  const live = await liveMonitorsOf(input.taskId);
  if (live.length >= MONITOR_MAX_PER_TASK)
    return { ok: false, status: 409, error: `这个任务已经有 ${live.length} 个哨兵在盯了（上限 ${MONITOR_MAX_PER_TASK}），先停掉一个` };

  const cwd = await resolveCwd(input.taskId, input.cwd);
  if (!cwd) return { ok: false, status: 409, error: "定位不到工作目录，显式传 cwd" };

  const monitorId = id();
  const logPath = monitorLogPath(input.taskId, monitorId);
  const spawned = spawnMonitor({ command, cwd, logPath });
  if ("error" in spawned) return { ok: false, status: 409, error: spawned.error };

  const startedAt = now();
  const timeoutMs = normalizeMonitorTimeout(input.timeoutMs);
  const row: Row = {
    id: monitorId,
    taskId: input.taskId,
    command,
    description: input.description?.trim() || command,
    cwd,
    status: "running",
    pid: spawned.pid,
    pidStartedAt: inspectProcess(spawned.pid)?.startedAt ?? null,
    logPath,
    offset: 0,
    events: 0,
    exitCode: null,
    startedAt,
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    endedAt: null,
    endedReason: null,
    ownerUserId: input.ownerUserId ?? null,
  };
  await db.insert(monitors).values(row);
  attach(row, spawned.onExit);
  publish(row.taskId);
  await appendTaskTimeline(row.taskId, `哨兵已起：${row.description}（${command}）`);
  return { ok: true, monitor: toTaskMonitor(row) };
}

// ── 盯 ───────────────────────────────────────────────────────────────────────

function attach(row: Row, onExit?: (cb: (code: number | null) => void) => void): void {
  if (runtimes.has(row.id)) return;
  // rt 先成形、tail 后挂：tail 的回调必须闭包引用**这一个** rt，不能回头去查注册表。
  // 查注册表的写法有个安静的洞——`finish` 为了防重入会先把自己摘出注册表，再 drain
  // 一次把进程临死前那几行吸干；那时候回调查到的是 undefined，于是最后一批事件被整批
  // 丢掉（实测：命令吐 3 行，只收到 2 行）。
  const rt: Runtime = { tail: null as unknown as Tailer, timers: [], buffer: [], flush: null, closing: false };
  rt.tail = tailLines(row.logPath, row.offset, (lines, offset) => {
    // 收尾中也照收：`finish` 会先 drain 一次再推，进程死前最后几行不该因为「已经在停了」
    // 就丢掉。收尾时不另起定时器——那一批由 finish 自己同步推出去。
    for (const line of lines) if (line.trim()) rt.buffer.push(line);
    void serialize(row.id, () => commitOffset(row.id, offset));
    if (rt.buffer.length && !rt.flush && !rt.closing) {
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

async function flushBuffer(monitorId: string, rtOverride?: Runtime): Promise<void> {
  const rt = rtOverride ?? runtimes.get(monitorId);
  if (!rt || !rt.buffer.length || dbClient.closed) return;
  const lines = rt.buffer.splice(0, rt.buffer.length);
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!row || row.status !== "running") return;

  const shown = lines.slice(0, MONITOR_MAX_LINES_PER_PUSH).map(trim);
  const omitted = lines.length - shown.length;
  const events = row.events + lines.length;
  await db.update(monitors).set({ events }).where(eq(monitors.id, monitorId));

  const head = `【哨兵事件】${row.description}（monitorId=${row.id}）`;
  const tail = omitted > 0 ? `\n…（这一批共 ${lines.length} 行，上面只列了前 ${shown.length} 行）` : "";
  await pushToTask(row, `${head}\n${shown.join("\n")}${tail}`);
  publish(row.taskId);

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
async function pushToTask(row: Row, text: string): Promise<void> {
  const origin = monitorMessageOrigin(row.id);
  const existing = (await db
    .select()
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.taskId, row.taskId),
      eq(scheduledMessages.origin, origin),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
    ))).at(0);
  if (existing) {
    await db
      .update(scheduledMessages)
      .set({ text: mergeMonitorEventText(existing.text, text) })
      .where(and(eq(scheduledMessages.id, existing.id), isNull(scheduledMessages.deliveringSince)));
    publishPendingMessages(row.taskId);
  } else {
    await enqueueMessage({ taskId: row.taskId, text, origin, ownerUserId: row.ownerUserId });
  }
  flushPendingForTask(row.taskId);
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
  notify = true,
): Promise<void> {
  const rt = runtimes.get(monitorId);
  if (rt) {
    if (rt.closing) return;
    rt.closing = true;
    runtimes.delete(monitorId);
    for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
    if (rt.flush) clearTimeout(rt.flush);
    // 进程刚死那一瞬写进去的最后几行也算数：先把文件吸干，再把缓冲里剩下的一并推出去。
    rt.tail.drain();
    rt.tail.stop();
    await serialize(monitorId, () => flushBuffer(monitorId, rt)).catch(() => {});
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
  // 用户/agent 主动停的不回推收尾事件：他就是为了不再被它叫醒才点的停。
  await finish(monitorId, "stopped", reason, null, false);
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
 */
export async function stopMonitorsForTask(taskId: string, reason: string): Promise<number> {
  const live = await liveMonitorsOf(taskId);
  for (const m of live) await finish(m.id, "stopped", reason, null, false);
  return live.length;
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
 * 开机把上一个 server 留下的哨兵接回来。进程本来就没跟着死（这是整件事的全部意义），
 * 所以这里要做的只有两件：确认那个 pid 还是当初那个进程，然后从 `offset` 接着读。
 * 重启那几十秒里产出的行都还在文件里，一条不漏。
 *
 * 认不出来的（进程没了、或 pid 被别人复用了）落 `lost`：如实说清楚，不冒充还在盯。
 */
export async function reattachMonitors(): Promise<{ attached: number; lost: number }> {
  const rows = await db.select().from(monitors).where(eq(monitors.status, "running"));
  let attached = 0;
  const lost: Row[] = [];
  for (const row of rows) {
    if (row.pid && isSameProcess(row.pid, row.pidStartedAt)) {
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        await finish(row.id, "expired", "盯满了约定的时长（server 重启期间到期）", null, false);
        continue;
      }
      attach(row);
      attached += 1;
    } else {
      lost.push(row);
    }
  }
  if (lost.length) {
    await db
      .update(monitors)
      .set({ status: "lost", endedAt: now(), endedReason: "server 重启后这个进程已经不在了" })
      .where(inArray(monitors.id, lost.map((m) => m.id)));
    for (const m of lost) publish(m.taskId);
  }
  return { attached, lost: lost.length };
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
