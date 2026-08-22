// Token 用量的落库单点。Claude 的 result 是本轮增量，直接加；Codex 的
// turn.completed 是整条 CLI 线程的累计快照，必须先跟上一份快照求差再加。两者如果
// 混成一种语义，续聊越多账就会越虚高。归一后的单轮用量也由这里返回给 trace/UI。
//
// **这个文件里还住着上下文水位（setSessionContext），它是覆盖式的**——两组列摆在
// 一起是为了让下一个人一眼看见「有两种账，加法只适用于其中一种」。
import { eq, sql } from "drizzle-orm";
import type { AgentEvent, AgentType, ContextUsage, TokenUsage } from "@ash/shared";
import { db } from "./db/index.js";
import { sessions, usageCumulativeSnapshots } from "./db/schema.js";

type SessionRow = typeof sessions.$inferSelect;
type UsageEvent = Extract<AgentEvent, { kind: "usage" }> & { accounting?: "incremental" };
export type UsageAccounting =
  | { kind: "incremental" }
  | { kind: "cumulative"; sourceId: string };

const roundedUsage = (usage: TokenUsage): TokenUsage => ({
  input: Math.round(usage.input),
  output: Math.round(usage.output),
  cacheRead: Math.round(usage.cacheRead),
  cacheWrite: Math.round(usage.cacheWrite),
  reasoning: Math.round(usage.reasoning),
  costUsd: usage.costUsd,
  turns: Math.max(1, Math.round(usage.turns)),
});

/** 累计计数器回退表示 CLI 换了线程/重置了账本；此时整份当前值都是新增。 */
export function cumulativeUsageDelta(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  const now = roundedUsage(current);
  const reset = !!previous && (
    now.input < previous.input
    || now.output < previous.output
    || now.cacheRead < previous.cacheRead
    || now.cacheWrite < previous.cacheWrite
    || now.reasoning < previous.reasoning
  );
  if (!previous || reset) return { ...now, turns: 1 };
  return {
    input: now.input - previous.input,
    output: now.output - previous.output,
    cacheRead: now.cacheRead - previous.cacheRead,
    cacheWrite: now.cacheWrite - previous.cacheWrite,
    reasoning: now.reasoning - previous.reasoning,
    costUsd: now.costUsd === null
      ? null
      : previous.costUsd === null || now.costUsd < previous.costUsd
        ? now.costUsd
        : now.costUsd - previous.costUsd,
    turns: 1,
  };
}

export function usageAccountingFor(agentType: AgentType, cliSessionId: string | null | undefined): UsageAccounting {
  return agentType === "codex" && cliSessionId
    ? { kind: "cumulative", sourceId: `codex:${cliSessionId}` }
    : { kind: "incremental" };
}

/**
 * 把这一回合的账加到会话行上。**best-effort**：账本坏了不能反过来改变 agent 的
 * 执行结果，所以这里自己吞异常，只留一条 warn。
 */
export async function addSessionUsage(
  sessId: string,
  usage: TokenUsage,
  accounting: UsageAccounting = { kind: "incremental" },
): Promise<TokenUsage> {
  const reported = roundedUsage(usage);
  try {
    return await db.transaction(async (tx) => {
      let booked = reported;
      if (accounting.kind === "cumulative") {
        const row = await tx.select().from(usageCumulativeSnapshots)
          .where(eq(usageCumulativeSnapshots.sourceId, accounting.sourceId)).get();
        booked = row && !row.baselineReady
          ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 }
          : cumulativeUsageDelta(reported, row
            ? {
              input: row.input,
              output: row.output,
              cacheRead: row.cacheRead,
              cacheWrite: row.cacheWrite,
              reasoning: row.reasoning,
              costUsd: row.costUsd,
              turns: 1,
            }
            : null);
        await tx.insert(usageCumulativeSnapshots).values({
          sourceId: accounting.sourceId,
          input: reported.input,
          output: reported.output,
          cacheRead: reported.cacheRead,
          cacheWrite: reported.cacheWrite,
          reasoning: reported.reasoning,
          costUsd: reported.costUsd,
          baselineReady: true,
          updatedAt: new Date().toISOString(),
        }).onConflictDoUpdate({
          target: usageCumulativeSnapshots.sourceId,
          set: {
            input: reported.input,
            output: reported.output,
            cacheRead: reported.cacheRead,
            cacheWrite: reported.cacheWrite,
            reasoning: reported.reasoning,
            costUsd: reported.costUsd,
            baselineReady: true,
            updatedAt: new Date().toISOString(),
          },
        });
      }
      await tx.update(sessions).set({
        usageInput: sql`COALESCE(${sessions.usageInput}, 0) + ${booked.input}`,
        usageOutput: sql`COALESCE(${sessions.usageOutput}, 0) + ${booked.output}`,
        usageCacheRead: sql`COALESCE(${sessions.usageCacheRead}, 0) + ${booked.cacheRead}`,
        usageCacheWrite: sql`COALESCE(${sessions.usageCacheWrite}, 0) + ${booked.cacheWrite}`,
        usageReasoning: sql`COALESCE(${sessions.usageReasoning}, 0) + ${booked.reasoning}`,
        usageCostUsd: booked.costUsd === null
          ? sql`${sessions.usageCostUsd}`
          : sql`COALESCE(${sessions.usageCostUsd}, 0) + ${booked.costUsd}`,
        usageTurns: sql`COALESCE(${sessions.usageTurns}, 0) + ${booked.turns}`,
      }).where(eq(sessions.id, sessId));
      return booked;
    });
  } catch (error) {
    console.warn(`[ash] failed to record token usage for session ${sessId}:`, error);
    return reported;
  }
}

/** 把执行器事件归一成“本轮增量”，让数据库、实时 UI 和 trace 使用同一份数字。 */
export async function recordSessionUsageEvent(
  sessId: string,
  event: UsageEvent,
  agentType: AgentType,
  cliSessionId: string | null | undefined,
): Promise<UsageEvent> {
  const usage = await addSessionUsage(sessId, event.usage, usageAccountingFor(agentType, cliSessionId));
  return { ...event, usage, accounting: "incremental" };
}

/**
 * 上下文水位落库。**覆盖不累加** —— 这是这个函数跟 `addSessionUsage` 唯一但要命的
 * 区别：水位是「此刻装了多少」，累加它会得出一个没有物理意义的数。
 *
 * 同样 best-effort：账本坏了不能反过来改变 agent 的执行结果。
 */
export async function setSessionContext(sessId: string, context: ContextUsage): Promise<void> {
  try {
    // used=0 是执行器明确声明“本轮没采到”的哨兵（shared 的 hasContext 也按此判断）。
    // 必须把库里的旧值清空，否则格式变化后界面仍会展示上一轮陈旧水位。
    const measured = context.used > 0;
    await db
      .update(sessions)
      .set({
        contextUsed: measured ? Math.round(context.used) : null,
        contextWindow: measured && context.window !== null ? Math.round(context.window) : null,
        contextWindowEstimated: measured ? context.windowEstimated : null,
      })
      .where(eq(sessions.id, sessId));
  } catch (error) {
    console.warn(`[ash] failed to record context usage for session ${sessId}:`, error);
  }
}

/** 从本会话固化的 `--settings` 中读回当时真正注入的自动压缩窗口。 */
export function sessionCompactWindow(resumeArgs: string | null | undefined): number | null {
  const raw = resumeArgs?.match(/"CLAUDE_CODE_AUTO_COMPACT_WINDOW"\s*:\s*"(\d+)"/)?.[1];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** 会话行 → ContextUsage。没采到(null)跟「水位是 0」是两回事，前者不显示。 */
export function sessionContext(row: Pick<
  SessionRow,
  "contextUsed" | "contextWindow" | "contextWindowEstimated" | "resumeArgs"
>): ContextUsage | null {
  if (row.contextUsed === null || row.contextUsed === undefined) return null;
  const compactWindow = sessionCompactWindow(row.resumeArgs);
  return {
    used: row.contextUsed,
    window: row.contextWindow ?? null,
    windowEstimated: row.contextWindowEstimated ?? false,
    ...(compactWindow !== null ? { compactWindow } : {}),
  };
}

/**
 * 会话行 → TokenUsage。**全 null 返回 null**：这条会话建在本功能之前、或那家
 * CLI 不报账，跟「真的花了 0 个 token」是两回事，展示端要能区分。
 */
export function sessionUsage(row: Pick<
  SessionRow,
  "usageInput" | "usageOutput" | "usageCacheRead" | "usageCacheWrite" | "usageReasoning" | "usageCostUsd" | "usageTurns"
>): TokenUsage | null {
  const measured = row.usageInput ?? row.usageOutput ?? row.usageCacheRead ?? row.usageCacheWrite ?? row.usageTurns;
  if (measured === null || measured === undefined) return null;
  return {
    input: row.usageInput ?? 0,
    output: row.usageOutput ?? 0,
    cacheRead: row.usageCacheRead ?? 0,
    cacheWrite: row.usageCacheWrite ?? 0,
    reasoning: row.usageReasoning ?? 0,
    costUsd: row.usageCostUsd ?? null,
    turns: row.usageTurns ?? 0,
  };
}
