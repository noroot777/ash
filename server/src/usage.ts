// Token 用量的落库单点。执行器报的每一笔（一回合一条 `usage` 事件）都经这里
// 累加到会话行上，读取侧再从同一组列拼回 TokenUsage。
//
// 为什么累加而不是覆盖：一条 sessions 行会被复用（`--resume` 续跑、常驻调度台的
// 每个回合都记在同一行），跟 active_ms 是同一副形状——那一列也是每回合往上加。
// 单轮的用量另有去处（trace，见 transcript.ts），刷新后按回合回放。
import { eq, sql } from "drizzle-orm";
import type { TokenUsage } from "@harness/shared";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";

type SessionRow = typeof sessions.$inferSelect;

/**
 * 把这一回合的账加到会话行上。**best-effort**：账本坏了不能反过来改变 agent 的
 * 执行结果，所以这里自己吞异常，只留一条 warn。
 */
export async function addSessionUsage(sessId: string, usage: TokenUsage): Promise<void> {
  try {
    await db
      .update(sessions)
      .set({
        usageInput: sql`COALESCE(${sessions.usageInput}, 0) + ${Math.round(usage.input)}`,
        usageOutput: sql`COALESCE(${sessions.usageOutput}, 0) + ${Math.round(usage.output)}`,
        usageCacheRead: sql`COALESCE(${sessions.usageCacheRead}, 0) + ${Math.round(usage.cacheRead)}`,
        usageCacheWrite: sql`COALESCE(${sessions.usageCacheWrite}, 0) + ${Math.round(usage.cacheWrite)}`,
        usageReasoning: sql`COALESCE(${sessions.usageReasoning}, 0) + ${Math.round(usage.reasoning)}`,
        // 费用只加确实报了价的那部分：codex 不报价，别把它的回合算成 $0 混进总额。
        usageCostUsd: usage.costUsd === null
          ? sql`${sessions.usageCostUsd}`
          : sql`COALESCE(${sessions.usageCostUsd}, 0) + ${usage.costUsd}`,
        usageTurns: sql`COALESCE(${sessions.usageTurns}, 0) + ${Math.max(1, Math.round(usage.turns))}`,
      })
      .where(eq(sessions.id, sessId));
  } catch (error) {
    console.warn(`[harness] failed to record token usage for session ${sessId}:`, error);
  }
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
