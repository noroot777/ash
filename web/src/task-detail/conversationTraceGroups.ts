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
 * 领取一个回合的 trace。原生引导会在同一个 turnStartedAt 中插入 user sentinel；
 * 此时把 sentinel 之后的事件重新挂到用户时间，供后一个 agent 段或无正文兜底气泡领取。
 */
export function takeTraceGroup(
  groups: Map<string, SessionTraceEntry[]>,
  consumed: Set<string>,
  turnStartedAt: string,
  userBoundary?: string,
): SessionTraceEntry[] {
  const key = traceGroupKey(groups, consumed, turnStartedAt);
  if (!key) return [];
  const entries = groups.get(key) ?? [];
  const boundary = userBoundary ? Date.parse(userBoundary) : Number.NaN;
  if (!Number.isFinite(boundary)) {
    consumed.add(key);
    return entries;
  }

  const earlier = entries.filter((entry) => Date.parse(entry.at) < boundary);
  const later = entries.filter((entry) => Date.parse(entry.at) >= boundary);
  consumed.add(key);
  if (later.length && userBoundary) {
    const next = [...(groups.get(userBoundary) ?? []), ...later]
      .sort((left, right) => left.at.localeCompare(right.at));
    groups.set(userBoundary, next);
    consumed.delete(userBoundary);
  }
  return earlier;
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
