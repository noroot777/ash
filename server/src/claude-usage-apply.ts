// claude 账本回填的**落地协议**。计划在 claude-usage-repair.ts，单份 trace 的读写在
// claude-usage-trace.ts。
//
// 这一步要同时改两类资源：`data/runs/**/<session>.trace.jsonl` 几十份文件，和库里的
// `sessions` / `usage_cumulative_snapshots` 两张表。**它们必须同生共死**，否则留下的半
// 成品比不改坏得多：
//
// - 账改了、trace 没改 → 下一次回填会把那半截累计值重新求一遍差（它的上一份基线已经没
//   了），越修越歪；
// - trace 改了、账没改 → 气泡是对的、总量还是虚高的，而且**已经被改写的累计基线拼不回
//   来**，重跑一次就把 400 修成 600（第 2 轮审查实测）。
//
// 所以协议是三段，一段都不能省：
//
// ① **独立闸**（不写任何东西）：三件事。先自己读一遍人工屏障的状态 —— 读不出来就整盘拒绝
//    （「不知道该挡谁」不是「谁都不用挡」，第 1 轮审查 F3），有效记录点名的线程则连它的
//    账、trace 和**累计快照**一起挡（快照曾漏在闸外，第 3 轮审查 F3）；再核对**整份写集的
//    真实落点**都在本资源集的 runs 根里面（第 3 轮审查 F1）；最后逐条复核计划的写入边界 ——
//    只有 `action.kind === "update"` 且口径是 cumulative 的条目才允许落账。这一整段**故意
//    跟计划层重复**：跳过项不许落账是个不变量，不能只靠产出计划那一层自觉，上一版就是靠
//    「after 非空」单点判断才让 uncertain 的条目落了账。有一条过不了就整轮不写。
// ② **预检**（不落盘）：把每份 trace 的新内容在内存里算出来并逐条核对原值。哪条 CLI 线程
//    有一份算不出来，这条线程的 trace、账、累计快照**整组**都不写（一个失败集，不是三个）。
// ③ **提交**：先写 trace（原文留在内存里），再做库事务。**这一段里任何一步失败都整体回滚**
//    —— 已经写下去的 trace 逐份还原回原内容，库一个字节不改。连还原都失败才落一份隔离
//    记录（claude-usage-quarantine.ts），并且从此明确拒绝重跑那几条线程。
//
// 硬杀在「trace 全写完、库事务还没提交」之间是**不需要人介入**的那一种：那时整条线程的
// 条目全都带 `delta` 标记，而「账 = 各条增量之和」是恒等式，重跑一次就可证明地收敛到正确
// 值（连累计基线都能从改写后的记录重新拼出来）。这正是不必额外写提交日志的原因 ——
// 恢复所需的信息已经在数据里了。
import { eq } from "drizzle-orm";
import type { TokenUsage } from "@ash/shared";
import { db } from "./db/index.js";
import { appSettings, sessions, usageCumulativeSnapshots } from "./db/schema.js";
import {
  type PreparedTrace,
  prepareTraceRewrite,
  restorePreparedTrace,
  traceEscapeReason,
  writePreparedTrace,
} from "./claude-usage-trace.js";
import { CLAUDE_REPAIR_MARKER, type ClaudeUsageRepairPlan } from "./claude-usage-repair.js";
import { readUnresolvedState, writeUnresolvedRepair } from "./claude-usage-quarantine.js";

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 };

export type TraceCommitReport = {
  files: number;
  entries: number;
  /** 哪几份算不出来 / 写不下去，一条一句话。 */
  failures: string[];
  /** 这几条 CLI 线程这一轮整组不动（trace + 账 + 快照）。 */
  failedThreads: string[];
};

export type ApplyReport = {
  sessions: number;
  snapshots: number;
  traces: TraceCommitReport;
  /** 计划里越过写入边界的条目。**非空时一个字节都没写**。 */
  refused: string[];
  /** 提交失败后还原了几份 trace。 */
  rolledBack: number;
  /** 连还原都失败时留下的隔离记录路径。 */
  unresolved: string | null;
  committed: boolean;
};

const EMPTY_TRACES: TraceCommitReport = { files: 0, entries: 0, failures: [], failedThreads: [] };
const threadOf = (sourceId: string) => sourceId.replace(/^claude:/, "");

/**
 * 独立闸：有没有东西越过写入边界。**不读计划的自述，自己判一遍。**
 *
 * 第一条就是人工屏障：`plan.unresolved` 是计划层读到的，这里**重新读一次磁盘** —— 计划到
 * 落地之间屏障可能刚被写下（另一次回填失败了），而「读不出来」这一态必须在写入入口整体
 * 拒绝，不能指望计划层已经把动作清成空。
 */
function refuseUnwritable(plan: ClaudeUsageRepairPlan): string[] {
  const refused: string[] = [];
  const unresolved = readUnresolvedState();
  if (unresolved.kind === "unreadable") {
    refused.push(`未决状态读不出来（${unresolved.detail}）：${unresolved.file} —— `
      + "认不出该挡住哪几条线程，整盘拒绝写入；人工核对 .pre-usage-repair 备份后删掉那份文件再重跑");
    return refused; // 后面逐条判也没意义了
  }
  if (unresolved.kind === "pending") {
    const blocked = new Set(unresolved.record.threads);
    for (const item of plan.sessions) {
      if (item.action.kind === "update" && item.cliSessionId && blocked.has(item.cliSessionId)) {
        refused.push(`${item.sessionId}：线程 ${item.cliSessionId} 还在隔离记录里，不许落账`);
      }
    }
    for (const rewrite of plan.traces) {
      if (blocked.has(rewrite.cliSessionId)) {
        refused.push(`${rewrite.sessionId}：线程 ${rewrite.cliSessionId} 还在隔离记录里，不许改写 trace`);
      }
    }
    // 快照也是写集的一部分:屏障是在计划算完之后才出现的那种情况下，计划层不会替这一闸
    // 过滤掉它，而「待建基线」的快照照样是往表里写一行。
    for (const snapshot of plan.snapshots) {
      if (blocked.has(threadOf(snapshot.sourceId))) {
        refused.push(`${snapshot.sourceId}：线程还在隔离记录里，不许写累计快照`);
      }
    }
  }
  // 写集的真实落点:一条越界就整轮拒绝（不是只跳过那一份）。
  for (const rewrite of plan.traces) {
    const escaped = traceEscapeReason(rewrite.taskId, rewrite.sessionId);
    if (escaped) refused.push(escaped);
  }
  for (const item of plan.sessions) {
    if (item.action.kind !== "update") continue;
    if (item.regime !== "cumulative") {
      refused.push(`${item.sessionId}：口径是 ${item.regime}，却带着可执行的改账值 —— 跳过项不许落账`);
      continue;
    }
    if (!item.cliSessionId) {
      refused.push(`${item.sessionId}：没有 cli_session_id，归不到线程，不许落账`);
      continue;
    }
    const after = item.action.after;
    if ([after.input, after.output, after.cacheRead, after.cacheWrite, after.reasoning].some((n) => n < 0)) {
      refused.push(`${item.sessionId}：重算出负数，不许落账`);
    }
  }
  return refused;
}

/**
 * 落地。返回的报告里 `committed` 才是「库真的改了」，调用方别按 `sessions > 0` 猜。
 */
export async function applyClaudeUsageRepair(
  plan: ClaudeUsageRepairPlan,
  options: { rewriteTraces?: boolean } = {},
): Promise<ApplyReport> {
  // ── ① 独立闸 ────────────────────────────────────────────────────────────────
  const refused = refuseUnwritable(plan);
  if (refused.length > 0) {
    return { sessions: 0, snapshots: 0, traces: EMPTY_TRACES, refused, rolledBack: 0, unresolved: null, committed: false };
  }

  // ── ② 预检：只算不写 ────────────────────────────────────────────────────────
  const prepared: PreparedTrace[] = [];
  const failures: string[] = [];
  const failedThreads = new Set<string>();
  if (options.rewriteTraces !== false) {
    for (const rewrite of plan.traces) {
      const result = prepareTraceRewrite(rewrite);
      if (typeof result === "string") {
        failures.push(result);
        failedThreads.add(rewrite.cliSessionId);
      } else prepared.push(result);
    }
  }
  // 一个失败集：同一条线程里有一份过不了，这条线程的另外几份也不写。
  const ready = prepared.filter((item) => !failedThreads.has(item.rewrite.cliSessionId));
  for (const item of prepared) {
    if (!failedThreads.has(item.rewrite.cliSessionId)) continue;
    failures.push(`${item.rewrite.taskId}/${item.rewrite.sessionId}：同一条 CLI 线程里有别的 trace 验不过，`
      + "整条线程这一轮不动（验过了也不写）");
  }
  const changes = plan.sessions.filter((item) =>
    item.action.kind === "update" && !(item.cliSessionId && failedThreads.has(item.cliSessionId)));
  const snapshotPlans = plan.snapshots.filter((item) => !failedThreads.has(threadOf(item.sourceId)));
  const traces: TraceCommitReport = {
    files: ready.length,
    entries: ready.reduce((sum, item) => sum + item.applied, 0),
    failures,
    failedThreads: [...failedThreads],
  };

  // ── ③ 提交：先 trace 后库，任何一步失败整体回滚 ─────────────────────────────
  const written: PreparedTrace[] = [];
  const rollback = (cause: string): ApplyReport => {
    const stuck: PreparedTrace[] = [];
    for (const item of written) {
      const error = restorePreparedTrace(item);
      if (error) {
        stuck.push(item);
        failures.push(error);
      }
    }
    let unresolved: string | null = null;
    if (stuck.length > 0) {
      const record = {
        at: new Date().toISOString(),
        threads: [...new Set(stuck.map((item) => item.rewrite.cliSessionId))],
        files: stuck.map((item) => item.path),
        reason: `${cause}；回滚时这几份 trace 没能还原回原内容，它们现在是改写后的真实增量、`
          + "而库里的账还是旧的（原文各有一份 .pre-usage-repair 备份）",
      };
      try {
        unresolved = writeUnresolvedRepair(record);
      } catch (error) {
        // 屏障**自己**也写不下去:这是最坏的一档 —— 没有任何东西能在下一次重跑时挡住这几
        // 条线程。绝不能静默,把该挡的线程和备份位置原样喊出来,交给人。
        failures.push(`隔离记录写不下去：${(error as Error).message}
`
          + `  必须人工处理的线程：${record.threads.join("、")}
`
          + `  已改写、没还原回去的文件：${record.files.join("、")}
`
          + "  在这几条线程核对清楚之前不要再跑这个脚本（原文各有一份 .pre-usage-repair 备份）。");
      }
    }
    return {
      sessions: 0,
      snapshots: 0,
      traces: { ...traces, files: written.length - stuck.length, failures },
      refused: [],
      rolledBack: written.length - stuck.length,
      unresolved,
      committed: false,
    };
  };

  for (const item of ready) {
    const error = writePreparedTrace(item);
    if (error) {
      failures.push(error);
      return rollback(error);
    }
    written.push(item);
  }

  const now = new Date().toISOString();
  const summary = {
    repairedAt: now,
    boundary: plan.boundary,
    sessions: changes.length,
    snapshots: snapshotPlans.length,
    traces: written.length,
  };
  try {
    await db.transaction(async (tx) => {
      for (const item of changes) {
        const usage = item.action.kind === "update" ? item.action.after : null;
        if (!usage) continue; // 走不到：①②两道闸已经保证了，这里只是让类型收窄
        await tx.update(sessions).set({
          usageInput: Math.round(usage.input),
          usageOutput: Math.round(usage.output),
          usageCacheRead: Math.round(usage.cacheRead),
          usageCacheWrite: Math.round(usage.cacheWrite),
          usageReasoning: Math.round(usage.reasoning),
          usageCostUsd: usage.costUsd,
          usageTurns: Math.max(1, Math.round(usage.turns)),
        }).where(eq(sessions.id, item.sessionId));
      }
      for (const snapshot of snapshotPlans) {
        const usage = snapshot.usage ?? ZERO;
        // onConflictDoNothing：运行期已经建过快照的线程归运行期，这里绝不覆盖。
        await tx.insert(usageCumulativeSnapshots).values({
          sourceId: snapshot.sourceId,
          input: Math.round(usage.input),
          output: Math.round(usage.output),
          cacheRead: Math.round(usage.cacheRead),
          cacheWrite: Math.round(usage.cacheWrite),
          reasoning: Math.round(usage.reasoning),
          costUsd: snapshot.usage ? usage.costUsd : null,
          baselineReady: snapshot.baselineReady,
          updatedAt: now,
        }).onConflictDoNothing();
      }
      await tx.insert(appSettings).values({ key: CLAUDE_REPAIR_MARKER, value: JSON.stringify(summary) })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(summary) } });
    });
  } catch (error) {
    // 库事务自己会回滚（node-sqlite-client 真的发 ROLLBACK），要收拾的是已经写下去的 trace。
    const cause = `库事务失败（${(error as Error).message}）`;
    failures.push(cause);
    return rollback(cause);
  }

  return {
    sessions: changes.length,
    snapshots: snapshotPlans.length,
    traces,
    refused: [],
    rolledBack: 0,
    unresolved: null,
    committed: true,
  };
}
