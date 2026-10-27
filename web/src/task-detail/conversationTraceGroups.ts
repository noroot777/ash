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

const USAGE_TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;

function legacyCumulativeDelta(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  const reset = !!previous && USAGE_TOKEN_KEYS.some((key) => current[key] < previous[key]);
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

/** 旧 codex trace 存的是线程累计快照,读侧按相邻两条求差还原本轮增量。 */
function rederive(trace: SessionTraceEntry[]): SessionTraceEntry[] {
  let previous: TokenUsage | null = null;
  return trace.map((entry) => {
    if (entry.event.kind !== "usage") return entry;
    if (entry.event.accounting !== undefined) return entry;
    const reported = entry.event.usage;
    const usage = legacyCumulativeDelta(reported, previous);
    previous = reported;
    return { ...entry, event: { ...entry.event, usage, accounting: "delta" as const } };
  });
}

/**
 * 气泡上那个「本轮」要显示的数字。**只认 `accounting` 这条逐事件的标记,不看数值形状。**
 *
 * - **codex**:7c274c0 之前的 trace 没有标记,存的是线程累计快照 —— 只有这一类要在读侧
 *   求差。有标记的(`incremental` / `delta` / `snapshot`)都是服务端已经结算过的本轮值。
 * - **claude**:全部照标记原样显示。口径修正之前的旧 trace 里存的确实是累计快照,但那批
 *   数据由**历史回填**(scripts/repair-claude-usage.ts)逐条改写成真实增量并补上 `delta`
 *   标记,不在这里猜。
 *
 * **为什么 claude 不能照 codex 那样在读侧求差**:claude 的旧 trace 一条不缺地都标着
 * `incremental`,标记在这里没有分辨力。上一版曾改用数据自身的形状判(整串不下降 + 末条
 * 等于会话汇总),被审查当场证伪:那个恒等式只对「已回填且此后没再续聊」的会话成立,
 * 随便续一轮新回合,汇总就不再等于末条,**整条历史的气泡会集体弹回累计值**(实测第 2 个
 * 气泡从正确的 81.9 万弹回 1726 万),而且跨 ash 会话行的线程永远凑不出这个恒等式。
 * 一条旧记录的含义不能随「以后会不会续聊」改变 —— 所以判据必须逐条落在数据里,
 * 由迁移去补,而不是在读侧推断。
 */
export function normalizedPersistedTrace(trace: SessionTraceEntry[], session: Session): SessionTraceEntry[] {
  return session.agentType === "codex" ? rederive(trace) : trace;
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
 * 一条 sentinel 之后，这一回合的 trace 实际从哪一刻起头。
 *
 * .md 里 sentinel 的时刻只是个**下界**：服务端先写时间线旁注，再去等会话空闲、动态
 * import、查冻结、解析执行器、prepareResume，最后才生成 `turnStart` 落进 trace —— 中间
 * 隔上几秒是正常路径。一超出 `traceGroupKey` 那点兜底窗口，这一回合的正文就领不到自己
 * 那一组事件：正文一颗气泡、工具掉进另一颗「无正文兜底气泡」，看着又是「旁注把回合劈成
 * 两半」（第 2 轮审查报的）。
 *
 * 取 `[sentinelAt, until)` 里**最早**的那一组：`until` 是 .md 给出的下一个切点，越过它就
 * 是别人的回合了。常规情形下 splitTraceGroupAt 已经在 sentinel 处建好组，找到的就是
 * sentinel 自己那一刻，行为不变；一组都够不着就返回 null，仍按 sentinel 的时刻走。
 */
export function traceTurnStartAt(
  groups: Map<string, SessionTraceEntry[]>,
  consumed: Set<string>,
  sentinelAt: string,
  until?: string,
): string | null {
  const start = Date.parse(sentinelAt);
  if (!Number.isFinite(start)) return null;
  const boundary = until ? Date.parse(until) : Number.NaN;
  const limit = Number.isFinite(boundary) ? boundary : Number.POSITIVE_INFINITY;
  return [...groups.keys()]
    .filter((key) => !consumed.has(key))
    .map((key) => ({ key, at: Date.parse(key) }))
    .filter(({ at }) => Number.isFinite(at) && at >= start && at < limit)
    .sort((left, right) => left.at - right.at)
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
