// 哨兵（Monitor）的运行时：盯、推、停，以及 server 重启后把它们认回来。
// 语义和上限在 shared/src/monitor.ts，进程与放行闸在 monitor-spawn.ts，**创建协议**
// （先落身份、再起进程、回填 pid、放行）在 monitor-create.ts，HTTP 在 monitor-routes.ts；
// 这里只管编排。
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
//    后登记失败),都必须先落责任、再发信号、追到线索空才收档。只装在删除/审查收尾那两个
//    包装函数里是不够的 —— 其余每一条停止路径都会绕过它(第 5 轮审查 F1,现场见
//    monitor-reclaim-debts.ts 文件头)。
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  MONITOR_BATCH_MS,
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_LINE_CHARS,
  MONITOR_MAX_LINES_PER_PUSH,
  MONITOR_TAIL_DEFAULT_LINES,
  MONITOR_TAIL_MAX_BYTES,
  MONITOR_TAIL_MAX_LINES,
  monitorExactExpiry,
  type MonitorStatus,
  type TaskMonitor,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { monitors, tasks } from "./db/schema.js";
import { reclaimMonitorProcess, settleReclaim, type ReclaimVerdict } from "./monitor-reclaim-debts.js";
import { reclaimState, type ReclaimState } from "./monitor-reclaim-evidence.js";
import { adoptSpawnIdentity, notePendingIntent } from "./monitor-adopt.js";
import { clearSpawnIdentity, readLogTail, tailLines, type Tailer } from "./monitor-spawn.js";
import { IS_WINDOWS } from "./platform.js";

import { pushToTask } from "./monitor-events.js";
import { monitorWakeGate } from "./monitor-session.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export type Row = typeof monitors.$inferSelect;

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
//
// **创建层(monitor-create.ts)也从这里取运行时**:`serialize`(按任务排的那条创建队列)、
// `liveMonitorsOf`(配额)、`attach`(把 tail 和定时器挂起来)、`publish`、`toTaskMonitor`、
// `Row`。它拆出去只是因为「创建协议」那一段(先落身份、再起进程、回填 pid、放行)自己就是一
// 整件事,而这个文件已经顶到行数上限 —— 运行时仍然只有这一份。
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

export const publish = (taskId: string) => bus.publish({ type: "task.monitors", taskId });

// ── 盯 ───────────────────────────────────────────────────────────────────────

/**
 * **放后台跑的那种收尾**:定时器、探活、推满上限、进程自己退出 —— 四条都没有调用方在等
 * 它的结果,所以**它的失败只能进日志**。
 *
 * 不接住的话就是一个没人管的 rejection:Node 默认把那个当致命错误,于是「一次收尾里的某笔
 * 读写失败」会把整个 ash 带下去。撞上关库是最常见的一种(判出结束的那一刻 ash 可能正在退出,
 * 实测:审查生命周期那份回归在 teardown 之后收到一条 `database is not open`)。
 */
function settleInBackground(
  monitorId: string, status: Exclude<MonitorStatus, "running">, reason: string, code: number | null,
): void {
  void finish(monitorId, status, reason, code)
    .catch((e) => console.error(`[ash] 后台收尾失败 monitor=${monitorId}（${reason}）:`, e));
}

export function attach(row: Row, onExit?: (cb: (code: number | null) => void) => void): void {
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
    settleInBackground(row.id, "expired", `盯满了约定的时长（${row.expiresAt}）`, null);
  }, remaining);
  (expiry as { unref?: () => void }).unref?.();
  rt.timers.push(expiry);

  if (onExit) {
    onExit((code) => settleInBackground(row.id, "exited", "命令自己跑完了", code));
  } else {
    // 接管路径没有 ChildProcess,只能自己探活。pid 会被复用,所以必须连启动时刻一起认 ——
    // 但**「问不出来」不是「已经退了」**:ps 短暂不可用时身份这一问答不出东西,照它收尾就会
    // 在界面上写一句「命令已经不在了」,而那个命令还在跑(第 6 轮审查 F1)。所以只有能判出
    // 结果的那两档才收尾,`unknown` 就等下一个两秒再问 —— 而「判得出」的判据只有
    // `processIdentity` 那一份(一次快照、纯比较),不是某个布尔的假值(第 7 轮审查 F1)。
    const liveness = setInterval(() => {
      const state = reclaimState(row.pid ?? 0, row.pidStartedAt, row);
      if (state === "traceless") {
        settleInBackground(row.id, "exited",
          "命令已经不在了（server 重启期间跑完的，拿不到退出码）", null);
      } else if (state === "not-ours") {
        settleInBackground(row.id, "exited",
          "这个号现在是另一个进程了（原命令在停服期间结束，拿不到退出码）", null);
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
    settleInBackground(monitorId, "stopped", `推够了 ${MONITOR_MAX_EVENTS} 条事件自动停——每条事件都要唤醒任务跑一轮，再盯下去就是白烧回合。真要继续，换一条过滤更紧的命令重起一个`, null);
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
  // **回收这个进程的责任从这里起**(见文件头第 ③ 条)。下刀资格由取证层按档位判,这一层
  // 不再传「刚刚还在我们手上吗」那个开关(第 14 轮审查 F1:四个入口共用同一份判据)。
  //
  // 记账排在**改状态之前**:顺序一反,中间崩一下这一行就成了「显示已停止、责任没人认、
  // pid 线索下一步就被删除抹掉」(第 4、5 轮审查 F1 都是这个现场)。
  const outcome = await reclaimMonitorProcess(row, reason);
  await db
    .update(monitors)
    .set({ status, endedAt: now(), endedReason: reason, exitCode })
    .where(eq(monitors.id, monitorId));
  publish(row.taskId);
  const code = exitCode === null ? "" : `，退出码 ${exitCode}`;
  const total = (await db.select({ events: monitors.events }).from(monitors).where(eq(monitors.id, monitorId))).at(0)?.events ?? row.events;
  await appendTaskTimeline(row.taskId, `哨兵结束：${row.description}${code}。${reason}（共推送 ${total} 条事件）`);
  if (notify) await pushToTask(row, `【哨兵结束】${row.description}（monitorId=${row.id}）${code}。${reason}`);
  // **追线索放在最后**:状态、时间线、通知都已落定,这一步只负责「能收的档收掉」。
  // 它会等到补刀生效(有界,见 `confirmReclaimed`)—— 于是这个函数返回时,要么进程确认不在了,
  // 要么责任稳稳地留在账本上。
  //
  // 第三种(`unaccounted`:库写不进去)这里只能出声:**身份还在**(这一行没被删,pid 和启动
  // 时刻都还在上面),开机时 `reclaimUnconfirmedStops` 会按非运行态把它重问一遍。真正不能
  // 放过它的是**销毁身份**那条路 —— 那边整笔中止(见 monitor-reclaim.ts)。
  const verdict = await settleReclaim(outcome);
  if (verdict === "unaccounted") {
    console.error(
      `[ash] 哨兵收尾时既没确认退出、回收责任也没落库 monitor=${monitorId} pid=${row.pid}`
      + `（哨兵行还留着它的身份，开机会再问一遍）`,
    );
  }
  // 身份边条**只在线索追空之后**才撤(`closed`)。
  //
  // 它不只是「pid 空着那一档的兜底」:当这一行的 `pid_started_at` 还空着时,边条里那个时间锚
  // 是**唯一**能把身份补全的东西(见 monitor-reclaim-debts 的 `completeIdentity`)。责任还欠着
  // 就把它删掉,等于把「这一刻 ps 答不出来」永久固化成「这条永远证不出身份」:之后既不敢下刀,
  // 也销不掉账(第 10 轮审查 F2-B)。确认退出之后它才真的没用了。
  if (row.kind === "ash" && row.logPath && verdict === "closed") clearSpawnIdentity(row.logPath);
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

/**
 * 停一条哨兵。**它和创建共用 `task:<id>` 那条队列** —— 「停止」和「创建」是同一份资源所有权
 * 协议的两端,不排同一条队就会各自看到半成品:
 *
 * 上一版这里完全不参加那条队列,于是一次点停可以恰好落在「身份已登记、pid 还没回填」那一瞬:
 * 它读到 pid=null 的运行行 → 回收层按「没有待收资源」放过 → 写成 stopped 并**成功返回**,
 * 而创建随后照旧放行,命令这才开工;再点停时状态已经不是 running,`finish` 第一行就返回 ——
 * 页面写着已停止、进程活着、而且再也停不掉(第 8 轮审查 F1 实测 `aliveAfterSecondStop=true`)。
 *
 * 所以这里是两段:
 *  ① 读到一条**pid 还空着的运行行** = 创建正在半空中。先把「我停过」落盘 —— 创建方在放行
 *    之前会重读这一行(monitor-create.ts 的 ④),读到非 running 就不放行,命令一个字都不跑。
 *  ② 再进那条队列。拿到的是创建已经收口之后的终局,按它该怎么停就怎么停。
 */
export async function stopMonitor(monitorId: string, reason = "被停掉了"): Promise<TaskMonitor | null> {
  const before = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!before) return null;
  if (before.kind === "claude") return toTaskMonitor(before);
  // ① 创建还在半空中:**先落「我停过」**。条件更新(仍是 running 且 pid 仍空)避免跟同一瞬
  //    完成的创建互相覆盖 —— 回填成功的那一侧会让这条更新一行都不动,于是走 ② 的正常停止。
  if (before.status === "running" && before.pid === null) {
    await db
      .update(monitors)
      .set({ status: "stopped", endedAt: now(), endedReason: reason })
      .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running"), isNull(monitors.pid)));
  }
  // ② 进创建那条队列。**不排在队首插队**:创建只差几毫秒就收口,等它比跟它抢更便宜也更可证。
  return serialize(`task:${before.taskId}`, async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    if (!row) return toTaskMonitor(before);
    if (row.status === "running") {
      // 用户/agent 主动停的不回推收尾事件：他就是为了不再被它叫醒才点的停。但已经攒在缓冲里
      // 的行要照常推完——那是已经发生的事实，而且任务还活着，收得下。
      await finish(monitorId, "stopped", reason, null, { notify: false });
      const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
      return toTaskMonitor(after ?? row);
    }
    // 已经不是运行态了。**但「卡片上写着停了」不等于那个进程真的没了**:win32 那一侧没有
    // 放行闸(见 monitor-spawn.ts),① 的取消标记落下时命令可能已经开工。所以这里按**资源
    // 责任**再核一遍而不是看状态就返回 —— 这正是前几轮反复钉的那条判据。
    // 追空的那一档这里什么都不做:没有落点可打,而**身份还在这一行上**(命令、pid、记号),
    // 没有任何东西正在消失。留档发生在身份真要被销毁的那一刻 —— 删除/归档走的
    // `accountForLiveProcesses`(第 13 轮审查 F1-B,见 monitor-reclaim.ts)。
    // **pid 还空着的那一行也要走这一趟**(第 19 轮审查 F2):那是创建意图行(身份先落库、进程
    // 后起、pid 回填),它的结局恰恰最没确认 —— 判据交给 `reclaimMonitorProcess`,它会先问
    // 一遍认领、再按档位决定记责任还是收档,真的没有落点时才返回 `closed`。
    if (row.pid === null || reclaimState(row.pid, row.pidStartedAt, row) !== "traceless") {
      const outcome = await reclaimMonitorProcess(row, `${reason}（创建期取消后补收）`);
      if (await settleReclaim(outcome) === "unaccounted") {
        console.error(`[ash] 创建期取消后补收:既没确认退出、责任也没落库 monitor=${monitorId} pid=${row.pid}`);
      }
    }
    return toTaskMonitor(row);
  });
}

export async function liveMonitorsOf(taskId: string): Promise<Row[]> {
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



/** 「责任到底留下来了没有」那一句尾巴 —— 接回这两条路共用,措辞只有这一份。 */
const owingNote = (verdict: ReclaimVerdict): string =>
  verdict === "closed"
    ? "；原进程的线索随后都追空了"
    : verdict === "owed"
      ? "；原进程退出未确认，已记下回收责任（开机会再收一次）"
      : "；原进程退出未确认，而回收责任尚未保存（见 server 日志里的 pid，仍在重试落盘）";

/**
 * 接回的三档计数。`pending` 是**pid 还空着、这一刻又认不回来**的那几条:行原样留着
 * (见 `notePendingIntent`),所以它既不算接回来了、也不算没了 —— 混进任何一边都是撒谎。
 */
export async function reattachMonitors(): Promise<{ attached: number; lost: number; pending: number }> {
  // 只认 ash 自己起的：claude 的投影行没有 pid，拿去问身份必然认不出来，会被
  // 整批误判成 lost——而它们此刻多半还在 agent 那边好好跑着。它们的真实归宿由
  // `loseClaudeMonitorsOfSession` 在 agent 进程真的结束时统一收口。
  const rows = await db.select().from(monitors).where(and(eq(monitors.status, "running"), isAshKind));
  let attached = 0;
  let lost = 0;
  let pending = 0;
  for (const stored of rows) {
    let row = stored;
    // **「问不出来」要跟「它不在了」分开**(第 6 轮审查 F1)。`unknown` = ps 这一问自己失败
    // 了,那就什么都不许声称:**照旧接回来**。这样它仍然在界面上、仍然能被点停、日志还在
    // 收,而 ps 恢复之后探活那一问会自己把结果判出来(见 `attach` 里的 liveness)。原来这里
    // 按一个布尔一刀切,ps 短暂不可用就把一条还活着的哨兵写成「这个进程已经不在了」——
    // 既在界面上撒谎,又让它从此无法叫停。同一个错还有第二种犯法:身份比较自己去补一次
    // 查询,**第二次**失败时被写成确证的 `not-ours`(第 7 轮审查 F1,现在判定收在
    // `processIdentity` 一次快照里)。
    // **pid 是空的**:那是创建协议留下的意图行 —— 身份先落库、进程后起、pid 回填(见
    // monitor-create.ts 文件头)。重启后还能看见它,说明 ash 恰好死在「落了身份」和「回填
    // pid」之间。这一档**既不能按「线索追空」一笔带过,也不能冒充已经收干净**:
    //  · POSIX:命令从未开工 —— 它停在放行闸前等 ash 写一个字节,ash 一死写端就关了,壳
    //    读到 EOF 在 exec 之前自己退掉(exit 97)。所以这条行可以干净地判掉。
    //  · win32:那一侧没有闸(`cmd.exe` 里没有可靠的「从第 3 号句柄读一行」写法),命令可能
    //    已经在跑,而我们手里没有任何 pid 可以去认它 —— 照实说成「认不回来」。**未在
    //    Windows 真机验证**(根 AGENTS.md)。
    if (!row.pid) {
      const adopted = await adoptSpawnIdentity(row);
      // 认不下来的几种事实由 `adoptSpawnIdentity` 带回来(`why` / `settled` / `candidate`)。
      // **`settled: false` 不是终态**(第 19 轮审查 F2):只是**这一刻核实不了**(反证账本读不
      // 出来),一个字都不许说成「它不在了」(第 6 轮审查 F1 的同一条),**更不许把这一行写成
      // 一个此后谁都不会再问第二遍的档** —— 创建意图原样留着,理由见 `notePendingIntent`。
      if (!adopted.identity && !adopted.settled) {
        await notePendingIntent(row, adopted.why);
        pending += 1;
        continue;
      }
      if (!adopted.identity) {
        // `settled`:当初那个壳一定不在了(没留边条 / 反证过 / 那个号现在是另一个进程)。
        // 这一档 **win32 与 POSIX 的事实不同**,措辞和责任都跟着分开:
        //  · POSIX:放行闸证明命令压根没开工 ⇒ 干净判掉,顺手把边条作废 —— 留着它只会让后面
        //    的层拿一个已经被反证的号去记一笔永远收不掉的责任;
        //  · win32:那一侧没有闸,壳派生的命令可能还在跑,而边条上那个号是**唯一的落点线索**
        //    ⇒ 责任照记(候选号拿不到启动时刻,所以落在 `unverifiable` 档:记责任、不下刀)。
        //    **未在 Windows 真机验证**(根 AGENTS.md)。
        let owing = "";
        if (IS_WINDOWS && adopted.candidate) {
          const outcome = await reclaimMonitorProcess(
            { ...row, pid: adopted.candidate.pid, pidStartedAt: null },
            "server 重启后只认得出身份边条上那个号",
          );
          owing = owingNote(await settleReclaim(outcome, 0));
        } else {
          clearSpawnIdentity(row.logPath);
        }
        await finishOffline(row, "lost", (IS_WINDOWS
          ? `server 重启后认不回它了：起进程时没来得及记下 pid${adopted.why}，这台机器上没有放行闸，当初那个壳已经不在、但它派生的命令可能还在后台跑着（日志路径见这一行）`
          : `server 重启后判定它没有真正开工：起进程时没来得及记下 pid${adopted.why}，命令停在放行闸前面就退了`) + owing);
        lost += 1;
        continue;
      }
      // 认回来了:下面按正常身份走(接回 / 收尾 / 记责任),不再有特殊分支。
      row = { ...row, pid: adopted.identity.pid, pidStartedAt: adopted.identity.pidStartedAt };
    }
    const state = reclaimState(row.pid!, row.pidStartedAt, row);
    // `unverifiable`(当初没记下启动时刻 / 边条认回来时 ps 不可用)跟 `unknown` 同一档处理:
    // **什么都不许声称,所以照旧接回来**。它仍然在界面上、仍然能被点停、日志还在收,而
    // 「不敢下刀」这件事由回收层那一侧保证(第 9 轮审查 F3)。写成 `lost` 反而是撒谎。
    if (state === "ours-alive" || state === "unknown" || state === "unverifiable") {
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
        // 剩下几档各有各的说法,**不能共用一句话**(措辞见 `offlineReason`):`traceless` 线索追空
      // 了;`not-ours` 这个号现在是别人的(原来那个退没退证明不了);`suspected` 文本里还看得见
      // 这次创建的记号、但证不出在谁身上;`ours-orphans` 组长退了、组里还有后代。除了第一档
      // 都要先把回收责任记下来(判据见 reclaimMonitorProcess 那张表)。
      const outcome = await reclaimMonitorProcess({ ...row, pid: row.pid! }, "server 重启后它的身份对不上");
      // **先拿到最终 verdict,再写文案。** 这里不等补刀(deadline 0:只问一次状态,别把开机
      // 吊住),所以把它提到写卡片之前不会让启动变慢 —— 但顺序反过来就会写下一句假话:上一版
      // 无论结果是什么都先把「已记下回收责任」写进卡片,而债表写失败(`unaccounted`)时那句话
      // 只在 server 日志里被纠正过,卡片上那句肯定会一直留着(第 7 轮审查 N1)。责任落盘之后
      // 的推进交给紧随其后的 `reclaimUnconfirmedStops` / `sweepMonitorReclaimDebts` 和梯子。
      const verdict = await settleReclaim(outcome, 0);
      if (verdict === "unaccounted") {
        console.error(`[ash] 接回时既没确认退出、回收责任也没落库 monitor=${row.id} pid=${row.pid}`);
      }
      await finishOffline(row, "lost", offlineReason(state, owingNote(verdict)));
      lost += 1;
    }
  }
  return { attached, lost, pending };
}

/**
 * 接回时判不回来的那几档,各自那一句话。**分开写**是因为它们是不同的事实,而这句话会留在
 * 卡片上(第 7 轮审查 N1:卡片上的话不许被 server 日志「纠正」)。
 */
function offlineReason(state: ReclaimState, owing: string): string {
  if (state === "traceless") return "server 重启后这个进程已经不在了（它在停服期间跑完的，拿不到退出码）";
  if (state === "not-ours") {
    return `server 重启后这个号已经是另一个进程了（原命令在停服期间结束，拿不到退出码）${owing}`;
  }
  if (state === "suspected") {
    return "server 重启后这个号已经不在了，但进程表里还看得见这次创建的资源记号"
      + `（这台机器只拿得到无边界的 ps 展示文本，证不出它在哪个进程里，所以不敢下刀）${owing}`;
  }
  return `server 重启后它的组长已经退出、组里还有后代（拿不到退出码）${owing}`;
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
