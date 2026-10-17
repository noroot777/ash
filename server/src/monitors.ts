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
import { monitors } from "./db/schema.js";
import { reclaimMonitorProcess, settleReclaim } from "./monitor-reclaim-debts.js";
import { reclaimState } from "./monitor-reclaim-evidence.js";
import { stopPendingAdopts } from "./monitor-reattach.js";
import { clearSpawnIdentity, readLogTail, tailLines, type Tailer } from "./monitor-spawn.js";

import { pushToTask } from "./monitor-events.js";
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
  /**
   * 探活那一根(两秒一问「这个号还是它吗」)。**单独记着而不是混在 `timers` 里**:pid 还空着
   * 的那种行(创建意图这一刻认不回来)先只接 tail 和期限,号认回来之后才补装这一根 ——
   * 判得出「有没有装过」靠的就是这个字段(第 21 轮审查 F1:不许把「列上有 pid」当成「已经
   * 有运行时在盯」)。
   */
  liveness: NodeJS.Timeout | null;
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

/**
 * **把一条哨兵接到运行时上**:tail(读日志、推事件)、期限、探活。
 *
 * 三件事**不是一起生效的**(第 21 轮审查 F1):pid 还空着的创建意图行先接前两件 —— 日志是
 * 我们自己的文件、期限是我们自己承诺的,这两件跟「认不认得回它的号」无关;探活那一根要等
 * 号认回来再补,因为它问的就是「这个号还是它吗」,拿一个空号去问只会判出假结果。
 *
 * 所以这个函数**可以对同一行调第二遍**:已经在盯的不重挂 tail,只在「这次带着 pid、而且
 * 还没装过探活」时把那一根补上。上一版第一行就 `return`,于是「梯子认回了号、接管那一步
 * 又抛了」之后,这一行再也没有人探活(审查原话:不能把「有 pid」当成「已有运行时」)。
 */
export function attach(row: Row, onExit?: (cb: (code: number | null) => void) => void): void {
  const existing = runtimes.get(row.id);
  if (existing) {
    if (!existing.closing && !existing.liveness && !onExit && row.pid !== null) {
      superviseLiveness(row, existing);
    }
    return;
  }
  // rt 先成形、tail 后挂：tail 的回调必须闭包引用**这一个** rt，不能回头去查注册表。
  // 查注册表的写法有个安静的洞——`finish` 为了防重入会先把自己摘出注册表，再 drain
  // 一次把进程临死前那几行吸干；那时候回调查到的是 undefined，于是最后一批事件被整批
  // 丢掉（实测：命令吐 3 行，只收到 2 行）。
  const rt: Runtime = {
    tail: null as unknown as Tailer, timers: [], buffer: [], readTo: null, flush: null,
    closing: false, liveness: null,
  };
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
  } else if (row.pid !== null) {
    superviseLiveness(row, rt);
  }
  // pid 还空着就先不装探活:见 `superviseLiveness`。tail 和期限上面已经挂好了 —— 这一行的
  // 日志照常读、到点照常收尾,一个信号也不因此多发(信号资格一律在取证层)。
}

/**
 * 两秒一问「这个号上的进程还是当初那一个吗」。**只有拿得到 pid 的行才装**。
 *
 * 接管路径没有 ChildProcess,只能自己探活。pid 会被复用,所以必须连启动时刻一起认 ——
 * 但**「问不出来」不是「已经退了」**:ps 短暂不可用时身份这一问答不出东西,照它收尾就会
 * 在界面上写一句「命令已经不在了」,而那个命令还在跑(第 6 轮审查 F1)。所以只有能判出
 * 结果的那两档才收尾,`unknown` 就等下一个两秒再问 —— 而「判得出」的判据只有
 * `processIdentity` 那一份(一次快照、纯比较),不是某个布尔的假值(第 7 轮审查 F1)。
 */
function superviseLiveness(row: Row, rt: Runtime): void {
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
  rt.liveness = liveness;
  rt.timers.push(liveness);
}

/**
 * **撤掉一条哨兵的运行时**(tail、缓冲、定时器),一个字都不写库。
 *
 * 用在「这一行已经是终态了,但没走 `finish`」那条路上:点停对 pid 还空着的行先落一个取消
 * 标记再进队列(见 `stopMonitor` 的 ①),而那种行**现在也挂着 tail 和期限**(创建意图这一刻
 * 认不回来时由 monitor-reattach 的 pending 分支接上)。不撤的话一条已经停掉的哨兵会继续读
 * 日志、继续算自己的期限,到点再走一次收尾(第 21 轮审查 F2 的同一条判据:停止赢了就是赢了)。
 *
 * 撤之前照旧把文件吸干、把缓冲排一遍 —— 那一批行要不要推由 `flushBuffer` 按**当前状态**
 * 决定(已经停掉就不推:用户点停就是为了不再被它叫醒),这里不替它决定。
 */
export async function detachMonitor(monitorId: string): Promise<void> {
  const rt = runtimes.get(monitorId);
  if (!rt || rt.closing) return;
  rt.closing = true;
  runtimes.delete(monitorId);
  for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
  if (rt.flush) clearTimeout(rt.flush);
  rt.tail.drain();
  rt.tail.stop();
  await serialize(monitorId, () => flushBuffer(monitorId, rt)).catch(() => {});
}

/** 这一行此刻有没有运行时在盯(tail/期限)。**判据是运行时,不是 pid 那一列**。 */
export const isSupervised = (monitorId: string): boolean => {
  const rt = runtimes.get(monitorId);
  return rt !== undefined && !rt.closing;
};

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
  // **条件落定**(第 21 轮审查 F2)。上面那次重读之后还 await 了回收层(问状态、下刀、等确认,
  // 秒级),而这期间用户完全可以点停、可以删任务 —— 上一版这条 UPDATE 无条件,通知还紧跟其后,
  // 于是「点停已经成功返回、页面写着用户停的」随后被这条在途的收尾改写成 expired 并补推一条
  // 【哨兵结束】。条件没落上就**结局不改、通知不推**;回收责任照旧结清 —— 那一笔是上面已经
  // 发生的事,跟谁写下结局无关。
  const result = await db
    .update(monitors)
    .set({ status, endedAt: now(), endedReason: reason, exitCode })
    .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running")));
  if (Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) === 0) {
    console.error(`[ash] 哨兵收尾放手 monitor=${monitorId}：条件更新没落上，结局已经有人写过了（${reason}）`);
    await settleReclaim(outcome);
    return;
  }
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
    const marked = await db
      .update(monitors)
      .set({ status: "stopped", endedAt: now(), endedReason: reason })
      .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running"), isNull(monitors.pid)));
    // 标记落上了 ⇒ 这一行从此是终态,**运行时要跟着撤**:pid 还空着的行现在也可能挂着 tail
    // 和期限(见 monitor-reattach 的 pending 分支)。没落上说明同一瞬创建收口了,那条路由
    // 下面的 ② 正常处理 —— 这时撤运行时就是把一条还在盯的哨兵弄瞎。
    if (Number((marked as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) > 0) {
      await detachMonitor(monitorId);
    }
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
export async function finishOffline(
  row: Row,
  status: Exclude<MonitorStatus, "running">,
  reason: string,
): Promise<void> {
  // **排进这条哨兵自己的队列,而且在队列里重读一遍**(第 21 轮审查 F2)。这个函数原来只在
  // 开机那一趟被调(那时还没有人能点停),现在恢复梯子也会在任意时刻调它 —— 于是它跟用户
  // 点停、跟删除撞在一起:审查实测到的现场是**点停已经成功返回**(stopped、待发 0 条、理由
  // 是用户明确点停),随后这条在途的旧回调照旧把行写成 `expired` 并补推一条结束通知。
  //
  // 「await 之前读到的 running」不是「await 之后的所有权」:下面每一步(补读、落终态、通知)
  // 都要按**队列里重读到的那一行**判,而且落终态用条件更新 —— 条件没落上就一个字都不写、
  // 一条通知都不推。
  await serialize(row.id, async () => {
    if (dbClient.closed) return;
    const fresh = (await db.select().from(monitors).where(eq(monitors.id, row.id))).at(0);
    if (!fresh || fresh.status !== "running") {
      console.error(`[ash] 离线收尾放手 monitor=${row.id}：队列里重读到的状态是 `
        + `${fresh?.status ?? "行已不在"}，这一刻的结局已经有人写过了（${reason}）`);
      return;
    }
    const collected: string[] = [];
    let readTo = fresh.offset;
    const tail = tailLines(fresh.logPath, fresh.offset, (lines, offset) => {
      for (const line of lines) if (line.trim()) collected.push(line);
      readTo = offset;
    });
    tail.drain();
    tail.stop();

    let events = fresh.events;
    if (collected.length) events = await pushLines(fresh, collected, readTo);
    else if (readTo !== fresh.offset) await commitOffset(fresh.id, readTo);

    const result = await db
      .update(monitors)
      .set({ status, endedAt: now(), endedReason: reason, exitCode: null })
      .where(and(eq(monitors.id, fresh.id), eq(monitors.status, "running")));
    if (Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) === 0) {
      // 条件没落上 = 这一瞬有人把它收尾了。**结束通知到此为止**:再推就是在用户已经停掉
      // 之后又叫醒一次任务(补读出去的那几行是已经发生的事实,留着)。
      console.error(`[ash] 离线收尾的条件更新没落上 monitor=${fresh.id}：结局已经有人写过了`);
      return;
    }
    publish(fresh.taskId);
    await appendTaskTimeline(fresh.taskId, `哨兵结束：${fresh.description}。${reason}（共推送 ${events} 条事件）`);
    await pushToTask(fresh, `【哨兵结束】${fresh.description}（monitorId=${fresh.id}）。${reason}`);
  });
}

// 接回那一摊搬去了 monitor-reattach.ts(单文件 700 行的约定)。**出口仍然只有这一个**:
// index.ts、测试台子和重启子进程都按 `monitors.js` 的这个名字拿它。
export { reattachMonitors } from "./monitor-reattach.js";

/** 只给测试用：把内存里的 tail/定时器全撤了，进程不动。 */
export function detachAllMonitors(): void {
  // 待认领那几行的恢复梯子也要撤:它是 unref 的定时器,但测试里库会被关掉,让它醒过来只会
  // 对着一个关了的库发问(第 20 轮审查 F2)。
  stopPendingAdopts();
  for (const [, rt] of runtimes) {
    rt.closing = true;
    for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
    if (rt.flush) clearTimeout(rt.flush);
    rt.tail.stop();
  }
  runtimes.clear();
}
