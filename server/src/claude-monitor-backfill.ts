// 历史回填：把 agent 已经起过的内置 Monitor 补进投影表，并按来源事实纠正已有的记录。
//
// 为什么非有不可：这个功能的起点就是用户打开一个任务，agent 在对话里反复说「等 Monitor
// 通知」，而哨兵面板写着「这个任务上还没有哨兵」。实时投影只能管**之后**发生的事——对那个
// 触发需求的任务本身，以及所有升级前跑过的任务，面板仍然是空的。
//
// 文件枚举、增量读取和事件认人都在 `claude-monitor-scan.ts`；这个文件只管两件事：
//
// ① **提交扫出来的事实**（`commitFound`）。缺的插进去，已有的按事实优先级补齐/纠正。
// ② **重新裁决已有行的死活**（`reconcileLiveness`）。这一步**不依赖文件有没有新内容**——
//    进程可能刚刚死掉，或者上一次把还活着的来源误判成了 lost。上一版只在「历史里读到终态」
//    时才改状态，于是实测两个方向都卡住：旧 lost 行的来源还活着也不恢复、旧 running 行的
//    进程已经没了也不纠正（第 4 轮审查 existingLiveness）。
//
// ── 事实优先级（整条链共用一套）────────────────────────────────────────────────
//
//   来源说过的终态  >  ash 按来源死活的推断（running / lost）>  没有结局
//
// ③ **没确认落地的事实留账**（`claude-monitor-recovery.ts`）。扫描没读到 EOF、暂态写失败、
//    条件更新 0 行，三条都不算「这一轮读完了」——记进待恢复账本并自动退避重排，而不是打一行
//    日志等用户再开一次面板（第 6 轮审查：三条触发路径，同一个坑）。
//
// 「没读到某条事实」不等于「那条事实不成立」：没读到终态要先问来源还活不活，而不是直接判死。
// 来源已经说过的终态不被重放改写（否则显示跟着扫描次数变），ash 自己的推断必须对纠正开放
// （判据 `monitorStatusCorrectable`，与实时投影共用）。
import { and, eq, inArray } from "drizzle-orm";
import {
  monitorExactExpiry, monitorStartTrusted, monitorStatusCorrectable, startAnchorTolerance,
  type MonitorStartEvidence,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import {
  clearMonitorRecovery, monitorRecoveryTasks, noteMonitorRecovery, resetMonitorRecoveryBudget,
} from "./claude-monitor-recovery.js";
import { foundOf, newTaskScan, scanSession, type Found, type TaskScan } from "./claude-monitor-scan.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { id, now } from "./util.js";

/**
 * 每个任务的扫描快照。**不是「扫过就永不再扫」**——它记着每个文件读到第几字节，下次只读
 * 新增那一段（见 claude-monitor-scan.ts 的文件头）。
 */
const snapshots = new Map<string, TaskScan>();
/**
 * 同时留多少个任务的扫描快照。超了挤掉**最久没用过的**那个（被挤掉只意味着下次从头重读，
 * 不丢正确性）。
 *
 * 为什么要有上限：这张表按 taskId 存，而 taskId 是无界的——每打开一个历史任务就多一份
 * 游标表，进程活着就一直留着（第 6 轮审查不拦项）。32 远大于一次会话里会翻看的任务数。
 */
const SNAPSHOT_CAP = 32;
/**
 * 连「正在恢复中」的游标都得挤时的硬上限。到这一档说明同时有 64 个任务的历史没读完，
 * 那已经不是缓存问题了——挤掉最老的并留一行日志，总比无界增长好。
 */
const SNAPSHOT_HARD_CAP = 64;

/**
 * 记下这个任务的扫描快照，并按「最久没用的先挤掉」淘汰——**但正在恢复中的游标不挤**。
 *
 * 为什么要豁免：快照里记着「这个文件读到第几字节」。被挤掉之后下一轮 `newTaskScan()` 从零
 * 开始，而单次只读 128 MiB，于是「超过上限、Monitor 在末尾」的那种任务会反复重读同一段
 * 前缀、永远到不了末尾；更糟的是 `advanced` 只说明「相对这一轮的新游标读过字节」，看起来
 * 还一直在前进（第 7 轮审查按控制流推断）。恢复中的游标是**还没完成的责任**，不是缓存。
 */
function rememberScan(taskId: string, scan: TaskScan): void {
  snapshots.delete(taskId);
  snapshots.set(taskId, scan); // 用过的挪到末尾
  if (snapshots.size <= SNAPSHOT_CAP) return;
  const protectedTasks = monitorRecoveryTasks();
  for (const key of [...snapshots.keys()]) {
    if (snapshots.size <= SNAPSHOT_CAP) return;
    if (key === taskId || protectedTasks.has(key)) continue; // 还没读完的不动
    snapshots.delete(key);
  }
  // 全都在恢复中：按硬上限兜底，并说清为什么——这时重读代价是真实存在的。
  while (snapshots.size > SNAPSHOT_HARD_CAP) {
    const oldest = snapshots.keys().next();
    if (oldest.done || oldest.value === taskId) break;
    snapshots.delete(oldest.value);
    console.warn(`[ash] 内置 Monitor 扫描快照超过硬上限（${SNAPSHOT_HARD_CAP}），`
      + `挤掉还在恢复中的 task=${oldest.value} 的游标，它下次要从头重读`);
  }
}

/** 正在跑的那次 → 它的 Promise。并发调用共享同一次工作，不重复读盘。 */
const inflight = new Map<string, Promise<number>>();

/** 这个任务的扫描游标还在不在（只给回归用：验「恢复中的游标没被挤掉」）。 */
export const monitorScanTracked = (taskId: string): boolean => snapshots.has(taskId);

/**
 * 把一个任务的内置 Monitor 补进投影表，并纠正已有记录。
 *
 * 返回新补了几行（纠正不计入）。并发调用共享同一次扫描。
 */
export function backfillClaudeMonitors(
  taskId: string,
  /**
   * `external`（默认 true）= 这是一次**外部真实请求**（用户打开面板、SSE 触发重读）。
   * 恢复账本自己的退避推进必须传 false：公共入口会还原退避预算，自己推进时还原就等于
   * 永远停在第一档、永远到不了 exhausted（第 7 轮审查实测 4 次间隔全是 ~1003ms）。
   */
  opts: { external?: boolean } = {},
): Promise<number> {
  if (dbClient.closed) return Promise.resolve(0);
  const running = inflight.get(taskId);
  if (running) return running;
  // 退避推到上限之后账是留着的、定时器是停的。真实请求进来时把预算还给它，否则那条账
  // 永远卡在「已停、且没人会再推」。
  if (opts.external !== false) resetMonitorRecoveryBudget(taskId);
  const job = runBackfill(taskId).finally(() => inflight.delete(taskId));
  inflight.set(taskId, job);
  return job;
}

async function runBackfill(taskId: string): Promise<number> {
  let added = 0;
  // 这一轮有没有剩下「没确认完成」的事实。**四样都在外层**：销账的判断发生在死活裁决
  // 之后，而扫描结果是在 try 里拿到的。
  let missed = false;
  let unread = false;
  try {
    const rows = await db
      .select({ id: sessions.id, cliSessionId: sessions.cliSessionId, outPath: sessions.agentOutPath })
      .from(sessions)
      .where(and(eq(sessions.taskId, taskId), eq(sessions.agentType, "claude")));

    // 快照跨调用复用，但**会话清单每次重查**：任务后来新增了会话，上一次的快照里没有它
    // （实测 noSessionThenNewSession：首次回填时任务还没有会话，之后新增 → 永远读不到）。
    const scan = snapshots.get(taskId) ?? newTaskScan();
    rememberScan(taskId, scan);
    scan.truncated = false;
    scan.failed = false;
    scan.advanced = false;
    scan.generationChanged = false;
    scan.orphanOverflow = false;

    for (const session of rows) {
      if (!session.outPath) continue;
      await scanSession(scan, session.id, session.cliSessionId, session.outPath);
    }
    if (scan.foreign.size) {
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 的文件里出现了别的会话身份`
        + `（${[...scan.foreign].join(", ")}），已按文件归属采用`);
    }
    if (scan.truncated || scan.failed) {
      // **不是「下次打开面板继续」**：记进待恢复账本，由它退避重排自己往下推。游标已经
      // 记下，所以每一次重推都真的往后读一段；`scan.advanced` 作为「有进展」喂给退避预算。
      unread = true;
      if (scan.truncated) noteMonitorRecovery(taskId, "scan-unfinished", scan.advanced);
      if (scan.failed) noteMonitorRecovery(taskId, "scan-failed", scan.advanced);
      console.warn(`[ash] 内置 Monitor 历史回填这一轮没读完（task=${taskId}，`
        + `${scan.truncated ? "有文件读到了单次上限" : ""}${scan.truncated && scan.failed ? "，" : ""}`
        + `${scan.failed ? "有文件读失败" : ""}），游标已记下，已排自动续读`);
    }

    // 孤儿事实被挤出缓冲：这一轮的读取结果可能不全（游标越过了一条一次性事实，而来源不会
    // 重发）。丢掉快照让下一轮从头重读，并留账——**进展一律按 false 记**：重读必然"读到新
    // 字节"，拿它当进展会让退避预算永远清零、每秒重读一个大文件（见不拦项 1 的同款陷阱）。
    if (scan.orphanOverflow) {
      unread = true;
      snapshots.delete(taskId);
      noteMonitorRecovery(taskId, "orphan-overflow", false);
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 还没配对的事实超过缓冲上限，`
        + `这一轮结果可能不全，已丢弃游标等重读`);
    }

    // **提交条件不只是「有新字节」。** 新回合会先创建一个空的 run 文件、过一会儿才输出，那一刻
    // 没有任何新增字节，但「上一代已经结束」这件事已经成立，必须落库（否则死活裁决退回「这条
    // 会话现在有活进程」，旧监听一直显示正在盯着——第 5 轮审查实测 emptyNewRun）。
    if (scan.advanced || scan.generationChanged) {
      const outcome = await commitFound(taskId, foundOf(scan), (n) => { added = n; });
      added = outcome.added;
      if (outcome.missed) {
        // 条件更新 0 行 = 那次更新**没有**落地（读到写之间别的 writer 改了状态）。上一版
        // 把它当成已提交，于是那条事实永久消失（实测 casAtRace）。记账 + 把快照丢掉：
        // 下一轮从头重读，重新观察到同一条事实再裁决一次（那时 prior 是对方写的新状态，
        // 多数情况下判定为「来源终态已成定局，不该改」→ 干净收场）。
        snapshots.delete(taskId);
        noteMonitorRecovery(taskId, "update-missed", added > 0);
      }
      missed = outcome.missed;
    }
  } catch (e) {
    // 回填失败不该让面板打不开：这是补历史，不是主路径。但要留下线索，而且**部分成功的那些
    // 也要让别的页面看得到**：`added` 由 commitFound 每成功一行就回报一次（上一轮只在它
    // 整个返回后才赋值，所以第 1 行成功、第 2 行抛错时这里仍是 0，publish 到不了
    // ——第 5 轮审查不拦项 1）。
    console.warn(`[ash] 内置 Monitor 历史回填失败（task=${taskId}）:`, e);
    if (added) bus.publish({ type: "task.monitors", taskId });
    snapshots.delete(taskId); // 失败的快照不留，下次从头建（游标归零，事实能被重新读到）
    // 事实已经从文件里读出来过、却没确认落库。留账 + 自动重排：这一条上一版只有一句
    // 「历史回填会再补」，而历史回填本身只在用户打开面板时才跑。
    noteMonitorRecovery(taskId, "write-failed", added > 0);
    return added;
  }

  // **死活裁决属于同一轮的恢复责任。** 它在 clear 之后跑、失败只 warn 的话，「扫描读完了」
  // 就被当成「这一轮全做完了」——实测注入一次死活 UPDATE 失败：行停在 running、账本是空的、
  // 一条事件都没发，要等人再调一次回填才变 lost（第 7 轮审查 livenessWriteFailure）。
  let reconciled = true;
  try {
    if (await reconcileLiveness(taskId)) bus.publish({ type: "task.monitors", taskId });
  } catch (e) {
    console.warn(`[ash] 内置 Monitor 死活裁决失败（task=${taskId}）:`, e);
    reconciled = false;
    noteMonitorRecovery(taskId, "liveness-failed", added > 0);
  }
  // **销账的条件是「这一轮什么都没剩下」**，四件事都要问：读到 EOF 了、没有读失败、发出去
  // 的更新都落地了、死活也核对完了。少问任何一句都会把「未确认」当成「已完成」。
  if (!unread && !missed && reconciled) clearMonitorRecovery(taskId);
  if (added) bus.publish({ type: "task.monitors", taskId });
  return added;
}

/**
 * 从起点**区间**裁出一个可用的锚点。
 *
 * 真实起点落在 `[startedAtLow, startedAtHigh]` 之间（两端都是日志里真实存在的时刻，见
 * `Found.startedAtLow` 的说明）。区间窄到不影响显示时，取上界当起点并给出精确到期时刻；
 * 宽了就说「起点不明」——这时仍然知道时长，只是不编到期时刻。
 *
 * 为什么取**上界**而不是中点：上界是回执时刻，它是真实起点之后最近的一个确定事件。误差方向
 * 一致（显示的到期略晚于真实），且有界——而区间已经被判定为可忽略宽度。
 */
function startAnchorOf(item: Found): Anchor {
  const { startedAtLow: low, startedAtHigh: high } = item;
  if (!high) return { startedAt: null, evidence: null, widthMs: null };   // 没有回执 ⇒ 期限本来也不知道
  const width = low ? Math.abs(Date.parse(high) - Date.parse(low)) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(width) || width > startAnchorTolerance(item.expiresMs)) {
    return { startedAt: null, evidence: null, widthMs: null };
  }
  return { startedAt: high, evidence: "receipt-window", widthMs: Math.round(width) };
}

/** 一个起点锚点：时刻 + 它是哪来的 + 它最远可能差多少（后两样一起才算证据）。 */
type Anchor = {
  startedAt: string | null;
  evidence: MonitorStartEvidence | null;
  widthMs: number | null;
};

/** 这次插入撞的是唯一索引吗（= 别人刚补过同一条，幂等，不是错误）。 */
const isUniqueConflict = (e: unknown): boolean =>
  (e as { errcode?: number } | null)?.errcode === 2067
  || /UNIQUE constraint failed/i.test((e as Error | null)?.message ?? "");

type PriorRow = {
  id: string; nativeId: string | null; status: string;
  cliSessionId: string | null; sourceLifetime: string; startedAt: string; expiresAt: string;
  lifetimeEvidence: string | null; startEvidence: string | null; sourcePid: number | null;
  timeoutMs: number | null; startAnchorWidthMs: number | null;
};

/** `commitFound` 的结果：补了几行，以及**有没有没确认落地的更新**（要进恢复路径）。 */
type CommitOutcome = { added: number; missed: boolean };

/** 条件更新到底改没改到行。drizzle 把底层 client 的 `rowsAffected` 原样带出来。 */
const rowsAffectedOf = (result: unknown): number =>
  Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0);

/** 把扫出来的结果落库：缺的插进去，已有的按事实优先级补齐/纠正。 */
async function commitFound(
  taskId: string, items: Found[],
  /** 每成功一行就回报一次。写失败往外抛时，调用方靠它知道已经成功了几条。 */
  report: (added: number) => void,
): Promise<CommitOutcome> {
  if (!items.length) return { added: 0, missed: false };
  const existing = new Map((await db
    .select({
      id: monitors.id, nativeId: monitors.nativeId, status: monitors.status,
      cliSessionId: monitors.cliSessionId, sourceLifetime: monitors.sourceLifetime,
      startedAt: monitors.startedAt, expiresAt: monitors.expiresAt,
      lifetimeEvidence: monitors.lifetimeEvidence, startEvidence: monitors.startEvidence,
      sourcePid: monitors.sourcePid, timeoutMs: monitors.timeoutMs,
      startAnchorWidthMs: monitors.startAnchorWidthMs,
    })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude"))))
    .filter((r) => !!r.nativeId)
    .map((r) => [r.nativeId as string, r]));

  const probe = createLivenessProbe();
  let added = 0;
  let corrected = 0;
  let missed = false;

  for (const item of items) {
    // 没读到终态有两种可能，差别正好相反：那一轮的进程早就没了（该写 lost），还是它**现在
    // 还在盯着**（该写 running）。问来源，别猜。
    //
    // `staleRun` 是最强的那档证据：它所在的 run 文件后面还有更新的 run，那一代进程必然已经
    // 退出。没有它就只能退回「这条会话现在有活进程」，而那会被下一回合的新进程骗。
    const alive = item.status || item.staleRun
      ? false
      : await probe.sourceAlive({ cliSessionId: item.cliSessionId, taskId });
    const status = item.status ?? (alive ? "running" : "lost");
    const endedReason = item.endedReason
      ?? (item.status ? null : alive ? null : "历史记录里没有它的结局（那一轮的进程早已结束）");
    const prior = existing.get(item.nativeId);

    if (prior) {
      const merged = await mergeInto(prior, item, status, endedReason);
      if (merged.missed) missed = true;
      if (merged.changed) {
        corrected += 1;
        // 纠正也要能通知出去：原来只在整个循环跑完之后 publish 一次，中途抛错就全丢了。
        bus.publish({ type: "task.monitors", taskId });
      }
      continue;
    }
    const anchor = startAnchorOf(item);
    // 起点拿不到就退回「这一轮 run 开始的时刻」当显示值——但那不参与期限计算。
    const startedAt = anchor.startedAt ?? item.startedAtLow ?? item.fileStartedAt ?? now();
    const rowId = id();
    try {
      await insertFound(rowId, taskId, item, status, endedReason, startedAt, anchor);
      added += 1;
      report(added); // 中途抛错时，已成功的这些仍要被通知出去（见 runBackfill 的 catch）

      existing.set(item.nativeId, {
        id: rowId, nativeId: item.nativeId, status, cliSessionId: item.cliSessionId,
        sourceLifetime: item.lifetime, startedAt, expiresAt: expiryColumn(item, startedAt, anchor),
        lifetimeEvidence: item.lifetime === "unknown" ? null : "receipt",
        startEvidence: anchor.evidence, sourcePid: item.staleRun ? 0 : null,
        timeoutMs: item.expiresMs, startAnchorWidthMs: anchor.widthMs,
      });
    } catch (e) {
      if (!isUniqueConflict(e)) throw e; // 真写失败：往外抛，这一轮不算读完
    }
  }
  return { added, missed };
}

/**
 * `expires_at` 这一列该写什么。**它已经不是对外契约的一部分**——对外那个精确到期时刻由
 * `monitorExactExpiry` 从「起点 + 时长」现算（见 shared/src/monitor.ts）。这一列是 NOT NULL
 * 的，算不出来就回到占位值 `started_at`，顺便把升级前那些假时刻冲掉。
 */
const expiryColumn = (item: Found, startedAt: string, anchor: Anchor): string => monitorExactExpiry({
  sourceLifetime: item.lifetime,
  startEvidence: anchor.evidence,
  startAnchorWidthMs: anchor.widthMs,
  startedAt: anchor.startedAt ?? startedAt,
  timeoutMs: item.expiresMs,
}) ?? startedAt;

/** 插一行历史投影。只读投影：没有 pid、没有日志文件（见 shared/monitor.ts 的两种来源）。 */
async function insertFound(
  rowId: string, taskId: string, item: Found, status: string, endedReason: string | null,
  startedAt: string, anchor: Anchor,
): Promise<void> {
  await db.insert(monitors).values({
    id: rowId,
    taskId,
    command: item.call.command,
    description: item.call.description,
    cwd: "",
    status,
    pid: null,
    pidStartedAt: null,
    logPath: "",
    offset: 0,
    events: 0,
    exitCode: null,
    startedAt,
    // 到期列与对外那一道**同一个算式**（`expiryColumn` → `monitorExactExpiry`）：两样证据
    // 都在才算得出来，否则存占位值。
    expiresAt: expiryColumn(item, startedAt, anchor),
    // 还在跑的没有结束时刻；结束了的用通知附近那条事件的时刻。都没有就留空——写 now()
    // （回填这一刻，可能是几天后）等于把读取时间冒充成来源完成时间。
    endedAt: status === "running" ? null : item.endedAt,
    endedReason,
    ownerUserId: null,
    kind: "claude",
    nativeId: item.nativeId,
    cliSessionId: item.cliSessionId,
    // 时长和起点是两件事：读到回执就知道时长（evidence='receipt'），起点另说。
    sourceLifetime: item.lifetime,
    lifetimeEvidence: item.lifetime === "unknown" ? null : "receipt",
    startEvidence: anchor.evidence,
    // 锚点的误差界。没有它那一列就只是个无法重验的结论（见 shared 的 monitorStartTrusted）。
    startAnchorWidthMs: anchor.widthMs,
    timeoutMs: item.expiresMs,
    // 历史重建拿不到「起它的那一代进程」的 pid——`sessions` 那两列早被后续回合覆盖了。
    // 但**「那一代已经结束」这个结论是拿得到的**：它所在的 run 文件后面还有更新的 run。
    // 0 就是这个结论（见 db/schema.ts 的说明）；拿不到任何证据才留 null。
    sourcePid: item.staleRun ? 0 : null,
    sourcePidStartedAt: null,
  });
}

/**
 * 已有行：按来源事实补齐/纠正，**不是「已有就永不更新」**。
 *
 * ── 两组更新，判据完全不同（第 6 轮审查的类问题）────────────────────────────
 *
 * **① 独立元信息**（会话归属、代次结论、时长、起点、到期列）：跟这一行当前是什么状态**没有
 * 关系**，无条件写。上一版把它们和状态塞进同一条带 CAS 的 UPDATE，于是「完成抢先到达」之后
 * 时长永远补不上来——状态已经是终态，CAS 命中 0 行，整条 patch（含时长）一起丢掉，而那一行
 * 对外永远显示「期限未知」（实测 casAtRace）。
 *
 * 并发安全靠的不是 CAS 而是**每一列的写入语义**：它们要么是同一条来源事实算出来的同一个值
 * （幂等），要么是单向补齐（空 → 有）。最坏的交错是把实时投影刚写的 `observed` 起点换成同样
 * 可信的 `receipt-window` 起点——两者都满足对外不变量，误差在共用容差之内。
 *
 * **② 状态**：只纠正 ash 自己推断的 `running`/`lost`，来源说过的终态不碰；**必须 CAS**
 * （读到写之间隔着 await，期间实时投影可能已经落了真终态），而且**要看 CAS 有没有命中**
 * ——0 行就是「这次更新没落地」，必须进恢复路径，不能当成已提交。
 *
 * ── 时长与起点是两件独立的事 ─────────────────────────────────────────────
 *
 * 旧判据把它们绑在一个 `if` 里：时长一旦「曾由回执证明过」，起点就再也不修了。于是升级前
 * 写的那批行（时长真、起点是回执时刻、晚一分钟）永远留着那个错起点。现在分别判，各自看
 * 各自的证据。
 */
async function mergeInto(
  prior: PriorRow, item: Found, status: string, endedReason: string | null,
): Promise<{ changed: boolean; missed: boolean }> {
  const meta: Record<string, unknown> = {};
  if (!prior.cliSessionId && item.cliSessionId) meta.cliSessionId = item.cliSessionId;
  // 代次结论也要补到存量行上，否则下面的死活裁决仍会被新进程骗。
  if (item.staleRun && prior.sourcePid === null) meta.sourcePid = 0;

  // ── 时长 ──
  // 旧行可能写着一个由旧算法推出来的 bounded（`lifetime_evidence` 为空），那种也要被回执
  // 纠正——不能只升级 unknown。已经被回执证明过的不再改写（同一条回执算出来也是同一个值）。
  let lifetime = prior.sourceLifetime;
  let timeoutMs = prior.timeoutMs;
  if (prior.lifetimeEvidence !== "receipt" && item.lifetime !== "unknown") {
    if (item.lifetime === "bounded" && item.expiresMs !== null) {
      meta.sourceLifetime = lifetime = "bounded";
      meta.lifetimeEvidence = "receipt";
      meta.timeoutMs = timeoutMs = item.expiresMs;
    } else if (item.lifetime === "persistent") {
      // 持续监听不需要绝对起点——它根本没有到期时刻可言。
      meta.sourceLifetime = lifetime = "persistent";
      meta.lifetimeEvidence = "receipt";
    }
  }

  // ── 起点（与上面那一段无关）──
  // **这一行自己已有的可信起点优先**：实时投影看着事件到达落的 `observed` 比任何事后推算
  // 都准。只有它没有可信起点时才用这次扫描裁出来的区间锚点（判据与新插入路径同一套
  // `startAnchorOf`，不另搞一套近似）。
  const anchor = startAnchorOf(item);
  let startedAt = prior.startedAt;
  let startEvidence: string | null = prior.startEvidence;
  let startWidth = prior.startAnchorWidthMs;
  // 「本行已有的起点可不可信」要用**可重验**的判据（档位 + 误差界），不能只看那个字符串：
  // 旧行的 `observed` 可能是写库队列积压 2.2 秒之后取的时刻（第 7 轮审查实测），光看字符串
  // 它永远优先，于是历史里那个窄区间锚点永远没机会把它改对。
  const priorTrusted = monitorStartTrusted({
    startEvidence: prior.startEvidence,
    startAnchorWidthMs: prior.startAnchorWidthMs,
    timeoutMs,
  });
  if (!priorTrusted && anchor.evidence) {
    meta.startedAt = startedAt = anchor.startedAt!;
    meta.startEvidence = startEvidence = anchor.evidence;
    meta.startAnchorWidthMs = startWidth = anchor.widthMs;
  }

  // ── 到期列 ──
  // 由上面两样**现算**。算不出来就回到占位值：期限从 unknown 升级那一刻，上一版只补时长、
  // 把占位值留在那儿不动，于是卡片画出「开始即到期」（实测跨度 0ms，本该 90 秒）。现在
  // 要么由可信起点算出真值，要么明确落回占位值，不存在「占位值被当成真值」的中间态。
  const want = monitorExactExpiry({
    sourceLifetime: lifetime, startEvidence, startAnchorWidthMs: startWidth, startedAt, timeoutMs,
  }) ?? startedAt;
  if (want !== prior.expiresAt) meta.expiresAt = want;

  // ── 状态 ──
  const stateChange = !!item.status && prior.status !== status && monitorStatusCorrectable(prior.status);
  let missed = false;
  if (Object.keys(meta).length) {
    await db.update(monitors).set(meta).where(eq(monitors.id, prior.id));
  }
  if (stateChange) {
    const result = await db.update(monitors)
      .set({ status, endedAt: item.endedAt, endedReason })
      .where(and(eq(monitors.id, prior.id), eq(monitors.status, prior.status)));
    if (rowsAffectedOf(result) === 0) missed = true;
  }
  return { changed: Object.keys(meta).length > 0 || (stateChange && !missed), missed };
}

/**
 * 重新裁决这个任务已有投影行的死活，**与文件有没有新内容无关**。
 *
 * 两个方向都要纠正：
 * - 写着 `lost`、而起它的来源其实还活着 → 回到 `running`（上一次判错了）。
 * - 写着 `running`、而来源已经没了 → 落 `lost`。
 *
 * 为什么不能并进 `mergeInto`：那条路要求「这一轮扫到了这条 Monitor」。文件没有新内容时
 * （常态）根本不会走到它，而进程的死活随时在变（实测 existingLiveness 两个方向都卡住）。
 * 来源已经给过终态的行不在此列 —— 那是事实，不是推断。
 */
async function reconcileLiveness(taskId: string): Promise<boolean> {
  const rows = await db
    .select({
      id: monitors.id, status: monitors.status, cliSessionId: monitors.cliSessionId,
      taskId: monitors.taskId, sourcePid: monitors.sourcePid, sourcePidStartedAt: monitors.sourcePidStartedAt,
    })
    .from(monitors)
    .where(and(
      eq(monitors.taskId, taskId),
      eq(monitors.kind, "claude"),
      inArray(monitors.status, ["running", "lost"]),
    ));
  if (!rows.length) return false;

  const probe = createLivenessProbe();
  const revive: string[] = [];
  const bury: string[] = [];
  for (const row of rows) {
    const alive = await probe.sourceAlive(row);
    if (alive && row.status === "lost") revive.push(row.id);
    else if (!alive && row.status === "running") bury.push(row.id);
  }
  if (revive.length) {
    await db.update(monitors)
      .set({ status: "running", endedAt: null, endedReason: null })
      .where(and(inArray(monitors.id, revive), eq(monitors.status, "lost")));
  }
  if (bury.length) {
    await db.update(monitors)
      .set({ status: "lost", endedAt: now(), endedReason: "起它的那个智能体进程已经不在了" })
      .where(and(inArray(monitors.id, bury), eq(monitors.status, "running")));
  }
  return revive.length + bury.length > 0;
}
