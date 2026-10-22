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
import { statSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import {
  MONITOR_TAIL_DEFAULT_LINES,
  MONITOR_TAIL_MAX_BYTES,
  MONITOR_TAIL_MAX_LINES,
  monitorExactExpiry,
  monitorStartTrusted,
  type MonitorStatus,
  type TaskMonitor,
} from "@ash/shared/monitor";
import { parseEndCondition } from "@ash/shared/monitor-end-condition";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { stopSupervisionHandover } from "./monitor-handover.js";
import { reclaimState } from "./monitor-reclaim-evidence.js";
import { stopRecoveryRetries } from "./monitor-reattach.js";
import { readLogTail, tailLines, type Tailer } from "./monitor-spawn.js";
import { consumeTailChunk, flushBuffer } from "./monitor-consume.js";
// 「盯」这一段自己要叫后台收尾(到期、探活判死)。它住在 monitor-finish.ts —— 那边又要回头用
// 这里的 `runtimes`/`publish`,两个文件互相引用。公开面照旧从这里出(见下面「停」那一节的
// re-export),所以调用方一个都不用改。
import { settleInBackground } from "./monitor-finish.js";
import { appendTaskTimeline } from "./task-timeline.js";
// 消费层是从这个文件拆出去的（见 monitor-consume.ts 文件头）。这两个仍从这里导出:
// 它们的调用方（离线补读、创建协议）本来就按「找 monitors 要」在写，没必要跟着搬家。
export { commitProgress, pushLines } from "./monitor-consume.js";

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
  /**
   * 起点可不可信也**现算**，判据跟到期时刻那一半是同一个（`monitorStartTrusted`）。
   *
   * 这一列是对外契约的一部分而不是前端自己猜：库里明明记着「这个锚点有没有可重验的误差
   * 界」，而 `started_at` 是 `NOT NULL` 列、历史投影允许它退化成整轮执行的开始时刻（见
   * claude-monitor-commit.ts 那条 `?? fileStartedAt ?? now()`）。不把这份可信性带出去，
   * 读的人手上只剩一个合法日期字符串，只能当它是真的 —— 第 1 轮审查复现到的卡片就是这么
   * 把「那一轮几点开始的」写成了「这条哨兵几点挂上的」。
   */
  startedAtExact: monitorStartTrusted(r),
  // 到期时刻**现算，不读 `expires_at` 那一列**：判据与算式都在 `monitorExactExpiry` 里，
  // 时长和起点各自的证据少一样就只给时长。为什么不能读列见那个函数的注释——`expires_at`
  // 是 NOT NULL 列，期限未知时存的是占位值，而「读列 + 开关判断」漏过两类占位值。
  expiresAt: monitorExactExpiry(r),
  /** 时长独立于起点：起点不确定时这一列仍然有值，卡片改说「总共盯 X（起点不确定）」。 */
  timeoutMs: r.timeoutMs ?? null,
  endedAt: r.endedAt,
  endedReason: r.endedReason,
  /** 约定的结束条件(没约定过是 null)。界面据它答「这条会不会自己收工」。 */
  stopWhen: r.stopWhen ?? null,
  /** 这两列让界面答得出「它的结果还欠着吗、还要不要」（第 2 轮审查 N3）。 */
  resultHandoffAt: r.resultHandoffAt,
  resultsAbandonedAt: r.resultsAbandonedAt,
});

export type Runtime = {
  tail: Tailer;
  timers: NodeJS.Timeout[];
  buffer: string[];
  /** 缓冲里这批行读到文件的哪个字节。**事件落库之后**才跟着推进（见 pushLines）。 */
  readTo: number | null;
  /**
   * **正在送的批次数**。`flushBuffer` 一开头就把那一批从 `buffer` 里取走了,那一刻它既不在
   * 缓冲里、也还没落库 —— 空行快进得挡住这段窗口（第 3 轮审查 F1,判据见 `outstanding`）。
   */
  inflight: number;
  flush: NodeJS.Timeout | null;
  /**
   * **排干阶段读到的那条命中行**（没读到是 null，见 monitor-consume.ts 的 `flushLocked`）。
   *
   * 收尾所有权是单一的（见 monitor-finish.ts 的 `finishing`）:到期先占到槽位、它排干时才
   * 命中约定字样的话,那一笔命中只能合并等它 —— 结局照旧写成 expired「盯满了约定的时长」,
   * 而用户会把这句读成「约定的字样一直没出现」（第 1 轮审查 N1 实测:字样比期限早 209ms）。
   * 所以证据记在这里,由**持有者落终态前**统一折叠（见 `finishHeld` 的 `foldHit`）—— 所有权
   * 仍然只有一个,改的只是它写下的那个结局。
   */
  hit: string | null;
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
export const runtimes = new Map<string, Runtime>();
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

/**
 * 那个日志文件**这一刻有多少字节**。读不出来给 `null`。
 *
 * 这是「它到底有没有产出过」唯一的直接证据。**不许拿 `monitors.read_offset` 代替**:那是
 * 投递游标,只在 `pushToTask` 接受投递时才推进 —— 终态/归档会把投递挡回、`keepBuffered:false`
 * 会把没投出去的缓冲丢掉,那时日志里有字而游标还是 0(第 2 轮审查 R2-4)。
 */
export function monitorLogBytes(logPath: string): number | null {
  try { return statSync(logPath).size; } catch { return null; }
}

// ── 盯 ───────────────────────────────────────────────────────────────────────


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
/**
 * 库里存着一条**这一版读不出来**的结束条件 ⇒ 当场出声（第 2 轮审查 F2）。
 *
 * 创建闸不会放这种值进来（`parseEndCondition` 在起进程之前就拦），所以走到这儿的只有一种
 * 来源:**这一行是从库里接回来的**（server 重启后 `reattachMonitors`、跨版本接力过来的任务、
 * 手改过的库）。而语义换过一轮 —— 上一版收 JS 正则源文,这一版是字面量候选（见 shared 的
 * `monitor-end-condition.ts` 文件头 ①）—— 于是 `^(READY|FAILED)$` 这样的旧值今天解析不出来。
 *
 * **处置是「当它没有结束条件」,但不许静默**:静默降级之后,库里明明记着一条结束条件、卡片
 * 照旧念「…就收工」、而哨兵只会盯到到期(审查实测:READY 已经吐出来,status 仍是 running)。
 * 出声这件事落在三处:这一行日志(排查)、时间线(用户刷新页面还看得见)、卡片措辞
 * (`endConditionNote` 照实说读不出来)。不另开一列记「语义版本」—— 要紧的不是这个值出自
 * 哪一版,而是**这一版能不能解释它**;能不能解释每次接回现算一次就答得出,而一个版本号
 * 只会在下一次语义变动时同样需要重算。
 */
function noteUnreadableCondition(row: Row): void {
  const raw = (row.stopWhen ?? "").trim();
  if (!raw) return;
  const parsed = parseEndCondition(raw);
  if (parsed.ok) return;
  console.error(`[ash] 哨兵 ${row.id} 存着一条读不出来的结束条件 ${JSON.stringify(raw)}：${parsed.error}`);
  void appendTaskTimeline(
    row.taskId,
    `哨兵「${row.description}」存着一条这一版读不出来的结束条件「${raw}」（结束条件不是正则，是字样）。`
    + "它不会提前收工，只会盯到到期——要让它早点收工，用改得对的条件另起一个。",
  ).catch(() => undefined);
}

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
    tail: null as unknown as Tailer, timers: [], buffer: [], readTo: null, inflight: 0, flush: null,
    hit: null, closing: false, liveness: null, exitWatched: onExit !== undefined,
  };
  // 收尾中也照收：`finish` 会先 drain 一次再推，进程死前最后几行不该因为「已经在停了」
  // 就丢掉。收尾时不另起定时器——那一批由 finish 自己同步推出去。
  //
  // 这一批行的归宿（入缓冲、排冲刷、还是空行快进）**整件事归消费层**:游标这一侧的不变量
  // 在那边（见 monitor-consume.ts 文件头 ④）,这里现场判一次时序就是第 3 轮审查 F1 那个洞。
  rt.tail = tailLines(row.logPath, row.offset, (lines, offset) => consumeTailChunk(rt, row.id, lines, offset));
  runtimes.set(row.id, rt);
  noteUnreadableCondition(row);

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
  await serialize(monitorId, async () => { await teardownRuntimeLocked(monitorId); });
}

/**
 * 撤运行时那几步的本体。**调用方必须已经在 `serialize(monitorId)` 里** —— 里面要把缓冲
 * 排出去,而推送一律在那条队列上(排第二遍就是等自己后面那一位,当场死锁)。
 *
 * **返回这一趟排干时读到的那条命中行**(没读到是 `null`，新一轮审查 N1)。撤之前的那次排干跟
 * 在线那条收尾读到的是同一份证据,而它跟着运行时一起被丢掉的话,拿这一趟当收尾的那个调用方
 * （`finishOffline`）就只能照「进程已经不在了」落终态 —— 审查实测:接回先 attach、排干已经把
 * `OFFLINE_READY` 送到任务、游标也推了,随后它看不到任何新行,状态落成 `lost`。
 * 「谁撤的运行时谁把证据接走」,所以它从返回值出去,不靠调用方自己去翻运行时。
 */
export async function teardownRuntimeLocked(monitorId: string): Promise<string | null> {
  const rt = runtimes.get(monitorId);
  if (!rt || rt.closing) return null;
  rt.closing = true;
  runtimes.delete(monitorId);
  for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
  if (rt.flush) clearTimeout(rt.flush);
  rt.tail.drain();
  rt.tail.stop();
  await flushBuffer(monitorId, rt).catch(() => {});
  // 排干时命中的那一行记在运行时上（见 monitor-consume.ts 的 `flushLocked`）—— 这一刻把它
  // 交出去,运行时随后就不存在了。
  return rt.hit;
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

// ── 停 ───────────────────────────────────────────────────────────────────────

// 收尾那一摊(收尾所有权、`finish`、后台收尾)住在 monitor-finish.ts(单文件 700 行的约定)。
// **公开面仍然从这里出**:消费层、停止、接回、回收都按 `monitors.js` 的这几个名字拿。
export { claimFinish, finish, finishInFlight, settleInBackground } from "./monitor-finish.js";

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
): Promise<{ lines: string[]; truncated: boolean; bytes: number | null } | null> {
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  if (!row) return null;
  // claude 那种没有日志文件：它的输出进了 agent 自己的会话，ash 这边一个字节都没有。
  // 返回空而不是读 `logPath`（空串）——后者会变成一次对仓库根目录的读取尝试。
  // `bytes: null` = 「这一刻答不出它有没有产出过」。claude 投影确实没有日志文件,这里答
  // `0` 会变成一句「它从头到尾什么都没写过」的断言,而那件事只有 agent 自己的会话知道。
  if (row.kind === "claude") return { lines: [], truncated: false, bytes: null };
  const limit = Math.min(MONITOR_TAIL_MAX_LINES, Math.max(1, Math.round(maxLines)));
  const tail = readLogTail(row.logPath, MONITOR_TAIL_MAX_BYTES);
  // 按行数再截一刀时 `bytes` 原样带着:它说的是文件有多大,跟这次给了几行无关。
  return tail.lines.length > limit
    ? { lines: tail.lines.slice(-limit), truncated: true, bytes: tail.bytes }
    : tail;
}

// ── 重启后认回来 ─────────────────────────────────────────────────────────────

// 离线收尾(进程已经不在了那一路)搬去了 monitor-offline-finish.ts(单文件 700 行的约定)。


// 接回那一摊搬去了 monitor-reattach.ts(单文件 700 行的约定)。**出口仍然只有这一个**:
// index.ts、测试台子和重启子进程都按 `monitors.js` 的这个名字拿它。
export { reattachMonitors } from "./monitor-reattach.js";
export { finishOffline } from "./monitor-offline-finish.js";
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
