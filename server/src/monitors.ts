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
import { and, desc, eq } from "drizzle-orm";
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
import { ensureSupervised, stopSupervisionHandover } from "./monitor-handover.js";
import { reclaimMonitorProcess, settleReclaim } from "./monitor-reclaim-debts.js";
import { reclaimState } from "./monitor-reclaim-evidence.js";
import { stopRecoveryRetries } from "./monitor-reattach.js";
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
  /**
   * 退出这件事由外面那个 `ChildProcess` 的回调管(创建那一路传 `onExit`)。**跟 `liveness`
   * 二选一**:判「退出检查装了没有」时两者任一即可(第 22 轮审查 F1-B)。
   */
  exitWatched: boolean;
};
const runtimes = new Map<string, Runtime>();
/** 期限那一根最快多久才许炸 —— 见 `attach` 里用它的地方。 */
const EXPIRY_FLOOR_MS = 1_000;
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
    closing: false, liveness: null, exitWatched: onExit !== undefined,
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

  // 地板 1 秒(第 23 轮审查 F1 的连带防护):已经过了期限的行接上来时,这一根本来会在同一个
  // tick 就炸 —— 而收尾失败之后监督会被交回来(见 `ensureSupervised`),两者凑在一起就是个
  // 热循环(接上→立刻收尾→又失败→再接上)。给一秒地板:到期一定还是收得掉,失败重试也被
  // 压成每秒一次。
  const remaining = Math.max(EXPIRY_FLOOR_MS, new Date(row.expiresAt).getTime() - Date.now());
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
  await serialize(monitorId, () => teardownRuntimeLocked(monitorId));
}

/**
 * 撤运行时那几步的本体。**调用方必须已经在 `serialize(monitorId)` 里** —— 里面要把缓冲
 * 排出去,而推送一律在那条队列上(排第二遍就是等自己后面那一位,当场死锁)。
 */
export async function teardownRuntimeLocked(monitorId: string): Promise<void> {
  const rt = runtimes.get(monitorId);
  if (!rt || rt.closing) return;
  rt.closing = true;
  runtimes.delete(monitorId);
  for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
  if (rt.flush) clearTimeout(rt.flush);
  rt.tail.drain();
  rt.tail.stop();
  await flushBuffer(monitorId, rt).catch(() => {});
}

/**
 * 这一行此刻**装了哪几份监督**。判据一律是运行时,不是 pid 那一列。
 *
 * 分两件说而不是一个布尔(第 22 轮审查 F1-B):`watching` = tail 和期限有人管;`exitWatched`
 * = 「这个进程退了没有」有人问(探活那一根,或者创建那一路手里的 ChildProcess 回调)。
 * pending 那一刻只有前者 —— 拿「有一个运行时」当成「监督齐了」,补装探活的那一句就再也
 * 走不到了。
 */
export function supervisionOf(monitorId: string): { watching: boolean; exitWatched: boolean } {
  const rt = runtimes.get(monitorId);
  if (!rt || rt.closing) return { watching: false, exitWatched: false };
  return { watching: true, exitWatched: rt.liveness !== null || rt.exitWatched };
}

// 「库里还是运行态就必须有人盯」那条不变量的接管者住在 monitor-handover.ts(它要排重试,
// 判据和本文件的运行时注册表咬得很紧,所以放在隔壁而不是塞进这里)。**公开面仍然从这里出**。
export {
  ensureSupervised, pendingSupervisionHandovers, stopSupervisionHandover, type HandoverOutcome,
} from "./monitor-handover.js";

/** 这一行此刻有没有运行时在盯(tail/期限)。 */
export const isSupervised = (monitorId: string): boolean => supervisionOf(monitorId).watching;

/** 这一行要的监督**齐了没有**:tail/期限总要有,pid 在列上还得有一份退出检查。 */
export const supervisionComplete = (row: { id: string; pid: number | null }): boolean => {
  const view = supervisionOf(row.id);
  return view.watching && (row.pid === null || view.exitWatched);
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
  // 运行时已经撤了,而终态还没落盘 —— 下面每一步都可能抛(回收层、条件更新、通知)。
  // **出这个函数时如果库里还是 running,监督必须还在**(第 23 轮审查 F1),所以从这里起包进
  // try/finally。成功那一路 `ensureSupervised` 读到终态,什么都不做。
  try {
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
  } finally {
    // 不传 `holdingChain`:这个函数本身不跑在 `serialize(monitorId)` 上(它只在里面排过
    // flush),所以让交接层把这一趟排进那条队列 —— 并发的两笔收尾于是各自有序,后落定的
    // 那一笔一定看得到前一笔刚挂回来的运行时(第 24 轮审查 N1)。
    await ensureSupervised(monitorId);
  }
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
    try {
      // **现有运行时在这里交接掉**(第 22 轮审查 N2):接回层现在给每一条运行行都先立 tail 和
      // 期限(连 pid 还空着的创建意图行也有),而这一趟判的就是「它已经不在了」。不撤的话一条
      // 已经写成终态的行还占着文件句柄、还在算自己的期限,到点再走一次收尾。撤之前照旧把
      // 文件吸干、把缓冲推出去(那一批是已经发生的事实)—— 所以下面**重读一遍**:offset 和
      // events 刚被那一次 flush 推进过,照 `fresh` 读会把同一批行再推一次。
      await teardownRuntimeLocked(fresh.id);
      const base = (await db.select().from(monitors).where(eq(monitors.id, fresh.id))).at(0) ?? fresh;

      const collected: string[] = [];
      let readTo = base.offset;
      const tail = tailLines(base.logPath, base.offset, (lines, offset) => {
        for (const line of lines) if (line.trim()) collected.push(line);
        readTo = offset;
      });
      tail.drain();
      tail.stop();

      let events = base.events;
      if (collected.length) events = await pushLines(base, collected, readTo);
      else if (readTo !== base.offset) await commitOffset(base.id, readTo);

      const result = await db
        .update(monitors)
        .set({ status, endedAt: now(), endedReason: reason, exitCode: null })
        .where(and(eq(monitors.id, base.id), eq(monitors.status, "running")));
      if (Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) === 0) {
        // 条件没落上 = 这一瞬有人把它收尾了。**结束通知到此为止**:再推就是在用户已经停掉
        // 之后又叫醒一次任务(补读出去的那几行是已经发生的事实,留着)。
        console.error(`[ash] 离线收尾的条件更新没落上 monitor=${base.id}：结局已经有人写过了`);
        return;
      }
      publish(base.taskId);
      await appendTaskTimeline(base.taskId, `哨兵结束：${base.description}。${reason}（共推送 ${events} 条事件）`);
      await pushToTask(base, `【哨兵结束】${base.description}（monitorId=${base.id}）。${reason}`);
    } finally {
      // 撤运行时排在读日志之前(自己那条 tail 不停下来就会边收尾边继续推),所以中间这一段
      // 里「监督已撤、终态未落」是真实的一瞬。**出去的时候还是 running 就把监督接回去**
      // (第 23 轮审查 F1 实测:让这条 UPDATE 抛一次,之后产出的结果一条都送不出去、期限
      // 过了也没有结束通知)。`holdingChain`:正跑在 `serialize(row.id)` 上,不能再排一次。
      //
      // 这一趟做不成会**自己排重试**(第 24 轮审查 F1):接回那一步用的是同一个库,它跟着
      // 这次故障一起失败时,光打一行日志就等于把这条哨兵永久丢掉。
      await ensureSupervised(row.id, { holdingChain: true });
    }
  });
}

// 接回那一摊搬去了 monitor-reattach.ts(单文件 700 行的约定)。**出口仍然只有这一个**:
// index.ts、测试台子和重启子进程都按 `monitors.js` 的这个名字拿它。
export { reattachMonitors } from "./monitor-reattach.js";
// 停止那一段住在 monitor-stop.ts(单文件行数上限),公开面照旧从这里出。
export { stopMonitor, stopMonitorChecked, type StopMonitorResult } from "./monitor-stop.js";

/** 只给测试用：把内存里的 tail/定时器全撤了，进程不动。 */
export function detachAllMonitors(): void {
  // 待认领那几行的恢复梯子也要撤:它是 unref 的定时器,但测试里库会被关掉,让它醒过来只会
  // 对着一个关了的库发问(第 20 轮审查 F2)。
  stopRecoveryRetries();
  // 监督交接那几跳同理:注入过读写失败的用例必然留下一两条排着的重试。
  stopSupervisionHandover();
  for (const [, rt] of runtimes) {
    rt.closing = true;
    for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
    if (rt.flush) clearTimeout(rt.flush);
    rt.tail.stop();
  }
  runtimes.clear();
}
