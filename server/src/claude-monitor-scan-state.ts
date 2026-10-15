// 扫描状态：一轮扫描在内存里攒的东西长什么样，以及怎么把它读出来交给落盘/提交层。
//
// 从 `claude-monitor-scan.ts` 里分出来的：那边是**怎么读**（流式读文件、认事件、配对），
// 这边是**读出来的东西放在哪**（容器的形状 + 若干只读访问器）。两件事的改动理由不一样
// ——加一种事件走那边，加一个要落盘的字段走这边——分开之后各自都看得完。
//
// 不变量与判据的说明都在 `claude-monitor-scan.ts` 的文件头，这里不复述。
import type { MonitorLifetime } from "@ash/shared/monitor";
import type { MonitorCall } from "./claude-monitors.js";
import type { ClearedCall, PendingCall } from "./claude-monitor-pending.js";
import type { ScanCursor } from "./claude-monitor-cursors.js";

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
export type SessionScan = {
  /**
   * tool_use_id → 入参 + 那条 assistant 事件的时刻（起点区间的下界，见 Found.startedAtLow）。
   *
   * 入参只存在于 `tool_use` 那一行，而身份要等 `task_started` 才有，所以这段「悬着」的状态
   * 必须活过读取窗口和内存上限 —— 它**落盘**（`claude-monitor-pending.ts`），新建会话桶时
   * 从那里恢复。读取位置不再为它让路。
   */
  pending: Map<string, { call: MonitorCall; at: string | null; sourceRun: string | null }>;
  /** tool_use_id → 它在 `found` 里的键。**不是 native_id**（见 `foundKey`）。 */
  byToolUse: Map<string, string>;
  /** 键是 `foundKey(来源会话, native_id)`，不是裸 native_id（见那个函数）。 */
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
  /**
   * 这一轮有没有改动**任何**读取位置状态（offset / probe / 缺口全集）。
   *
   * 落盘条件原先只看 `advanced`（offset 往前了）。换行边界搜索只推进 `probe`、不推进
   * offset，于是「预算用完、下轮接着找」这件事只活在内存里：缓存一丢或进程一重启，搜索
   * 又从同一处开始，后面的内容仍然读不到（第 5 轮审查 N1 按代码推断的那一条）。
   */
  cursorsDirty: boolean;
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
  /**
   * 每个 run 文件里**自己报的** CLI 会话身份。
   *
   * 这是「这个任务历史上有过哪几个来源」的权威依据（`sourceSetOf`）：一个 run 文件 = 一次
   * agent 进程启动 = 一个 CLI 会话。`sessions.cli_session_id` 只记得当前那一个，resume
   * 之后旧号就被覆盖掉了，拿它当全集是错的（第 6 轮审查 N2）。
   *
   * 跟着游标落盘（`ScanCursor.source`），所以快照被内存上限挤掉之后仍然说得出全集。
   */
  fileSources: Map<string, string>;
};

export const newTaskScan = (): TaskScan => ({
  sessions: new Map(), truncated: false, failed: false, foreign: new Set(),
  advanced: false, generationChanged: false, lateOverflow: false, restoredCursors: null,
  partialTail: false, skippedRecord: false, cursorsDirty: false,
  restoredPending: null, fileSources: new Map(),
  committedThrough: true, runFiles: { all: new Set(), latest: new Set() },
});

export const newSessionScan = (): SessionScan => ({
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

/**
 * 这个任务**历史上有过哪几个 CLI 来源**,以及这份清单全不全。
 *
 * 全集的判据是「每个 run 文件都说得出自己的来源」—— 文件清单本身是权威的(扫描每轮重建),
 * 来源则来自文件自己报的 session_id(见 `TaskScan.fileSources`,会跟着游标落盘)。有文件还
 * 没说出来源(比如新回合刚建出来的空文件)就是**不全**,这时谁都证明不了「只有我这一个来源」。
 *
 * 用处只有一个:无归属的存量行要不要认领(claude-monitor-identity.ts 的 `soleSource`)。
 */
export function sourceSetOf(scan: TaskScan): { complete: boolean; ids: Set<string> } {
  const known = new Map<string, string | null>();
  for (const [path, cursor] of scan.restoredCursors ?? []) known.set(path, cursor.source);
  for (const session of scan.sessions.values()) {
    for (const [path, cursor] of session.cursors) known.set(path, cursor.source);
  }
  for (const [path, source] of scan.fileSources) known.set(path, source);
  const ids = new Set<string>();
  let complete = true;
  for (const path of scan.runFiles.all) {
    const source = known.get(path) ?? null;
    if (source) ids.add(source);
    else complete = false;
  }
  return { complete, ids };
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
  /** 读到它的那个 run 文件。**无归属的行只能靠它被认下来**（见 claude-monitor-identity.ts）。 */
  sourceRun: string;
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
