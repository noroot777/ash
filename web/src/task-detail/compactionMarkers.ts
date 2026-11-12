// 压缩上下文不是它说的话（docs/ui-ux-audit run-9）。
//
// claude 那一路压缩时，服务端往正文里插两句引用（「正在压缩上下文…」「上下文已压缩。」，见
// server/src/executors/claude-stream.ts）。照原样排，它们就成了回复的一部分：压完也一直留在
// 那条回复里，复制时一起带走。这里在展示前把它们从正文里摘出来，换成执行过程里它发生的那个
// 位置上的一步——压着的时候是「在压缩上下文」（进行条那一行跟着说），压完并成一行「压缩了
// 上下文」。没压成的那一次服务端另报一条异常，照旧是红的。
//
// 只改排法，不改数据：落盘的正文里那两句还在，历史回复一并按这一份摘。
import type { ConversationItem } from "./conversationModel.ts";
import type { AgentContentSegment } from "./conversationSegments.ts";
import type { ExecutionEvent } from "../lib/executionTrace.ts";

export const COMPACT_LABEL = "压缩上下文";
export const COMPACTING = "在压缩上下文";
export const COMPACTED = "压缩了上下文";

const MARKER = /\n?> (正在压缩上下文…|上下文已压缩。)\n(?:\n)?/g;
const HAS_MARKER = /> (正在压缩上下文…|上下文已压缩。)\n/;

export function isCompactionEvent(event: ExecutionEvent): boolean {
  return event.kind === "notice" && event.label === COMPACT_LABEL;
}

const notice = (detail: string, at?: string): ExecutionEvent => ({ kind: "notice", label: COMPACT_LABEL, detail, ...(at ? { at } : {}) });

export function liftCompactionMarkers(items: readonly ConversationItem[]): ConversationItem[] {
  return items.map((item) => {
    if (item.kind !== "agent" || !item.segments.some((segment) => HAS_MARKER.test(segment.markdown))) return item;
    return {
      ...item,
      markdown: item.markdown.replace(MARKER, "\n"),
      segments: item.segments.flatMap(splitSegment),
    };
  });
}

function splitSegment(segment: AgentContentSegment): AgentContentSegment[] {
  const parts = segment.markdown.split(MARKER);
  if (parts.length === 1) return [segment];
  // split 带捕获组：[正文, 标记, 正文, 标记, …, 正文]
  const out: AgentContentSegment[] = [];
  let text = parts[0]!;
  for (let index = 1; index < parts.length; index += 2) {
    const started = parts[index] === "正在压缩上下文…";
    const previous = out.at(-1)?.events.at(-1);
    if (!started && !text.trim() && previous && isCompactionEvent(previous) && previous.detail === COMPACTING) {
      // 开始和压完之间一个字都没有：并成一行。
      previous.detail = COMPACTED;
    } else {
      out.push({ id: `${segment.id}:compact:${out.length}`, markdown: text, events: [notice(started ? COMPACTING : COMPACTED)], attachments: [], awaiting: false });
    }
    text = parts[index + 1] ?? "";
  }
  out.push({ ...segment, markdown: text });
  if (out[0]) out[0] = { ...out[0], id: segment.id };
  out[out.length - 1] = { ...out[out.length - 1]!, id: `${segment.id}:compact:tail` };
  return out;
}
