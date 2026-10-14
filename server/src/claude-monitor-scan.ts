// 扫描层：从 agent 的 stdout 落盘文件里认出内置 Monitor，**可增量续读**。
//
// 为什么要增量：上一版缓存的是「这个任务扫过了」，没有任何版本依据。而这些文件是**活的**
// ——任务还在跑，stdout 一直在追加。于是正常运行中的任务第一次打开面板之后，后续追加的
// Monitor、以及已有 Monitor 的完成通知，同一个 server 进程里再也读不到（第 4 轮审查实测
// cachedSnapshot：空文件后追加 → rows=[]；先无会话后新增会话 → rows=[]；已扫过的文件追加
// completed → 卡片仍是 running）。
//
// 所以缓存的粒度改成**每个文件读到第几字节**：
// - `size > cursor.offset` → 从 offset 接着读，只读新增那一段
// - `size < cursor.offset` → 文件被重写或截断过，从头重读
// - 出现新会话 / 新文件 → 给它建一份新游标
// - 全部文件 size 都没变 → 这一轮不碰磁盘
//
// 顺带解决了 128 MiB 上限那条：超限不再是「永远只能读前缀」，而是这一轮读到上限为止、
// offset 停在那里，下次打开面板继续往后读。
//
// ── 按会话分区 ────────────────────────────────────────────────────────────────
//
// `pending`/`byToolUse` 的键是来源侧的 `tool_use_id` / 后台任务 id。上一版为了「跨文件关联
// 事件」把它们做成了**跨整个任务**共用，那是实现过头了：要跨的是同一条会话的多个 run 文件，
// 不是不同会话。实测 1017 条 task_started 里 `local_bash` 的 id 跨会话重复 0 个，但
// `local_agent` 那种出现过同 id 挂两个 tool_use 的情况 —— 来源侧并没有承诺全局唯一，所以
// 按会话分区（见 shared/monitor.ts 的 NATIVE_MONITOR_ID_SCOPE）。
import { open as openFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeMonitorStatus, parseMonitorStartReceipt, type MonitorLifetime } from "@ash/shared/monitor";
import { monitorStr as str, parseMonitorInput, type MonitorCall } from "./claude-monitors.js";
import { addCapped } from "./util.js";

/**
 * 单次调用的读取上限。超了这一轮就停在这儿，游标记着，下次接着读。
 *
 * `ASH_MONITOR_SCAN_MAX_BYTES` 只给回归用：128 MiB 的夹具没法写进测试里，而「多轮才读完
 * 一个固定输入、最终要收敛」恰恰是这条路最该钉住的性质（第 8 轮审查实测的不收敛就发生在
 * 截限 + 缓冲满这个组合上）。不设就是 128 MiB。
 */
const MAX_SCAN_BYTES = (() => {
  const raw = Number(process.env.ASH_MONITOR_SCAN_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 128 * 1024 * 1024;
})();
const CHUNK = 1 << 20;
/**
 * 孤儿事实（还配不上 Monitor 的回执/终态）各自最多缓冲这么多条，超了挤掉最老的。
 *
 * 为什么要有上限：缓冲的键来自来源侧，而**通知这一类不做 Monitor 过滤**（过滤发生在回溯
 * 应用时），所以普通后台 Bash 的终态也会进来——实测一个任务 76 条 task_started 里 64 条是
 * 它们。一条长会话跑下去没有任何上限，这张表就是一条慢速内存泄漏（第 6 轮审查不拦项）。
 *
 * 512 的依据：这些缓冲只用来跨「同一次扫描里的读取顺序差异」，实测同一轮里等着配对的最多
 * 几十条。
 *
 * **满了不是「挤掉最老的」，是背压**：缓冲里装的是一次性事实（来源侧不会重发）。挤掉它
 * 等于永久丢失；而「丢掉整个任务的游标、下一轮从零重读」又不收敛——输入没变就会再次顶满，
 * 于是永远读不到末尾（第 8 轮审查用 142MB 合法日志实测，真实页面 0 张卡）。
 *
 * 所以满了就**停在那一行之前**：游标不越过它，这一轮按「没读完」记账，下一轮从它重新开始。
 * 事实一条不丢，前缀也不会被反复重读。配合上面 `notMonitorTools`/`confirmedForeign` 把
 * 「确认不是 Monitor」的那一大类根本不放进来，正常日志压根碰不到这个边界。
 */
const ORPHAN_CAP = 512;
/**
 * 「这个 id 确认不是 Monitor」这类结论各自最多记这么多。
 *
 * 比孤儿缓冲宽得多，因为它正是用来**替代**缓冲的：一条长会话里普通后台 Bash 可以有成百
 * 上千个（实测 76 条 task_started 里 64 条是它们）。挤掉一条的代价也完全不同——结论可以
 * 重新推导（下一次那条通知再退回缓冲），而缓冲里装的是一次性事实。
 */
const FOREIGN_CAP = 4_096;

export type Found = {
  nativeId: string;
  call: MonitorCall;
  cliSessionId: string | null;
  /**
   * ── 起点是一个**区间**，不是一个时刻 ────────────────────────────────────────
   *
   * 历史文件里没有任何一条事件能直接给出「计时器什么时候起的」：
   * - `task_started` 是 system 事件，**不带 timestamp**（实测）。
   * - `tool_use` 那条 assistant 事件的时刻在计时器之前（工具还可能卡在权限确认上）。
   * - 起手回执那条事件的时刻在计时器之后：本机 claude 2.1.283 的源码里，到期 `setTimeout`
   *   在工具返回**前**就设好了，而回执消息要等 `for await` 跑完 PostToolUse hooks 之后才由
   *   `ke({…})` 构建，timestamp 取的是那一刻的 `new Date()`（第 5 轮审查从二进制提取，
   *   sha256 d8cb1e5c…；我也核过 formatter 吐的是配置的 `timeoutMs`，不是扣掉 hooks 之后的
   *   剩余时长）。
   *
   * 所以真实起点必然落在 `[startedAtLow, startedAtHigh]` 之间，**区间宽度就是不确定度**。
   * 上一版把上界当成「可信起点」，于是 hooks 一慢，到期时刻就跟着往后漂（审查实测延迟 20
   * 分钟时 expiresAt 晚了 1,200,000ms）。
   *
   * 实测这个区间通常很窄：本机 60 个真实 Monitor 回执，`tool_use` → 回执全部在 22~59ms。
   * 窄到可以忽略时才给精确到期时刻，宽了就只报时长（判据见 backfill 的 `startAnchorOf`）。
   */
  startedAtLow: string | null;
  startedAtHigh: string | null;
  /** 两个界都没有时的兜底显示值（run 文件名上的时刻）。只作显示，不参与期限计算。 */
  fileStartedAt: string | null;
  endedAt: string | null;
  lifetime: MonitorLifetime;
  expiresMs: number | null;
  status: string | null;
  endedReason: string | null;
  /** 它是在哪个 run 文件里起的。用来判「那一代 run 结束了没有」。 */
  filePath: string;
  /**
   * 它所在的 run 文件**不是**这条会话最新的那个 —— 也就是后来又起过新的一轮。
   *
   * 每个 run 文件对应一次 agent 进程启动（executors/detached.ts 的 `runPaths`），所以这是
   * 「起它的那一代进程已经退出」的确证。缺了它，历史投影只能退回「这条会话现在有没有活
   * 进程」，而那会被**下一回合的新进程**骗（第 4 轮审查实测 reusedSession）。
   *
   * 每轮扫完重算：新文件出现时，之前那些 Found 要跟着变成 stale。
   */
  staleRun: boolean;
};

/** 一条会话的扫描状态。跨它的全部 run 文件、跨多次增量调用存活。 */
type SessionScan = {
  /** tool_use_id → 入参 + 那条 assistant 事件的时刻（只作显示占位，见 Found.startedAt）。 */
  pending: Map<string, { call: MonitorCall; at: string | null }>;
  byToolUse: Map<string, string>;
  found: Map<string, Found>;
  cursors: Map<string, { size: number; offset: number }>;
  /**
   * **还关联不上任何 Monitor 的回执**（tool_use_id → 回执原文 + 那条事件的时刻）。
   *
   * 为什么必须留着而不是丢掉：事件的因果顺序和**读取顺序**不是一回事。前一个 run 文件撞到
   * 单次上限时，它尾部的 `task_started` 这一轮还没读到，而后一个 run 文件里那条回执已经被
   * 读完、游标也推进到尾了 —— 丢掉就等于永久丢掉（第 5 轮审查实测 crossFileLimit：第二轮
   * 读到了 started，回执和 completed 再也不会来，卡片永远停在 lost + unknown）。
   *
   * 所以改成缓冲：关联不上就先存着，等对应的 Monitor 在后续某一轮被读出来时回溯应用。
   */
  orphanReceipts: Map<string, { raw: string; at: string | null }>;
  /** 同理，还关联不上任何 Monitor 的终态通知（nativeId → 状态 + 说明 + 时刻）。 */
  orphanNotices: Map<string, { status: string; summary: string; at: string | null }>;
  /**
   * **已经确认不是 Monitor 起的**那些 tool_use / 后台任务 id。
   *
   * 「还没配上」和「确认跟我们无关」是两件事，上一版混成了一件：普通后台 Bash
   * （`run_in_background`）的 tool_use 块被直接丢掉，于是它的 `task_started`
   * 认不出来、它的终态通知只能进孤儿缓冲一直占着——而实测一个任务 76 条 task_started
   * 里 64 条是它们。513 条顺序完全正常的 Bash 生命周期就能把缓冲顶满，然后整个任务的
   * 游标被丢掉、下一轮从零重读、再次顶满，**永远读不到末尾那个真 Monitor**（第 8 轮
   * 审查用 142MB 合法日志实测，真实页面 0 张卡）。
   *
   * 记下这个结论之后，这类通知当场就能丢，根本不进缓冲。
   */
  notMonitorTools: Set<string>;
  confirmedForeign: Set<string>;
  /**
   * 最近见到的事件时刻。
   *
   * 只用来给**结束时刻**兜底：`task_notification` 是 system 事件，自己不带 timestamp，而
   * 它前后几行的 assistant/user 带（实测行距 5~20 行，秒级误差）。结束时刻不参与期限计算，
   * 这个精度够用，总比写「回填运行的这一刻」好——那可能是几天以后。
   *
   * **起始时刻不走这条**：那个只认起手回执那条事件的时刻，差一点都不行（见 Found.startedAt）。
   */
  lastAt: string | null;
};

/** 一个任务的扫描快照（进程内缓存）。 */
export type TaskScan = {
  sessions: Map<string, SessionScan>;
  /** 这一轮有文件读到了上限，还没读完。 */
  truncated: boolean;
  /** 这一轮有文件读失败。 */
  failed: boolean;
  /**
   * 还没配对的一次性事实被挤出了缓冲（见 `ORPHAN_CAP`）。
   *
   * 这一轮的读取结果因此**可能不全**：游标越过了那条事实，而它再也不会被重发。调用方要把
   * 快照丢掉、留账、重读那一段，不能当成普通缓存淘汰。
   */
  orphanOverflow: boolean;
  /** 文件里出现过的、与期望不符的 session_id（只作诊断）。 */
  foreign: Set<string>;
  /** 这一轮有没有读到新内容。 */
  advanced: boolean;
  /**
   * 这一轮有没有**代次**变化（某条 Found 的 `staleRun` 翻转了）。
   *
   * 字节 offset 不是「来源版本」的全部：新回合会先创建一个空的 run 文件、过一会儿才输出。
   * 那一刻没有任何新增字节，但「上一代已经结束」这件事已经成立。只看 `advanced` 就提交不了
   * 这个变化，旧监听会一直显示「正在盯着」（第 5 轮审查实测 emptyNewRun）。
   */
  generationChanged: boolean;
  /**
   * 上一份快照被内存上限挤掉时**停好的读取位置**（文件路径 → 游标）。
   *
   * 配对状态（`found`/孤儿缓冲）可以重建，读取位置不能丢——丢了就从零重读，而单次只读
   * 128 MiB，「Monitor 在末尾」的大任务永远读不到它（见 claude-monitor-backfill.ts 的
   * `parked`）。新建会话桶时从这里取。
   */
  parkedCursors: Map<string, { size: number; offset: number }> | null;
};

export const newTaskScan = (): TaskScan => ({
  sessions: new Map(), truncated: false, failed: false, foreign: new Set(),
  advanced: false, generationChanged: false, orphanOverflow: false, parkedCursors: null,
});

const newSessionScan = (): SessionScan => ({
  pending: new Map(), byToolUse: new Map(), found: new Map(), cursors: new Map(),
  orphanReceipts: new Map(), orphanNotices: new Map(), lastAt: null,
  notMonitorTools: new Set(), confirmedForeign: new Set(),
});

/**
 * 一条会话**全部**的 stdout 文件，按时间排好。
 *
 * `sessions.agent_out_path` 只记着最后一次 run 的那一个（每回合覆盖），而内置 Monitor 多半
 * 起在中间某一轮 —— 实测用户那个任务字段指向第 6 个文件，12 个 Monitor 全在前 5 个里。
 * 落盘约定是 `<sessionId>-<时间戳>.agent-out.jsonl`（executors/detached.ts 的 `runPaths`），
 * 所以**拿 `sessions.id` 当前缀**，不从文件名去猜（会话 id 是可含 `-` 的 nanoid）。
 */
export async function streamFilesOf(
  sessionId: string, outPath: string,
): Promise<{ path: string; startedAt: string | null }[]> {
  const dir = dirname(outPath);
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return [{ path: outPath, startedAt: null }]; }
  const files = entries
    .filter((f) => f.startsWith(`${sessionId}-`) && f.endsWith(".agent-out.jsonl"))
    .sort()
    .map((f) => ({ path: join(dir, f), startedAt: timestampOf(f) }));
  return files.length ? files : [{ path: outPath, startedAt: null }];
}

/** 从 `<id>-20261014T063919165Z.agent-out.jsonl` 里把那个时间戳还原成 ISO。认不出就 null。 */
export function timestampOf(fileName: string): string | null {
  const m = /-(\d{8})T(\d{6})(\d{3})Z\./.exec(fileName);
  if (!m) return null;
  const [, date, time, ms] = m;
  const iso = `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6, 8)}T`
    + `${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4, 6)}.${ms}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * 从 `start` 读到文件尾（或读满 `maxBytes`），逐行回调，返回新游标。
 *
 * **游标只停在完整行的边界上。** 按字节续读时，上一轮很可能正好停在某一行中间（文件还在被
 * 追加）。从半行开始解析会把那条事件整条丢掉，所以残留的不完整尾巴不消费，下次从它的起点
 * 重读。
 */
async function eachLine(
  path: string, start: number, maxBytes: number,
  /** 返回 false = **这一行没消费掉**，就停在它前面（游标不越过它）。 */
  onLine: (line: string) => boolean,
): Promise<{ nextOffset: number; truncated: boolean; stopped: boolean }> {
  const fh = await openFile(path, "r");
  try {
    let offset = start;
    let carry = Buffer.alloc(0);
    while (offset - start < maxBytes) {
      const want = Math.min(CHUNK, maxBytes - (offset - start));
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (!bytesRead) break;
      // data[0] 在文件里的绝对位置：carry 来自上一轮、在 offset 之前。
      const base = offset - carry.length;
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, from);
        if (nl < 0) break;
        const lineStart = from;
        const keepGoing = onLine(data.subarray(from, nl).toString("utf8"));
        // **消费不了就把游标停在这一行之前**，下一轮从它重新开始。越过去就等于丢掉一条
        // 来源不会重发的事实（见 ORPHAN_CAP 的背压说明）。
        if (!keepGoing) return { nextOffset: base + lineStart, truncated: false, stopped: true };
        from = nl + 1;
      }
      carry = Buffer.from(data.subarray(from)); // 复制：data 可能指向复用的 buf
      offset += bytesRead;
    }
    return {
      nextOffset: offset - carry.length,
      truncated: offset - start >= maxBytes,
      stopped: false,
    };
  } finally {
    await fh.close();
  }
}

/** 事件自报的时刻。只有 `assistant` / `user` 带（`system` 不带，实测）。 */
function eventTime(ev: any): string | null {
  const t = typeof ev?.timestamp === "string" ? ev.timestamp : "";
  return t && !Number.isNaN(Date.parse(t)) ? t : null;
}

/**
 * 把一条会话的全部文件扫一遍（只读新增部分），结果并进 `scan`。
 *
 * 判据与实时投影同一套：`task_started` 的 `tool_use_id` 回指发起它的工具名，只有 `Monitor`
 * 算数 —— 普通后台 Bash（`run_in_background`）同样是 `local_bash`，混进来会把面板变成一份
 * 「这个任务跑过的所有后台命令」流水账（实测 76 条里 64 条是它们）。
 */
export async function scanSession(
  scan: TaskScan, sessionId: string, cliSessionId: string | null, outPath: string,
  /** 单次读取上限。只有回归测试会传小值——128 MiB 的夹具没法写进测试里。 */
  maxBytes: number = MAX_SCAN_BYTES,
): Promise<void> {
  let session = scan.sessions.get(sessionId);
  if (!session) {
    session = newSessionScan();
    // 继承停好的读取位置（见 TaskScan.parkedCursors）。路径唯一，所以整张表倒进来即可，
    // 这条会话只会去读属于它自己的那几个文件。
    if (scan.parkedCursors) {
      for (const [path, cursor] of scan.parkedCursors) session.cursors.set(path, { ...cursor });
    }
    scan.sessions.set(sessionId, session);
  }
  const files = await streamFilesOf(sessionId, outPath);
  // **按时间顺序读，前一个没读完就不读后面的。**
  //
  // 这些文件之间有因果关系：Monitor 在前一个 run 文件里起（tool_use/task_started），它的
  // 回执和终态可能落在后一个 run 文件里。乱序消费的后果是后文件的事实关联不上任何 Monitor
  // ——而它的游标已经推到尾，那些事实再也不会被读一次（第 5 轮审查实测 crossFileLimit：
  // 前文件超 128 MiB 上限，后文件的 90 秒回执和 completed 当轮被读完并丢弃，此后三次回填都
  // 恢复不出 exited + bounded）。
  //
  // 孤儿缓冲（`orphanReceipts`/`orphanNotices`）是第二道：同一文件内部的乱序、以及这一轮之前
  // 已经被旧代码消费掉的情况，靠它兜住。两道都要有——顺序保证「别制造孤儿」，缓冲保证
  // 「已经产生的孤儿不丢」。
  let blocked = false;
  for (const file of files) {
    if (blocked) break;
    let size = 0;
    try {
      size = (await stat(file.path)).size;
    } catch {
      // stat 失败和撞上限是同一类「这个文件没读完」，后面的文件同样不能先读。
      scan.failed = true;
      blocked = true;
      continue;
    }
    const cursor = session.cursors.get(file.path) ?? { size: 0, offset: 0 };
    // 文件比上次短 = 被重写/截断过，之前的游标无意义，从头再来。
    if (size < cursor.offset) { cursor.offset = 0; cursor.size = 0; }
    // **判据是「读到文件尾了没有」，不是「文件有没有变大」。** 写成 `size === cursor.size`
    // 会在撞到单次上限之后卡死：文件大小没变、游标还停在半路，于是后半截永远读不到
    // （本轮自测：第 1 轮 offset=99134/409154 truncated=true，第 2 轮仍是 99134 就停了）。
    // 空文件也走这一支（0 >= 0），它本来就没东西可读。
    if (cursor.offset >= size) {
      session.cursors.set(file.path, { size, offset: cursor.offset });
      continue;
    }

    const sink = (line: string) => consume(scan, session!, line, cliSessionId, file.startedAt, file.path);
    try {
      const { nextOffset, truncated, stopped } = await eachLine(file.path, cursor.offset, maxBytes, sink);
      if (nextOffset > cursor.offset) scan.advanced = true;
      if (truncated) { scan.truncated = true; blocked = true; }
      // 背压停下来了：游标停在那条还没消费的事实之前，这一轮和后面的文件都不算读完。
      if (stopped) { scan.orphanOverflow = true; blocked = true; }
      session.cursors.set(file.path, { size, offset: nextOffset });
      // 这个文件还没读到尾（撞上限）也算没读完——下一轮从游标接着读，后面的文件继续等。
      if (nextOffset < size) blocked = true;
    } catch (e) {
      scan.failed = true;
      blocked = true;
      console.warn(`[ash] 内置 Monitor 历史扫描读失败（${file.path}）:`, e);
    }
  }
  // **每轮重算**：新文件出现之后，之前那些 Found 的「那一代还在跑吗」答案会翻转。
  // 翻转本身就是一条要提交的事实，哪怕这一轮一个新字节都没读到（见 TaskScan.generationChanged）。
  const latest = files.length ? files[files.length - 1]!.path : "";
  for (const row of session.found.values()) {
    const stale = !!latest && row.filePath !== latest;
    if (stale !== row.staleRun) scan.generationChanged = true;
    row.staleRun = stale;
  }
}

/**
 * 这条新事实放不进去了吗（满了、而且它还不在里面）。
 *
 * 已经在里面的那条照旧覆盖——它不是新事实，重读同一行时会走到这里。
 */
const full = (buffer: Map<string, unknown>, key: string): boolean =>
  buffer.size >= ORPHAN_CAP && !buffer.has(key);

/** 一行 stream-json。认人判据见 `scanSession` 的说明。 */
function consume(
  scan: TaskScan, session: SessionScan, line: string,
  expectSessionId: string | null, fileStartedAt: string | null, filePath: string,
): boolean {
  const text = line.trim();
  if (!text || text[0] !== "{") return true;
  let ev: any;
  try { ev = JSON.parse(text); } catch { return true; }
  if (ev.type === "stream_event") return true;
  const at = eventTime(ev);
  if (at) session.lastAt = at;

  // 会话身份核对：对不上只记一笔诊断，**不丢数据**。resume 之后 CLI 会换 session_id，而
  // 文件名前缀已经保证了「这些文件属于这条 ash 会话」。
  const evSession = str(ev.session_id) || null;
  if (evSession && expectSessionId && evSession !== expectSessionId) scan.foreign.add(evSession);

  const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use" && str(block.name) === "Monitor") {
      const call = parseMonitorInput(block.input);
      if (call && str(block.id)) session.pending.set(str(block.id), { call, at });
    } else if (block.type === "tool_use" && str(block.name)) {
      // **不是 Monitor 这个结论也要留下来**（见 notMonitorTools）：丢掉它，这个工具起的
      // 后台任务就只能当成「还没配上的事实」一直占着孤儿缓冲。
      if (str(block.id)) addCapped(session.notMonitorTools, str(block.id), FOREIGN_CAP);
    } else if (block.type === "tool_result") {
      const toolUseId = str(block.tool_use_id);
      const raw = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
      const nativeId = session.byToolUse.get(toolUseId);
      const row = nativeId ? session.found.get(nativeId) : undefined;
      if (!row) {
        // 还不知道这条回执属于谁（它的 task_started 在某个还没读完的前文件里）。
        // **缓冲，不丢。** 等那条 Monitor 被读出来时回溯应用（见 orphanReceipts）。
        if (toolUseId && /Monitor started/i.test(raw)) {
          // 不是 Monitor 起的那些工具回执连进来的机会都没有（上面的分支已经把它们记成
          // notMonitorTools），所以这里满了就是真的乱序事实太多 → 背压。
          if (full(session.orphanReceipts, toolUseId)) return false;
          session.orphanReceipts.set(toolUseId, { raw, at });
        }
        continue;
      }
      applyReceipt(row, raw, at);
    }
  }

  if (ev.type !== "system") return true;
  const nativeId = str(ev.task_id);
  if (ev.subtype === "task_started") {
    const started = session.pending.get(str(ev.tool_use_id));
    if (!started || !nativeId) {
      // 起它的那个 tool_use 我们见过、而且确认不是 Monitor → 把这个后台任务 id 也记成
      // 「与我们无关」，它后面的通知就不必再进孤儿缓冲了。
      if (nativeId && session.notMonitorTools.has(str(ev.tool_use_id))) {
        addCapped(session.confirmedForeign, nativeId, FOREIGN_CAP);
      }
      return true;
    }
    session.pending.delete(str(ev.tool_use_id));
    session.byToolUse.set(str(ev.tool_use_id), nativeId);
    session.found.set(nativeId, {
      nativeId, call: started.call,
      cliSessionId: evSession ?? expectSessionId,
      startedAtLow: started.at,
      startedAtHigh: null,   // 回执到了才有上界
      fileStartedAt,
      endedAt: null,
      lifetime: "unknown", expiresMs: null,
      status: null, endedReason: null,
      filePath, staleRun: false,
    });
    // **回溯**：这条 Monitor 的回执/终态可能早就被读过了（后一个 run 文件先读完的情况）。
    const row = session.found.get(nativeId)!;
    const pendingReceipt = session.orphanReceipts.get(str(ev.tool_use_id));
    if (pendingReceipt) {
      applyReceipt(row, pendingReceipt.raw, pendingReceipt.at);
      session.orphanReceipts.delete(str(ev.tool_use_id));
    }
    const pendingNotice = session.orphanNotices.get(nativeId);
    if (pendingNotice) {
      applyNotice(row, pendingNotice.status, pendingNotice.summary, pendingNotice.at);
      session.orphanNotices.delete(nativeId);
    }
  } else if (ev.subtype === "task_notification" && nativeId) {
    const row = session.found.get(nativeId);
    if (!row) {
      // **已经确认与我们无关的，当场丢**（普通后台 Bash 的终态）。只有「可能是 Monitor、
      // 只是它的 task_started 还在某个没读完的前文件里」才需要缓冲。
      if (session.confirmedForeign.has(nativeId)) return true;
      if (full(session.orphanNotices, nativeId)) return false; // 背压，见 ORPHAN_CAP
      session.orphanNotices.set(nativeId, {
        status: claudeMonitorStatus(ev.status), summary: str(ev.summary), at: session.lastAt,
      });
      return true;
    }
    applyNotice(row, claudeMonitorStatus(ev.status), str(ev.summary), session.lastAt);
  }
  return true;
}

/** 把一条起手回执落到 Found 上。来源侧唯一说出**生效**期限的地方。 */
function applyReceipt(row: Found, raw: string, at: string | null): void {
  const receipt = parseMonitorStartReceipt(raw);
  if (receipt.lifetime === "unknown") return;
  row.lifetime = receipt.lifetime;
  row.expiresMs = receipt.ms;
  // 回执那条事件的时刻是真实起点的**上界**：计时器在工具返回前就起了，而这条消息要等
  // PostToolUse hooks 跑完才构建（见 Found.startedAtHigh 的说明）。
  row.startedAtHigh = at;
}

/** 把一条终态通知落到 Found 上。 */
function applyNotice(row: Found, status: string, summary: string, at: string | null): void {
  row.status = status;
  row.endedReason = summary || null;
  row.endedAt = at ?? row.endedAt;
}

/** 这一轮扫出来的全部结果（跨会话合并，键仍按会话分区保证不互相覆盖）。 */
export function foundOf(scan: TaskScan): Found[] {
  const all: Found[] = [];
  for (const session of scan.sessions.values()) all.push(...session.found.values());
  return all;
}
