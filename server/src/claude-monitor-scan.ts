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
//
// ── 检查点：位置 + 已提交的行，两样合起来才算「读到哪儿」──────────────────────────
//
// 内存里的配对状态会被内存上限丢掉（backfill 的 `SNAPSHOT_HARD_CAP`），只剩「读到第几字节」。
// 于是有一条必须自己守住的不变量：
//
//   **绝不从某个位置开始读，除非它之前的内容都「有归宿」** —— 要么这一代读过（还在内存里），
//   要么已经成行落库（已提交）。
//
// 谁守：落盘的位置只会是上一轮**确认提交过**的那个（backfill 的 `saveCheckpoint`），其余情况
// 一律从 0 重读；而「位置之前那条还悬着的调用」不靠位置来保，它也落盘
// （`claude-monitor-pending.ts`）。两样都在库里，于是「读到哪儿」这件事不依赖任何缓存命中。
//
// 上一版是靠位置保的 —— 可重放位置绝不越过一条悬着的调用。那条路在**永远不会完结的调用**上
// 失效：启动被拒（有 `is_error` 回执、没有 `task_started`）、进程在那一行之后被杀（连回执都
// 没有），于是位置被永久钉在那儿，每轮重读同一个窗口，末尾的 Monitor 永远读不到（第 11 轮
// 审查实测 12 轮停滞）。落盘之后位置只管单调往前，两件事各归各管。
//
// 这条不变量值钱，是因为来源侧的行序是**严格因果**的（实测用户那个任务的 17 个 run 文件：
// `tool_use` → `task_started` 84/84 顺序、`task_started` → `tool_result` 12/12、
// `task_started` → 通知 84/84，一例逆序都没有），所以**配不上的一次性事实，它的另一半必然
// 在它之前**。既然它之前的内容都有归宿，这条事实当轮就能裁决：
//
//   - 库里有那一行 → 按 `native_id` / `tool_use_id` 配回去（claude-monitor-commit.ts）
//   - 库里也没有   → 它压根不是 Monitor 起的（普通后台 Bash 的通知，实测 76 条 task_started
//                    里 64 条是它们），当场丢掉
//
// 所以这里**不再维护「这个 id 不是 Monitor」这类结论集合、也不再长期缓冲孤儿事实**：结论可以
// 从「库里有没有这一行」重新推出来，而那两样都是会被容量淘汰的内存状态 —— 淘汰之后通知退成
// 孤儿、把可重放位置永久钉死在那儿，固定输入于是永远读不完（第 10 轮审查实测：连续 24 轮硬
// 淘汰，读取窗口一动不动，末尾那个 Monitor 始终缺卡）。
import { stat } from "node:fs/promises";
import { claudeMonitorStatus, parseMonitorStartReceipt, type MonitorLifetime } from "@ash/shared/monitor";
import { monitorStr as str, parseMonitorInput, type MonitorCall } from "./claude-monitors.js";
import type { ClearedCall, PendingCall } from "./claude-monitor-pending.js";
import type { ScanCursor } from "./claude-monitor-cursors.js";
import { eachLine, scanWindowBytes, streamFilesOf } from "./claude-monitor-read.js";

/**
 * 一轮里最多交出去多少条「配不上内存状态」的事实（见 `SessionScan.late`）。
 *
 * **不是缓存上限，是单轮工作量上限**：这些事实当轮就会被提交层裁决掉（配回已提交的行、或者
 * 证明与我们无关），不需要跨轮留着。顶到上限就**停在那一行之前**：游标不越过它，这一轮按
 * 「没读完」记账，下一轮从它继续 —— 事实一条不丢，前缀也不重读。
 *
 * 512 的依据：实测一个任务 76 条 `task_started` 里 64 条是普通后台 Bash，它们的终态通知全走
 * 这条通道；真撞上就是分几批补完，不影响收敛。
 */
const LATE_CAP = 512;

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
  /**
   * 起它的那个 tool_use id。
   *
   * 落到行上去（`monitors.tool_use_id`）：内存里的 `byToolUse` 在内存上限下会丢，丢了之后
   * 后缀里的起手回执就配不上任何东西——而库里那一行记着它就能配上（见
   * claude-monitor-commit.ts 的「检查点的两半」）。
   */
  toolUseId: string;
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
  /**
   * tool_use_id → 入参 + 那条 assistant 事件的时刻（起点区间的下界，见 Found.startedAtLow）。
   *
   * 入参只存在于 `tool_use` 那一行，而身份要等 `task_started` 才有，所以这段「悬着」的状态
   * 必须活过读取窗口和内存上限 —— 它**落盘**（`claude-monitor-pending.ts`），新建会话桶时
   * 从那里恢复。读取位置不再为它让路。
   */
  pending: Map<string, { call: MonitorCall; at: string | null; sourceRun: string | null }>;
  byToolUse: Map<string, string>;
  found: Map<string, Found>;
  /** 每个文件读到第几字节（外加边界搜索进度与缺口证据，见 `ScanCursor`）。 */
  cursors: Map<string, ScanCursor>;
  /**
   * 这一轮**完结掉**的调用：配上了 `task_started`（成了 `found` 里的一行），或者确证起不来。
   *
   * 提交确认之后交给 `claude-monitor-pending.ts` 销账。留在这儿而不是当场写库，是因为
   * 「写库」这件事只有在**这一轮的事实确认落地**之后才算成立（见 `committedThrough`）。
   */
  cleared: ClearedCall[];
  /**
   * 这一轮读到、却配不上内存状态的一次性事实（见文件头的检查点说明）。
   *
   * 不是缓冲：它们当轮交给提交层裁决（配回已提交的行，或证明与我们无关），裁完就清空，所以
   * 既不长期占内存、也不会把可重放位置钉住。
   */
  late: LateFact[];
  /**
   * 这一代扫描**跳过过前缀**吗（从停好的位置接着读，而不是从 0 读起）。
   *
   * 只用在一个地方：起手回执配不上任何行、而库里又有没记 `tool_use_id` 的存量行时，到底该
   * 「回头重放一遍」还是「断定它与我们无关」。跳过过前缀就值得重放（那一遍会把存量行的
   * `tool_use_id` 补上）；没跳过就说明这一代已经把它之前的内容都读过了，再读一遍还是这个
   * 结果 —— 那时必须断定并丢掉，否则就是无限重读（见 claude-monitor-backfill.ts 的销账）。
   */
  skippedPrefix: boolean;
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
   * 这一轮要交出去的迟到事实顶到了单轮上限（见 `LATE_CAP`）。
   *
   * 游标停在那一条之前，所以**事实一条没丢**，只是这一轮没读完：调用方留账、下一轮从它继续。
   */
  lateOverflow: boolean;
  /**
   * 这一轮有文件的末尾是**半行**（没有换行符）。
   *
   * 多半是正在被追加，下一轮就完整了；但已经结束的文件里这半行是永久的，而它可能正是最后
   * 一条完成通知。两种都不许当成「读完了」——留账、按退避再读（第 13 轮审查 N3）。
   */
  partialTail: boolean;
  /**
   * 这一轮跳过了一条**比读取窗口还长**的记录（见 claude-monitor-read.ts）。
   *
   * 跳是必须的（不跳就零进展、整个文件之后的内容都读不到），但跳掉的那条里可能带着 Monitor
   * 的入参或回执。缺口要说出来，不能静悄悄按「这一轮读全了」收尾。
   *
   * **它不是「这一轮」的标志位**：缺口的证据跟着游标落盘（`ScanCursor.gapFrom/gapNeed`），
   * 只要还没弥补，之后每一轮都照样置起来。否则跳过的下一轮一干净，提示就没了，而那条事实
   * 永远没回来 —— 面板上是一张永远 `lost` 的卡，却写着「都读全了」（第 14 轮审查 N1 实测）。
   */
  skippedRecord: boolean;
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
   * **这份扫描状态消费过的内容，都已经确认落库了吗**（检查点的另一半，见文件头）。
   *
   * 只有它成立时，`checkpointCursors` 才可以把读取位置停在半路；否则位置之前那段既不在内存里、
   * 也不在库里，从它往后读就再也拼不回来。读到新字节时置 false，提交确认后由
   * claude-monitor-backfill.ts 置回 true。
   */
  committedThrough: boolean;
  /**
   * 这一轮看到的 run 文件：`all` = 全部，`latest` = 每条会话最新的那个。
   *
   * 「起它的那一代 run 结束了没有」这个结论必须在 `found` 已被淘汰时也算得出来，所以它由
   * **文件清单 + 行上的 `source_run`** 现算（见 claude-monitor-backfill.ts 的
   * `reconcileLiveness`），而不是只靠内存里的那些 Found —— 后者被挤掉之后，新回合的空 run
   * 文件一出现，旧监听反而会被当前会话的新进程证明成「还在盯着」（第 10 轮审查实测）。
   */
  runFiles: { all: Set<string>; latest: Set<string> };
  /**
   * 从库里接回来的**读取位置**（文件路径 → 游标，见 `claude-monitor-cursors.ts`）。
   *
   * 配对状态（`found`/迟到事实通道）可以重建，读取位置不能丢——丢了就从零重读，而单次只读
   * 128 MiB，「Monitor 在末尾」的大任务永远读不到它。所以它不跟着任何内存缓存一起生灭
   * （第 13 轮审查：内存表总有上限，上限一到挤掉的可能正是那个还没读完的任务）。
   * 新建会话桶时从这里取。
   */
  restoredCursors: Map<string, ScanCursor> | null;
  /**
   * 落盘的未决调用（见 `claude-monitor-pending.ts`），按 ash 会话分桶。
   *
   * 新建会话桶时倒进 `pending`：读取窗口切在 `tool_use` 和 `task_started` 之间、或者配对状态
   * 被内存上限挤掉时，靠它把那条悬着的调用接回来，而不是靠把读取位置退回那一行。
   */
  restoredPending: Map<string, PendingCall[]> | null;
};

export const newTaskScan = (): TaskScan => ({
  sessions: new Map(), truncated: false, failed: false, foreign: new Set(),
  advanced: false, generationChanged: false, lateOverflow: false, restoredCursors: null,
  partialTail: false, skippedRecord: false,
  restoredPending: null,
  committedThrough: true, runFiles: { all: new Set(), latest: new Set() },
});

const newSessionScan = (): SessionScan => ({
  pending: new Map(), byToolUse: new Map(), found: new Map(), cursors: new Map(),
  cleared: [], late: [], skippedPrefix: false, lastAt: null,
});

/**
 * 这份扫描状态**读到哪儿了**（文件 → 游标），交给落盘层记下来。
 *
 * 位置照原样往前、不往回退：位置之前那段里**唯一**只存在于内存的东西是悬着的调用，而它已经
 * 落盘了（见文件头）。上一版退到「最后一个没有悬着关联的位置」，于是一条永远不会完结的调用
 * 就把位置钉死，固定输入每轮重读同一个窗口（第 11 轮审查实测）。
 */
export function cursorsOf(scan: TaskScan): Map<string, ScanCursor> {
  const out = new Map<string, ScanCursor>();
  // **先铺上还没惰性接进来的那些。** 会话桶是读到那个文件时才建的（见 `scanSession`），所以
  // 一份刚接过位置、还没读到任何文件的快照，`sessions` 是空的 —— 只看 `sessions` 就等于把上
  // 一次确认过的位置扔掉（第 12 轮审查 F1：并发淘汰下每轮都从零重读）。
  for (const [path, cursor] of scan.restoredCursors ?? []) out.set(path, { ...cursor });
  // 读过的覆盖上去：桶里那份是从 `restoredCursors` 接的，只会更靠后（见 `scanSession`）。
  for (const session of scan.sessions.values()) {
    for (const [path, cursor] of session.cursors) out.set(path, { ...cursor });
  }
  return out;
}

/** 这一轮还悬着的调用（落盘用，见 `claude-monitor-pending.ts`）。 */
export function pendingCallsOf(scan: TaskScan): PendingCall[] {
  const out: PendingCall[] = [];
  for (const [sessionKey, session] of scan.sessions) {
    for (const [toolUseId, item] of session.pending) {
      out.push({ sessionKey, toolUseId, call: item.call, at: item.at, sourceRun: item.sourceRun });
    }
  }
  return out;
}

/** 这一轮完结掉的调用（销账用，见 `SessionScan.cleared`）。 */
export function clearedCallsOf(scan: TaskScan): ClearedCall[] {
  return [...scan.sessions].flatMap(([, session]) => session.cleared);
}

/** 销账落地之后清空账页（没落地就留着，下一轮再销一次）。 */
export function clearPendingLedger(scan: TaskScan): void {
  for (const session of scan.sessions.values()) session.cleared.length = 0;
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
  maxBytes: number = scanWindowBytes(),
  /**
   * 这条会话**现在还有活着的 agent 进程**吗（见 TaskScan.partialTail）。
   *
   * 只影响「文件尾是半行」怎么记：活着的那条正在被追加,半行下一刻就完整了,记成「没读完」
   * 会让退避定时器每秒重扫一个还在写的文件,而且每轮都读到新字节、预算永远清零。缺省按
   * **不活**算(更保守:宁可多留一次账)。
   */
  sessionLive = false,
): Promise<void> {
  let session = scan.sessions.get(sessionId);
  if (!session) {
    session = newSessionScan();
    scan.sessions.set(sessionId, session);
    // 悬着的调用从库里接回来（见 TaskScan.restoredPending）：读取窗口切在 `tool_use` 和
    // `task_started` 之间、或者上一份快照被内存上限挤掉时，靠这一步续上，位置不必回退。
    for (const item of scan.restoredPending?.get(sessionId) ?? []) {
      session.pending.set(item.toolUseId, { call: item.call, at: item.at, sourceRun: item.sourceRun });
    }
  }
  const files = await streamFilesOf(sessionId, outPath);
  // 文件清单本身就是「代次」这件事的权威依据（见 TaskScan.runFiles）：它和行上的 `source_run`
  // 一起，让「起它的那一代 run 结束了没有」在配对状态被淘汰之后仍然算得出来。
  for (const file of files) scan.runFiles.all.add(file.path);
  if (files.length) scan.runFiles.latest.add(files[files.length - 1]!.path);
  // **按时间顺序读，前一个没读完就不读后面的。**
  //
  // 这些文件之间有因果关系：Monitor 在前一个 run 文件里起（tool_use/task_started），它的
  // 回执和终态可能落在后一个 run 文件里。乱序消费的后果是后文件的事实关联不上任何 Monitor
  // ——而它的游标已经推到尾，那些事实再也不会被读一次（第 5 轮审查实测 crossFileLimit：
  // 前文件超 128 MiB 上限，后文件的 90 秒回执和 completed 当轮被读完并丢弃，此后三次回填都
  // 恢复不出 exited + bounded）。
  //
  // 迟到事实（`session.late`）是第二道：同一文件内部的乱序、以及这一轮之前已经被消费掉的
  // 情况，靠它兜住。两道都要有——顺序保证「别制造迟到事实」，`late` 保证「已经产生的那些
  // 在提交时当场裁决掉」（见文件头的检查点不变量）。
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
    // 接回来的位置**惰性取**：那张表是这个任务全部会话文件的并集，整张倒进每条会话的桶里
    // 就按会话数把它复制了一遍（第 9 轮审查不拦项 4）。路径本来就唯一，按需查即可。
    //
    // 采纳它是安全的：落盘的只会是「可重放 + 已确认提交」的位置（backfill 的 saveCheckpoint），
    // 所以它之前的内容都有归宿（见文件头的检查点不变量）。
    const restored = scan.restoredCursors?.get(file.path);
    if (restored && !session.cursors.has(file.path)) {
      session.cursors.set(file.path, { ...restored });
      if (restored.offset > 0) session.skippedPrefix = true;  // 见 SessionScan.skippedPrefix
    }
    const cursor: ScanCursor = session.cursors.get(file.path)
      ?? { size: 0, offset: 0, probe: 0, gapFrom: 0, gapNeed: 0 };
    // 文件比上次短 = 被重写/截断过，之前的游标无意义，从头再来（缺口证据也跟着作废：它说的
    // 是旧内容里的某一段，新内容里没有对应的东西）。
    if (size < cursor.offset) {
      cursor.offset = 0; cursor.size = 0; cursor.probe = 0; cursor.gapFrom = 0; cursor.gapNeed = 0;
    }
    // ── 永久缺口：**窗口够大的那一轮回去补，补不了就一直留着账** ────────────────
    //
    // 跳过一条装不进窗口的记录之后，那条事实只剩这份证据了。它跟着游标落盘，所以下一轮
    // 干净扫描清不掉它（第 14 轮审查 N1：实测跳过的是一条完成通知，第 3 轮起账面干净，
    // 而那张卡永远停在 `lost`）。读取窗口是可配的（生产 128 MiB，回归 32 KiB），哪一轮
    // 的窗口装得下它，就把位置退回去重读一遍——重读是幂等的（按 native_id/tool_use_id 配回）。
    if (cursor.gapNeed) {
      if (maxBytes >= cursor.gapNeed && cursor.gapFrom < size) {
        cursor.offset = cursor.gapFrom;
        cursor.probe = 0; cursor.gapFrom = 0; cursor.gapNeed = 0;
        console.warn(`[ash] 内置 Monitor 历史扫描回去补上一条之前跳过的记录`
          + `（${file.path} 第 ${cursor.offset} 字节起，当前窗口 ${maxBytes}）`);
      } else {
        scan.skippedRecord = true;
      }
    }
    // **判据是「读到文件尾了没有」，不是「文件有没有变大」。** 写成 `size === cursor.size`
    // 会在撞到单次上限之后卡死：文件大小没变、游标还停在半路，于是后半截永远读不到
    // （本轮自测：第 1 轮 offset=99134/409154 truncated=true，第 2 轮仍是 99134 就停了）。
    // 空文件也走这一支（0 >= 0），它本来就没东西可读。
    if (cursor.offset >= size) {
      session.cursors.set(file.path, { ...cursor, size });
      continue;
    }

    const sink = (line: string) =>
      consume(scan, session!, line, cliSessionId, file.startedAt, file.path, sessionId);
    /** 这个文件**还在被写**吗：只有活着的会话的最后一个 run 文件算（见下面的半行判据）。 */
    const fileLive = sessionLive && file.path === files[files.length - 1]!.path;
    try {
      const readFrom = cursor.offset;
      const { nextOffset, truncated, stopped, skipped, tail, probe } =
        await eachLine(file.path, readFrom, maxBytes, sink, cursor.probe);
      cursor.probe = probe;
      if (skipped) {
        // 缺口落在游标上一起落盘（上面那一段负责把它补回来）。
        cursor.gapFrom = readFrom;
        cursor.gapNeed = skipped;
        scan.skippedRecord = true;
        console.warn(`[ash] 内置 Monitor 历史扫描跳过一条装不进读取窗口的记录`
          + `（${file.path} 第 ${readFrom} 字节起 ${skipped} 字节 > 上限 ${maxBytes}）`);
      }
      // 末尾那截没有换行符：这一轮没把这个文件读全（见 TaskScan.partialTail）。正在被写的
      // 那个文件里这是常态、不记账；**封存的文件里这半行是永久的**，必须留账。
      //
      // 判据按 run 文件给，不是整条会话：会话活着只说明**最后那个** run 文件还在被追加，
      // 之前那些早就封存了。用会话存活代替文件封存的话，旧文件的半行会照样把后面的文件挡住
      // （下面 `nextOffset < size` 那一支），账上却什么都没有 —— 停滞且无声（第 14 轮审查 N1）。
      if (tail && !fileLive) { scan.partialTail = true; blocked = true; }
      if (nextOffset > cursor.offset) {
        scan.advanced = true;
        // 读到了新字节 ⇒ 这些事实还没确认落库，位置暂时不许停在半路（见 committedThrough）。
        scan.committedThrough = false;
      }
      if (truncated) { scan.truncated = true; blocked = true; }
      // 背压停下来了：游标停在那条还没消费的事实之前，这一轮和后面的文件都不算读完。
      if (stopped) { scan.lateOverflow = true; blocked = true; }
      session.cursors.set(file.path, { ...cursor, size, offset: nextOffset });
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

/** 这一轮交出去的迟到事实已经顶到单轮上限了吗（见 `LATE_CAP`，满了就背压）。 */
const lateFull = (session: SessionScan): boolean => session.late.length >= LATE_CAP;

/** 一行 stream-json。认人判据见 `scanSession` 的说明。 */
function consume(
  scan: TaskScan, session: SessionScan, line: string,
  expectSessionId: string | null, fileStartedAt: string | null, filePath: string,
  /** 读到它的那条 ash 会话（迟到事实销账要按会话分区，见 `LateFact.sessionKey`）。 */
  sessionKey: string,
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
  // 行的归属一律用 `sessions.cli_session_id`（`expectSessionId`）：实时投影写行、重启认领
  // 都按它，两侧必须是同一个值，否则同一条监听会被当成两条（见 claude-monitor-commit.ts
  // 的 `pick`）。文件里那个 session_id 只在没有归属时兜底。
  const owner = expectSessionId ?? evSession;

  const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use" && str(block.name) === "Monitor") {
      const call = parseMonitorInput(block.input);
      // 入参只在这一行上，所以这条「悬着的调用」要落盘（见 `SessionScan.pending`）。
      if (call && str(block.id)) {
        session.pending.set(str(block.id), { call, at, sourceRun: filePath });
      }
    } else if (block.type === "tool_result") {
      const toolUseId = str(block.tool_use_id);
      const raw = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
      const nativeId = session.byToolUse.get(toolUseId);
      const row = nativeId ? session.found.get(nativeId) : undefined;
      // ── 回执配得上一条**还悬着的调用**、而它自己又没说「起成了」 ⇒ 这次调用没起来 ──
      //
      // 行序是严格因果的（见文件头）：起成了的 Monitor 一定先有 `task_started`，那时这条调用
      // 就从 `pending` 里挪走了。所以回执还能在 `pending` 里找到它，只有一种解释 —— 它压根
      // 没起来（启动被拒、入参校验失败、起之前被取消）。当场完结，别让它永远悬着。
      //
      // **判据不是回执里的错误文案**（换一句措辞就漏一类，第 11 轮审查点名），而是两件事的
      // 合取：配不上 `task_started`，且这条回执自己不是一份**起手回执**（`parseMonitorStart‑
      // Receipt` 认不出期限 ⇒ 它没说「盯到 X」）。认得出的那种留给提交层去配已提交的行 ——
      // 那是配对状态被挤掉之后的正常情形，不是失败。
      if (!row && toolUseId && parseMonitorStartReceipt(raw).lifetime === "unknown"
        && session.pending.delete(toolUseId)) {
        session.cleared.push({ sessionKey, toolUseId });
        continue;
      }
      if (!row) {
        // 配不上内存状态：**交给提交层裁决**（库里有那一行就配回去，没有就是与我们无关）。
        // 普通后台 Bash 的回执写的是 "Running in background"，连交的必要都没有。
        if (toolUseId && /Monitor started/i.test(raw)) {
          if (lateFull(session)) return false; // 背压，见 `LATE_CAP`
          session.late.push({
            kind: "receipt", toolUseId, raw, at,
            sessionKey, cliSessionId: owner, skippedPrefix: session.skippedPrefix,
          });
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
    // **配不上 = 它不是 Monitor 起的。** 行序是严格因果的（见文件头），而一条还悬着的
    // Monitor 调用一定在手上（内存里，或者从 `monitor_pending_calls` 接回来的）—— 所以
    // 「这一行的调用我们没见过」只有一种解释：那个工具不是 Monitor。于是不必再维护「这个 id
    // 不是 Monitor」的结论集合（那是一张会被容量淘汰的内存表，淘汰之后它的通知就退成永远
    // 配不上的孤儿）。
    if (!started || !nativeId) return true;
    session.pending.delete(str(ev.tool_use_id));
    session.cleared.push({ sessionKey, toolUseId: str(ev.tool_use_id) });
    session.byToolUse.set(str(ev.tool_use_id), nativeId);
    session.found.set(nativeId, {
      nativeId, call: started.call, toolUseId: str(ev.tool_use_id),
      cliSessionId: owner,
      startedAtLow: started.at,
      startedAtHigh: null,   // 回执到了才有上界
      fileStartedAt,
      endedAt: null,
      lifetime: "unknown", expiresMs: null,
      status: null, endedReason: null,
      filePath, staleRun: false,
    });
  } else if (ev.subtype === "task_notification" && nativeId) {
    const row = session.found.get(nativeId);
    if (!row) {
      // 同上：配不上内存状态的终态通知交给提交层裁决。实测一个任务 76 条 task_started 里
      // 64 条是普通后台 Bash，它们全从这儿过 —— 当轮就被丢掉，不占内存、不钉位置。
      if (lateFull(session)) return false; // 背压，见 `LATE_CAP`
      session.late.push({
        kind: "notice", nativeId, status: claudeMonitorStatus(ev.status), summary: str(ev.summary),
        at: session.lastAt, sessionKey, cliSessionId: owner, skippedPrefix: session.skippedPrefix,
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

/**
 * **读过了、却配不上内存状态**的一次性事实（检查点的另一半，见 claude-monitor-commit.ts）。
 *
 * 行序是严格因果的（见文件头），所以它的另一半必然在它之前；而「它之前的内容都有归宿」是
 * 本文件的不变量。于是这条事实当轮一定裁得清：
 *   - 库里有那一行 → 按 `native_id`（终态通知）/ `tool_use_id`（起手回执）配回去
 *   - 库里也没有   → 它不是 Monitor 起的，丢掉
 * 所以它**不跨轮留存、也不钉住可重放位置**（上一版那两样正是第 10 轮审查的停滞根因）。
 */
export type LateFact = {
  /** 读到它的那条 ash 会话。销账要按会话，别把另一条会话里同号的那条也删了。 */
  sessionKey: string;
  /** 它所属的 CLI 会话身份（= `sessions.cli_session_id`）。配行时按它分区。 */
  cliSessionId: string | null;
  /** 读到它的那一代扫描跳过过前缀吗（见 `SessionScan.skippedPrefix`）。 */
  skippedPrefix: boolean;
} & (
  | { kind: "receipt"; toolUseId: string; raw: string; at: string | null }
  | { kind: "notice"; nativeId: string; status: string; summary: string; at: string | null }
);

export function lateFactsOf(scan: TaskScan): LateFact[] {
  const out: LateFact[] = [];
  for (const session of scan.sessions.values()) out.push(...session.late);
  return out;
}

/**
 * 这一轮的迟到事实都裁完了：清空通道，只留 `keep` 里那些（还裁不清的，下一轮再试）。
 *
 * 按**对象身份**留，不按 id：同一条会话里同一个 id 不会同时有两条，而跨会话的同号事实本来就
 * 该各自留在自己的会话桶里。
 */
export function clearLateFacts(scan: TaskScan, keep: readonly LateFact[] = []): void {
  for (const session of scan.sessions.values()) {
    session.late = keep.length ? session.late.filter((fact) => keep.includes(fact)) : [];
  }
}
