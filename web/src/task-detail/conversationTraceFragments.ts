// 没有正文、只剩执行过程的回合 —— 从 conversationModel.ts 拆出来（单文件 700 行的约定）。
import type { Session } from "@ash/shared";
import { traceKeptOnDelete, type ConvSeg } from "@ash/shared/session-output";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { reviewerOf, traceVerifyRound } from "./conversationReviewer.ts";
import { contentSegments } from "./conversationSegments.ts";
import { traceRun, traceUsage } from "./conversationTraceGroups.ts";
import { traceSpanSource } from "./conversationTraceSources.ts";
import { agentLabel, compactTurnText, sessionRun } from "./conversationTurnParts.ts";

/**
 * 把没被任何正文段认领的 trace 组铺成「执行过程」气泡，追加到 `items` 末尾。
 *
 * 这种气泡在 .md 里没有对应的段，删除时按它在 trace 里占的时间段指名（`sources` 的 trace
 * 那一种，服务端在 server/src/conversation-redact.ts 按同一时间段重算指纹；`sessionTrace` /
 * `readSide` 是整条 trace 和其中读侧补出来的那几条，见 conversationTraceSources）。
 */
export function appendTraceFragments(
  items: ConversationItem[],
  session: Session,
  segments: readonly ConvSeg[],
  traceGroups: Map<string, SessionTraceEntry[]>,
  consumedTrace: Set<string>,
  sessionTrace: readonly SessionTraceEntry[],
  readSide: ReadonlySet<SessionTraceEntry>,
): void {
  // A failed turn can contain only tools/errors and no assistant prose. Keep
  // its execution block visible instead of dropping the persisted trace.
  //
  // 另一类没有正文的组是**同一个回合的碎片**:常驻调度台被 CLI 自己唤醒续跑(后台监控
  // 回调)时,服务端补上回合起点之前落的 trace,每条事件都拿自己的时刻当回合起点(修在
  // server/src/team/session-consumer.ts,老数据仍是碎的)。一条条渲染就是一串「1 工具」
  // 的空气泡。它们的共同特征是**没有 run 事件** —— 真回合起点一定写 run —— 所以顺着
  // 时间粘回同一条,直到下一个 run 或下一段已经有正文的回合。
  // 正文的权威来源只有 .md:兜底气泡里的 text 事件多半已经被上面某条气泡渲染过了
  // （回合边界对不上时,同一段话会同时落在 .md 段落和无人认领的 trace 组里）。原样带
  // 上就是一段话连说两遍,所以只留执行过程。
  const persistedProse = segments
    .filter((segment) => segment.kind === "agent")
    .map((segment) => compactTurnText(segment.text))
    .join("\0");
  const withoutEchoedProse = (entries: SessionTraceEntry[]): SessionTraceEntry[] => entries.filter((entry) => {
    if (entry.event.kind !== "text") return true;
    const compact = compactTurnText(entry.event.text);
    return !!compact && !persistedProse.includes(compact);
  });
  let fragment: { turn: string; entries: SessionTraceEntry[] } | null = null;
  const flushFragment = (): void => {
    const pending = fragment;
    fragment = null;
    if (!pending) return;
    const entries = withoutEchoedProse(pending.entries);
    if (!entries.some((entry) => !traceKeptOnDelete(entry.event.kind))) return;
    const traceSegments = contentSegments(entries, "", `persisted:trace-segment:${session.id}:${pending.turn}`);
    // 指名用整组原样的事件（含被当成复读滤掉的正文）：服务端那边看到的就是这一份，这颗气泡
    // 领到的也就是这一份。
    const source = traceSpanSource(session.id, sessionTrace, readSide, pending.entries);
    items.push({
      kind: "agent",
      id: `persisted:trace:${session.id}:${pending.turn}`,
      sessionId: session.id,
      label: agentLabel(session),
      agentType: session.agentType,
      // 起点取第一条实质事件:被丢掉的复读正文往往比工具早好几分钟,拿组的 key 当起点
      // 会把「模型在写字」的时间算进这条执行过程的用时里。
      at: entries.find((entry) => entry.event.kind !== "usage")?.at ?? pending.turn,
      endedAt: null,
      markerEndedAt: null,
      session,
      run: traceRun(entries) ?? sessionRun(session),
      reviewer: reviewerOf(traceVerifyRound(entries), session?.role),
      usage: traceUsage(entries),
      markdown: traceSegments.map((segment) => segment.markdown).join(""),
      segments: traceSegments,
      // 走到这里组里一定有可删事件（上面那道），出处一定有。
      sources: [source!],
    });
  };
  for (const [traceTurn, entries] of [...traceGroups].sort(([left], [right]) => Date.parse(left) - Date.parse(right))) {
    if (consumedTrace.has(traceTurn) || entries.some((entry) => entry.event.kind === "run")) flushFragment();
    if (consumedTrace.has(traceTurn)) continue;
    if (fragment) fragment.entries.push(...entries);
    else fragment = { turn: traceTurn, entries: [...entries] };
  }
  flushFragment();
}
