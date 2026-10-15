// 把扫出来的内置 Monitor 事实**落库**：缺的插进去，已有的按事实优先级补齐/纠正，
// 以及检查点另一半——**配不上内存状态的一次性事实，拿已提交的行再配一次**。
//
// 为什么单独一个文件：`claude-monitor-backfill.ts` 管的是「这一轮怎么推进、读没读完、
// 要不要留账」，这里管的是「一条事实该写成什么」。两件事的判据完全不同，混在一个文件里
// 读起来也超过了单文件行数上限。
//
// ── 检查点的两半（第 9 轮审查的类问题）──────────────────────────────────────────
//
// 内存里的配对状态（`pending`/`byToolUse`/`found`/孤儿缓冲）在内存上限下会被丢掉，只留下
// 「读到第几字节」。于是**位置之前建立的关联**就没了：那段前缀里起的 Monitor，它在后缀里的
// 回执/终态通知配不上任何东西，而扫描照旧读到文件尾、照旧销账——面板显示的是一张漏掉的卡
// 和一条写着 running 的已完成监听，刷新也不会变（第 9 轮审查用生产服务 + 真页面实测）。
//
// 所以「可重放的检查点」要两半一起成立：
//
// ① **位置只停在确认提交过的地方**（backfill 的 `checkpointCursors`）：位置之前读过的字节
//    都已经成行落库，而那一刻还悬着的调用单独落了盘（`claude-monitor-pending.ts`），于是从
//    它往后解析不会丢关联。
// ② **已提交的行就是前缀的记忆**：位置之前起的那些 Monitor 都已经写进库了，所以后缀里
//    配不上内存状态的事实，可以按 `native_id`（终态通知）和 `tool_use_id`（起手回执）
//    回到那一行上去——这也是 `monitors.tool_use_id` 这一列存在的唯一理由。
//
// 于是**配不上内存状态的事实一定裁得清**（行序严格因果，见扫描层文件头）：
//
//   - 库里有那一行 → 配回去
//   - 库里也没有   → 它不是 Monitor 起的（普通后台 Bash 的通知），丢掉
//   - **只有一种裁不清**：存量行连 `tool_use_id` 都没有（这一列是后加的），而这一代扫描又跳过
//     过前缀 —— 那时一条起手回执配不上任何行，却不能断言它与我们无关。这一条交回调用方 →
//     回到从零重放一遍，那一遍会把存量行的 `tool_use_id` 补上，下一轮就落进上面两支。
//     没跳过前缀的那一代里，同样配不上就是真的无关（否则无限重读），见
//     `CommitOutcome.undecidable` 与扫描层的 `SessionScan.skippedPrefix`。
import { and, eq } from "drizzle-orm";
import {
  claudeMonitorStatus, monitorExactExpiry, monitorStartTrusted, monitorStatusCorrectable,
  parseMonitorStartReceipt, startAnchorTolerance,
  type MonitorLifetime, type MonitorStartEvidence,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import type { Found, LateFact } from "./claude-monitor-scan.js";
import { db } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { id, now } from "./util.js";

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
  timeoutMs: number | null; startAnchorWidthMs: number | null; toolUseId: string | null;
  sourceRun: string | null; startLowAt: string | null;
};

/**
 * 库里这一批行，**按 native_id / tool_use_id 建索引**。
 *
 * 为什么是数组而不是单行：`native_id` 的唯一性由来源侧保证，而来源侧没有承诺跨 CLI 会话唯一
 * （实测 1017 条 `task_started` 里跨会话重复 0 个，但 `local_agent` 那种出现过同 id 挂两个
 * tool_use）。所以这里不假设「一个 id 一行」，而是按会话挑（见 `pick`）。
 */
type RowIndex = {
  byNative: Map<string, PriorRow[]>;
  byToolUse: Map<string, PriorRow[]>;
  /** 有没有行连 `tool_use_id` 都没记（存量行）。起手回执配不上时的唯一「裁不清」。 */
  anyMissingToolUse: boolean;
};

/**
 * 同一个 id 底下有多行时挑哪一行：**先认会话身份，再退到没有归属的存量行**。
 *
 * **只有一行也要问一句归属。** 上一版在这里短路了（「唯一索引保证一个 id 一行，没有歧义可
 * 挑」），而那个前提本身就是要修的东西：持久身份现在是 `(task_id, cli_session_id, native_id)`
 * （唯一索引 `monitors_native_session`），同一个任务上两条 CLI 会话撞同一个 id 是允许的。
 * 短路的后果是「库里碰巧只有乙那一行」时把甲的事实写到乙身上 —— 一条事实宁可暂时没归宿
 * （下一轮重读还在），也不写错行（第 13 轮审查 N1）。
 *
 * 没有归属的存量行仍然收：`cli_session_id` 是后加的列，老行上一律为空。
 */
function pick(rows: PriorRow[] | undefined, cliSessionId: string | null): PriorRow | undefined {
  if (!rows?.length) return undefined;
  return rows.find((r) => r.cliSessionId === cliSessionId) ?? rows.find((r) => !r.cliSessionId);
}

function indexRows(rows: PriorRow[]): RowIndex {
  const index: RowIndex = { byNative: new Map(), byToolUse: new Map(), anyMissingToolUse: false };
  for (const row of rows) {
    if (row.nativeId) {
      const list = index.byNative.get(row.nativeId) ?? [];
      list.push(row);
      index.byNative.set(row.nativeId, list);
    }
    if (row.toolUseId) {
      const list = index.byToolUse.get(row.toolUseId) ?? [];
      list.push(row);
      index.byToolUse.set(row.toolUseId, list);
    } else index.anyMissingToolUse = true;
  }
  return index;
}

/**
 * 这一轮提交的结果：补了几行、**有没有没确认落地的更新**（要进恢复路径），
 * 以及哪些迟到事实配上了已提交的行（调用方据此把它们从孤儿缓冲里销掉）。
 */
export type CommitOutcome = {
  added: number;
  missed: boolean;
  /** 配到了行上的迟到事实。 */
  resolved: LateFact[];
  /** 库里没有、但也**不能断言与我们无关**的（存量行缺 `tool_use_id`）：得回头重放一遍。 */
  undecidable: LateFact[];
};

/** 条件更新到底改没改到行。drizzle 把底层 client 的 `rowsAffected` 原样带出来。 */
const rowsAffectedOf = (result: unknown): number =>
  Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0);

/**
 * 把这一轮的结果落库：缺的插进去，已有的按事实优先级补齐/纠正，**再把配不上内存状态的
 * 迟到事实配到已提交的行上**。
 *
 * 后面那一步是检查点的另一半（见文件头）：`items` 为空也要做——被挤掉配对状态之后，这一轮
 * 读到的可能全是「前缀里那些 Monitor 的回执和终态」。
 */
export async function commitRound(
  taskId: string, items: Found[], late: LateFact[],
  /** 每成功一行就回报一次。写失败往外抛时，调用方靠它知道已经成功了几条。 */
  report: (added: number) => void,
): Promise<CommitOutcome> {
  if (!items.length && !late.length) {
    return { added: 0, missed: false, resolved: [], undecidable: [] };
  }
  const index = indexRows(await db
    .select({
      id: monitors.id, nativeId: monitors.nativeId, status: monitors.status,
      cliSessionId: monitors.cliSessionId, sourceLifetime: monitors.sourceLifetime,
      startedAt: monitors.startedAt, expiresAt: monitors.expiresAt,
      lifetimeEvidence: monitors.lifetimeEvidence, startEvidence: monitors.startEvidence,
      sourcePid: monitors.sourcePid, timeoutMs: monitors.timeoutMs,
      startAnchorWidthMs: monitors.startAnchorWidthMs, toolUseId: monitors.toolUseId,
      sourceRun: monitors.sourceRun, startLowAt: monitors.startLowAt,
    })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude"))));

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
    const prior = pick(index.byNative.get(item.nativeId), item.cliSessionId);

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

      // 这一轮刚插的也要进索引：同一轮里读到的迟到事实（比如同一个文件里回执排在
      // `task_started` 前面的那种）就是靠它配回来的。
      addToIndex(index, {
        id: rowId, nativeId: item.nativeId, status, cliSessionId: item.cliSessionId,
        sourceLifetime: item.lifetime, startedAt, expiresAt: expiryColumn(item, startedAt, anchor),
        lifetimeEvidence: item.lifetime === "unknown" ? null : "receipt",
        startEvidence: anchor.evidence, sourcePid: item.staleRun ? 0 : null,
        timeoutMs: item.expiresMs, startAnchorWidthMs: anchor.widthMs,
        toolUseId: item.toolUseId || null,
        sourceRun: item.filePath || null, startLowAt: item.startedAtLow,
      });
    } catch (e) {
      if (!isUniqueConflict(e)) throw e; // 真写失败：往外抛，这一轮不算读完
    }
  }

  const late2 = await applyLateFacts(taskId, late, index);
  if (late2.missed) missed = true;
  return { added, missed, resolved: late2.resolved, undecidable: late2.undecidable };
}

/** 把一行塞进索引（新插的那些也要能被同一轮的迟到事实配到）。 */
function addToIndex(index: RowIndex, row: PriorRow): void {
  if (row.nativeId) index.byNative.set(row.nativeId, [...(index.byNative.get(row.nativeId) ?? []), row]);
  if (row.toolUseId) index.byToolUse.set(row.toolUseId, [...(index.byToolUse.get(row.toolUseId) ?? []), row]);
  else index.anyMissingToolUse = true;
}

/**
 * 把配不上内存状态的一次性事实，配到**已提交的行**上。
 *
 * 这是检查点的另一半：位置之前起的那些 Monitor 都已经成行（每一轮都提交），所以后缀里的
 * 起手回执按 `tool_use_id`、终态通知按 `native_id` 都能回到那一行去。走的是和正常提交
 * 同一条 `mergeInto`——元信息无条件写、状态走 CAS 且看命中行数，来源说过的终态不被改写。
 *
 * 配不上的分两种，差别就是**能不能断言「与我们无关」**：
 * - 终态通知：能。它的 `task_started` 必然在它之前（行序严格因果），而那之前的内容都有归宿，
 *   所以库里没有这一条 = 它不是 Monitor 起的。调用方丢掉即可。
 * - 起手回执：只有在**所有行都记着 `tool_use_id`** 时才能。存量行那一列是空的，它配不上任何
 *   东西却可能正属于某一行 —— 这种交回调用方（`undecidable`），由它回头重放一遍把那一列补上。
 */
async function applyLateFacts(
  taskId: string, late: LateFact[], index: RowIndex,
): Promise<{ resolved: LateFact[]; undecidable: LateFact[]; missed: boolean }> {
  if (!late.length) return { resolved: [], undecidable: [], missed: false };

  const resolved: LateFact[] = [];
  const undecidable: LateFact[] = [];
  let missed = false;
  for (const fact of late) {
    const prior = fact.kind === "receipt"
      ? pick(index.byToolUse.get(fact.toolUseId), fact.cliSessionId)
      : pick(index.byNative.get(fact.nativeId), fact.cliSessionId);
    if (!prior || !prior.nativeId) {
      // 只有「这一代跳过过前缀」才值得回头重放：没跳过就说明它之前的内容这一代全读过了，
      // 再读一遍还是配不上 —— 那时必须断定并丢掉，否则就是无限重读（见扫描层的
      // `SessionScan.skippedPrefix`）。
      if (fact.kind === "receipt" && index.anyMissingToolUse && fact.skippedPrefix) {
        undecidable.push(fact);
      }
      continue;
    }
    const item = lateItem(prior, fact);
    if (!item) continue;
    const merged = await mergeInto(prior, item, item.status ?? prior.status, item.endedReason);
    if (merged.missed) missed = true;
    if (merged.changed) bus.publish({ type: "task.monitors", taskId });
    resolved.push(fact);
  }
  return { resolved, undecidable, missed };
}

/**
 * 把一条迟到事实包成 `Found` 的形状，好走同一条 `mergeInto`。
 *
 * **只带这条事实自己能证明的东西**：回执证明时长和起点上界，通知证明终态。代次不带
 * （`staleRun: false` ⇒ 不会凭空给存量行写上「那一代已结束」这个结论）。
 */
function lateItem(prior: PriorRow, fact: LateFact): Found | null {
  const base: Found = {
    nativeId: prior.nativeId!,
    toolUseId: prior.toolUseId ?? "",
    call: { command: "", description: "" },
    cliSessionId: prior.cliSessionId,
    startedAtLow: null, startedAtHigh: null, fileStartedAt: null,
    endedAt: null, lifetime: "unknown", expiresMs: null,
    status: null, endedReason: null, filePath: "", staleRun: false,
  };
  if (fact.kind === "receipt") {
    const receipt = parseMonitorStartReceipt(fact.raw);
    if (receipt.lifetime === "unknown") return null;
    // **起点区间能重建**：下界是行上存着的调用时刻（`start_low_at`），上界就是这条回执自己的
    // 时刻。两端都在才算得出锚点，缺下界时 `startAnchorOf` 自己会退回「起点不明」——所以这里
    // 照实给，不编（第 10 轮审查不拦项 1：上一版一律置空，窄区间再也重建不出来）。
    return {
      ...base, lifetime: receipt.lifetime as MonitorLifetime, expiresMs: receipt.ms,
      startedAtLow: prior.startLowAt, startedAtHigh: fact.at,
    };
  }
  const status = claudeMonitorStatus(fact.status);
  return { ...base, status, endedAt: fact.at, endedReason: fact.summary || null };
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
    // 检查点的另一半（见文件头）：没有这一列，后缀里的起手回执在配对状态被挤掉之后就
    // 再也配不回这一行。
    toolUseId: item.toolUseId || null,
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
    // **代次结论的持久化依据**：`found` 会被内存上限淘汰，而「它起在哪个 run 文件里」记在行上
    // 就永远算得出「后来又起过新一轮没有」（见 claude-monitor-backfill.ts 的 reconcileLiveness）。
    sourceRun: item.filePath || null,
    // 起点区间的下界。迟到回执靠它重建那个窄区间（见 lateItem）。
    startLowAt: item.startedAtLow,
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
  // 存量行（升级前写的、以及实时投影在这一列存在之前落的）要顺手补上：缺了它，这一行
  // 在配对状态被挤掉之后就配不回自己的起手回执（见文件头的检查点说明）。
  if (!prior.toolUseId && item.toolUseId) meta.toolUseId = item.toolUseId;
  // 同理：这两列也是后加的，存量行读到一次就顺手补上（代次结论 + 起点区间的下界）。
  if (!prior.sourceRun && item.filePath) meta.sourceRun = item.filePath;
  if (!prior.startLowAt && item.startedAtLow) meta.startLowAt = item.startedAtLow;
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
