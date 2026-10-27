// Token 用量的落库单点。**claude 的 result 和 codex 的 turn.completed 都是整条 CLI
// 线程的累计快照**，必须先跟上一份快照求差再加；直接相加的话，续聊第 N 回合会把前
// N 回合的总和当成本轮增量入账，账面随回合数二次方虚高（实测会话 au43oEY7kLkf 账面
// 46.5 亿 token、真实累计 1.78 亿，虚高 26 倍）。归一后的单轮用量也由这里返回给
// trace/UI，**并且带上「这一份是怎么来的」那个标记**(shared 的 UsageAccountingMark)：
// 读侧和历史回填都只认这个标记，不许看数值形状猜口径。
//
// **这个文件里还住着上下文水位（setSessionContext），它是覆盖式的**——两组列摆在
// 一起是为了让下一个人一眼看见「有两种账，加法只适用于其中一种」。
import { eq, sql } from "drizzle-orm";
import type { AgentEvent, AgentType, ContextUsage, TokenUsage, UsageAccountingMark } from "@ash/shared";
import { db } from "./db/index.js";
import { sessions, usageCumulativeSnapshots } from "./db/schema.js";

type SessionRow = typeof sessions.$inferSelect;
type UsageEvent = Extract<AgentEvent, { kind: "usage" }>;
export type UsageAccounting =
  | { kind: "incremental" }
  | { kind: "cumulative"; sourceId: string };

/**
 * 入账结果 = 记进会话行的那一份数字 + **它是怎么来的**。
 *
 * 标记不是给人看的注释,是下游唯一的判据:读侧靠它决定要不要再求一次差,历史回填靠它
 * 分「口径修正之前落盘的旧账」和「修好之后结算过的账」。所以它必须由**真正走过的那条
 * 分支**产出,不能在外面按 accounting.kind 猜一个(猜的话就分不出有没有基线)。
 */
export type BookedUsage = { usage: TokenUsage; accounting: UsageAccountingMark };

const roundedUsage = (usage: TokenUsage): TokenUsage => ({
  input: Math.round(usage.input),
  output: Math.round(usage.output),
  cacheRead: Math.round(usage.cacheRead),
  cacheWrite: Math.round(usage.cacheWrite),
  reasoning: Math.round(usage.reasoning),
  costUsd: usage.costUsd,
  turns: Math.max(1, Math.round(usage.turns)),
});

/**
 * 累计计数器回退表示 CLI 换了线程/重置了账本；此时整份当前值都是新增。
 *
 * 这一条同时是 claude 侧两件事的处理方式，都不需要额外机关：
 * ① **压缩/续聊换了线程 id**：`single-run` 在 `session` 事件里当场把 cliSessionId 换成
 *    新的（并写回会话行），于是 sourceId 也跟着换 —— 新 sourceId 没有快照，这一轮整份
 *    入账，正是新线程第一轮该有的结果。
 * ② **CLI 在同一个 id 上重置了计数器**：值比上一份小，走这里的 reset 分支整份入账。
 */
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

/**
 * 哪些执行器报的是**线程累计快照**。
 *
 * claude 和 codex 都在这张表里，判据是实测而不是文档：同一条 CLI 会话连续若干回合的
 * `result` 行单调递增、`total_cost_usd` 一路累加（$155.69 → $158.99 → $161.10），而
 * 相邻两条的**差值**才等于那一回合真实打出去的几个请求。
 *
 * **claude 不是一直这样**：2026-09-28 那次 CLI 升级之前，每次 `claude -p --resume`
 * 的 `result` 只结算本次进程内的用量（库里 2026-09-27 之前的 108 条多轮会话无一例外
 * 可以看到序列上下起伏），升级之后才变成跨 resume 的线程累计。所以按累计口径跑在那种
 * 老 CLI 上会**少记**（上升的那几轮只记差值），但不会再像现在这样虚高几十倍——两种
 * 错里这是可接受的那一种，何况那条路已经是一年前的历史。真要回到老 CLI，看 reset 分支
 * 下面那段说明。
 *
 * **claude 的 fork（copilot / cursor / gemini / qwen… 走 claudeStreamJsonParser 那批）
 * 刻意不在表里**：它们继承的是输出 schema，不等于继承这版累计语义，而库里这些执行器
 * 一条报账记录都没有（`claudeUsage` 要 `result` 里真有 usage/modelUsage 才发事件）。
 * 没有证据就不改口径——哪天它们真开始报账，再按同样的方法测一遍再加进来。
 */
const CUMULATIVE_RESULT_CLIS: ReadonlySet<AgentType> = new Set<AgentType>(["claude", "codex"]);

/**
 * sourceId 按 **CLI 自己的线程 id** 而不是 ash 会话行分组：同一条 CLI 线程可能跨多个
 * ash 行（讨论模式的各声部、审查旁路回合），只有按线程才算得出正确的本轮差值。
 *
 * 拿不到 cliSessionId 时退回逐轮相加 —— 没有线程身份就没有「上一份快照」可言，求差
 * 会把别人的账算到自己头上。
 */
export function usageAccountingFor(agentType: AgentType, cliSessionId: string | null | undefined): UsageAccounting {
  return cliSessionId && CUMULATIVE_RESULT_CLIS.has(agentType)
    ? { kind: "cumulative", sourceId: `${agentType}:${cliSessionId}` }
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
): Promise<BookedUsage> {
  const reported = roundedUsage(usage);
  try {
    return await db.transaction(async (tx) => {
      let booked = reported;
      let mark: UsageAccountingMark = "incremental";
      if (accounting.kind === "cumulative") {
        const row = await tx.select().from(usageCumulativeSnapshots)
          .where(eq(usageCumulativeSnapshots.sourceId, accounting.sourceId)).get();
        // 没有快照行 = 这条线程在本库里**没有可用基线**,整份当前值入账。对真·新线程这就
        // 是对的;对「口径修正之前已有历史的老线程」则多记了一整份,所以标 snapshot 把
        // 这个事实留在 trace 里,让历史回填凭标记纠偏(别让它去猜数值大不大)。
        mark = row ? "delta" : "snapshot";
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
      return { usage: booked, accounting: mark };
    });
  } catch (error) {
    // 账本坏了只好把执行器报的原值透传。**标记跟着退回 incremental**:这一份没走过累计
    // 结算,不能冒充 delta 骗过下游的求差。
    console.warn(`[ash] failed to record token usage for session ${sessId}:`, error);
    return { usage: reported, accounting: "incremental" };
  }
}

/**
 * 把执行器事件归一成“本轮增量”，让数据库、实时 UI 和 trace 使用同一份数字。
 *
 * **返回的事件带着入账分支的标记**(delta / snapshot / incremental),落 trace 时一并写下。
 * 这是读侧和历史回填唯一可靠的口径证据 —— 旧实现对所有事件一律标 `incremental`,于是
 * 「已结算的增量」和「口径修正之前的旧累计值」在 trace 里长得一模一样,只能靠猜。
 */
export async function recordSessionUsageEvent(
  sessId: string,
  event: UsageEvent,
  agentType: AgentType,
  cliSessionId: string | null | undefined,
): Promise<UsageEvent> {
  const booked = await addSessionUsage(sessId, event.usage, usageAccountingFor(agentType, cliSessionId));
  return { ...event, usage: booked.usage, accounting: booked.accounting };
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
