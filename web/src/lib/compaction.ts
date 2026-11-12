// 压缩上下文不是它说的话（docs/ui-ux-audit run-9）：它是执行过程里它发生的那个位置上的一步——
// 压着的时候是「在压缩上下文」（进行条那一行跟着说），压完并成一行「压缩了上下文」。没压成的
// 那一次是一条红色异常，照旧是红的。
//
// 来源只认服务端的结构化事件（error 事件上的 `compaction`，见 shared/src/events.ts），不从正文
// 里找：正文是智能体说的话，它解释压缩日志时引一句「正在压缩上下文…」再正常不过。
//
// 旧会话例外：从前服务端把开始/压完写成**一条独立的正文事件**（一整串固定的引用，见下面的
// LEGACY）。只有 trace 里整条正文恰好就是这一串时才认它——那是服务端插的，不是智能体写的；
// 同一句出现在智能体自己那条正文里（代码块、引用、段落中间）一律原样留着。
import type { CompactionPhase } from "@ash/shared";
import type { ExecutionEvent } from "./executionTrace.ts";

export const COMPACT_LABEL = "压缩上下文";
export const COMPACTING = "在压缩上下文";
export const COMPACTED = "压缩了上下文";

export function isCompactionEvent(event: ExecutionEvent): boolean {
  return event.kind === "notice" && event.label === COMPACT_LABEL;
}

export function compactionEvent(phase: Exclude<CompactionPhase, "failed">, at?: string): ExecutionEvent {
  return { kind: "notice", label: COMPACT_LABEL, detail: phase === "start" ? COMPACTING : COMPACTED, ...(at ? { at } : {}) };
}

/**
 * 压完的那一步并进紧挨着的「在压缩」：中间一步都没有时，两行说的是同一件事。
 * 中间隔着别的步骤就各留各的（那段时间里确实发生了别的事）。
 */
export function mergeCompaction(events: readonly ExecutionEvent[], event: ExecutionEvent): ExecutionEvent[] | null {
  if (!isCompactionEvent(event) || event.detail !== COMPACTED) return null;
  const previous = events.at(-1);
  if (!previous || !isCompactionEvent(previous) || previous.detail !== COMPACTING) return null;
  return [...events.slice(0, -1), { ...previous, detail: COMPACTED }];
}

const LEGACY: Record<string, Exclude<CompactionPhase, "failed">> = {
  "\n> 正在压缩上下文…\n\n": "start",
  "\n> 上下文已压缩。\n\n": "done",
};

/** 这条正文事件是不是旧服务端插的那一串（整条恰好相等才算）。 */
export function legacyCompactionPhase(text: string): Exclude<CompactionPhase, "failed"> | null {
  return LEGACY[text] ?? null;
}

/** 旧服务端那一串在正文里换成什么：一个段落分隔，前后两段各自成块。trace 与 `.md` 两边换成同一个。 */
export const LEGACY_COMPACTION_GAP = "\n\n";

const LEGACY_LINE = /(^|\n)> (?:正在压缩上下文…|上下文已压缩。)(?:\n\n?|$)/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 从落盘正文（`.md`）里摘掉旧服务端插的那几句——**只摘 trace 认出来的那么多处**，按出现顺序，
 * 而且跳过代码块里的：同一回合里智能体自己也写了这句，多出来的那几处都是它的话。
 */
export function stripLegacyCompaction(markdown: string, count: number): string {
  if (count <= 0) return markdown;
  let left = count;
  return markdown.replace(LEGACY_LINE, (match: string, lead: string, offset: number) => {
    if (!left || insideFence(markdown, offset + lead.length)) return match;
    left -= 1;
    return LEGACY_COMPACTION_GAP;
  });
}

function insideFence(markdown: string, offset: number): boolean {
  let open: string | null = null;
  for (const line of markdown.slice(0, offset).split("\n").slice(0, -1)) {
    const fence = FENCE.exec(line)?.[1];
    if (!fence) continue;
    if (!open) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = null;
  }
  return open !== null;
}
