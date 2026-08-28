import type { Session, TokenUsage } from "@ash/shared";
import { sumUsage } from "@ash/shared/usage";
import type { SessionTraceEntry } from "../lib/api.ts";

export function groupedTrace(trace: SessionTraceEntry[]): Map<string, SessionTraceEntry[]> {
  const groups = new Map<string, SessionTraceEntry[]>();
  for (const entry of trace) {
    const current = groups.get(entry.turnStartedAt) ?? [];
    current.push(entry);
    groups.set(entry.turnStartedAt, current);
  }
  return groups;
}

function legacyCodexUsageDelta(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  const reset = !!previous && (
    current.input < previous.input
    || current.output < previous.output
    || current.cacheRead < previous.cacheRead
    || current.cacheWrite < previous.cacheWrite
    || current.reasoning < previous.reasoning
  );
  if (!previous || reset) return { ...current, turns: 1 };
  return {
    input: current.input - previous.input,
    output: current.output - previous.output,
    cacheRead: current.cacheRead - previous.cacheRead,
    cacheWrite: current.cacheWrite - previous.cacheWrite,
    reasoning: current.reasoning - previous.reasoning,
    costUsd: null,
    turns: 1,
  };
}

// 7c274c0 之前的 Codex trace 保存的是 turn.completed 的线程累计快照。sessions 汇总
// 已由启动迁移校正；旧气泡仍需在读侧求差，新 trace 的 accounting 恒为 incremental。
export function normalizedPersistedTrace(trace: SessionTraceEntry[], session: Session): SessionTraceEntry[] {
  if (session.agentType !== "codex") return trace;
  let previous: TokenUsage | null = null;
  return trace.map((entry) => {
    if (entry.event.kind !== "usage" || entry.event.accounting === "incremental") return entry;
    const usage = legacyCodexUsageDelta(entry.event.usage, previous);
    previous = entry.event.usage;
    return { ...entry, event: { ...entry.event, usage, accounting: "incremental" } };
  });
}

function traceGroupKey(
  groups: Map<string, SessionTraceEntry[]>,
  consumed: Set<string>,
  turnStartedAt: string,
): string | null {
  if (groups.has(turnStartedAt) && !consumed.has(turnStartedAt)) return turnStartedAt;
  // Older in-flight sessions may have written the user sentinel and run start a
  // few milliseconds apart. Keep the fallback narrow so separate replies do not merge.
  const target = Date.parse(turnStartedAt);
  return [...groups.keys()]
    .filter((key) => !consumed.has(key))
    .map((key) => ({ key, distance: Math.abs(Date.parse(key) - target) }))
    .filter(({ distance }) => Number.isFinite(distance) && distance <= 2_000)
    .sort((left, right) => left.distance - right.distance)
    .at(0)?.key ?? null;
}

/**
 * 在一次真人插话处切开仍在飞的那一组 trace：插话之后的事件重新挂到插话时间上，
 * 好让插话后那一段发言（或没有正文时的兜底气泡）领得到。
 *
 * 原生引导**不结束回合**，sentinel 之后的事件仍带着老的 turnStartedAt 落盘，所以这刀
 * 只能由读端来切。切点只认「插话」这件事本身，不看插话前后有没有正文 —— 引导多半正好
 * 落在 agent 连着跑工具、一个字还没吐的时候，那一段根本没有 .md 正文可以充当切分时机。
 * 不切的后果是整组连正文带工具落进「无正文兜底气泡」，跟插话后那段 .md 正文一模一样地
 * 重复渲染一遍（用户看到的就是引导消息上下各一份相同回复）。
 */
export function splitTraceGroupAt(
  groups: Map<string, SessionTraceEntry[]>,
  consumed: Set<string>,
  turnStartedAt: string,
  boundaryAt: string,
): void {
  const key = traceGroupKey(groups, consumed, turnStartedAt);
  if (!key || key === boundaryAt) return;
  const boundary = Date.parse(boundaryAt);
  if (!Number.isFinite(boundary)) return;
  const entries = groups.get(key) ?? [];
  const later = entries.filter((entry) => Date.parse(entry.at) >= boundary);
  if (!later.length) return;
  const earlier = entries.filter((entry) => Date.parse(entry.at) < boundary);
  // 切完空掉就把键删了：留一个空组会让后面的 ±2 秒兜底挑中它，从而领到一手空 trace。
  if (earlier.length) groups.set(key, earlier);
  else groups.delete(key);
  const createdBoundaryGroup = !groups.has(boundaryAt);
  groups.set(
    boundaryAt,
    [...(groups.get(boundaryAt) ?? []), ...later].sort((left, right) => left.at.localeCompare(right.at)),
  );
  // 只放开本次新建的组。已有组若早已被上游气泡消费，不能因为这次拆分重新开放，
  // 否则同一批 trace 会被后面的 agent 段再领一次。
  if (createdBoundaryGroup) consumed.delete(boundaryAt);
}

/**
 * 领取一个回合的 trace。切分已由 splitTraceGroupAt 在发放之前一次做完，这里只负责
 * 认领；`userBoundary` 纯粹是道闸：±2 秒兜底若正好挑中下一段插话自己的那一组，当前段
 * 不能领走它。
 */
export function takeTraceGroup(
  groups: Map<string, SessionTraceEntry[]>,
  consumed: Set<string>,
  turnStartedAt: string,
  userBoundary?: string,
): SessionTraceEntry[] {
  const key = traceGroupKey(groups, consumed, turnStartedAt);
  if (!key || key === userBoundary) return [];
  consumed.add(key);
  return groups.get(key) ?? [];
}

export function traceUsage(entries: SessionTraceEntry[]): TokenUsage | null {
  return sumUsage(entries.map((entry) => (entry.event.kind === "usage" ? entry.event.usage : null)));
}

export function traceRun(
  entries: SessionTraceEntry[],
): { model: string | null; reasoningEffort: string | null } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event;
    if (event?.kind === "run") return { model: event.model, reasoningEffort: event.reasoningEffort };
  }
  return undefined;
}
