// 压缩上下文不是它说的话（docs/ui-ux-audit run-9）：它是执行过程里它发生的那个位置上的一步——
// 压着的时候是「在压缩上下文」（进行条那一行跟着说），压完并成一行「压缩了上下文」；被 PreCompact
// hook 拦下、没压的那一次说「压缩被拦下」。没压成的那一次是一条红色异常，照旧是红的。
//
// 来源只认服务端的结构化事件（error 事件上的 `compaction`，见 shared/src/events.ts），**正文永远是
// 正文**：智能体解释压缩日志时引一句「正在压缩上下文…」再正常不过，一个字都不许动。
//
// 旧会话里服务端当年插进正文的那两句引用不转换，照原样显示成引用：正文里认不出哪一句是服务端
// 插的（同一句话可能是智能体写的、可能被切在两个文字块里，trace 里也会跟前后的正文攒成一条），
// 猜错一次就是删掉用户要看的内容（第 1、2 轮审查）。
import type { CompactionPhase } from "@ash/shared";
import type { ExecutionEvent } from "./executionTrace.ts";

export const COMPACT_LABEL = "压缩上下文";
export const COMPACTING = "在压缩上下文";
export const COMPACTED = "压缩了上下文";
export const COMPACT_SKIPPED = "压缩被拦下";

export function isCompactionEvent(event: ExecutionEvent): boolean {
  return event.kind === "notice" && event.label === COMPACT_LABEL;
}

const DETAIL: Record<Exclude<CompactionPhase, "failed">, string> = {
  start: COMPACTING,
  done: COMPACTED,
  cancelled: COMPACT_SKIPPED,
};

export function compactionEvent(phase: Exclude<CompactionPhase, "failed">, at?: string): ExecutionEvent {
  return { kind: "notice", label: COMPACT_LABEL, detail: DETAIL[phase], ...(at ? { at } : {}) };
}

/**
 * 压完（或被拦下）的那一步并进紧挨着的「在压缩」：中间一步都没有时，两行说的是同一件事。
 * 中间隔着别的步骤就各留各的（那段时间里确实发生了别的事）。
 */
export function mergeCompaction(events: readonly ExecutionEvent[], event: ExecutionEvent): ExecutionEvent[] | null {
  if (!isCompactionEvent(event) || event.detail === COMPACTING) return null;
  const previous = events.at(-1);
  if (!previous || !isCompactionEvent(previous) || previous.detail !== COMPACTING) return null;
  return [...events.slice(0, -1), { ...previous, detail: event.detail }];
}
