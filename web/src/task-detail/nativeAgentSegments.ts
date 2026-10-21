import type { NativeAgentActivity } from "@ash/shared";
import { appendExecutionEvent } from "../lib/executionTrace.ts";
import type { AgentContentSegment } from "./conversationModel.ts";

export function nativeAgentSegments(activity: NativeAgentActivity[]): AgentContentSegment[] {
  const segments: AgentContentSegment[] = [];
  const next = () => {
    const segment = { id: `child:${segments.length}`, markdown: "", events: [], attachments: [] } as AgentContentSegment;
    segments.push(segment);
    return segment;
  };
  let current = next();
  for (const event of activity) {
    if (event.kind === "text") current.markdown += event.text;
    else if (event.kind === "attachment") {
      if (event.path && !current.attachments.includes(event.path)) current.attachments.push(event.path);
      // 子智能体那条路同样要把来源带上,否则抽屉里的正文一样配不上图(见 turnImages)。
      // 没有 path 的那条照样要留:它是「这处引用没副本」的明确交代,配对要靠它。
      if (event.source) (current.attachmentSources ??= []).push({ path: event.path, source: event.source, ref: event.ref });
    } else {
      if (current.markdown) current = next();
      // 相邻思考由 appendExecutionEvent 合并成一行,与主会话那两路同一份规则。
      current.events = appendExecutionEvent(current.events, event.kind === "tool"
        ? { kind: "tool", label: event.name, detail: event.detail }
        : event.kind === "error"
          ? { kind: "error", label: event.message }
          : { kind: "thinking", label: "思考过程", detail: event.text });
    }
  }
  return segments.filter((segment) => segment.markdown || segment.events.length || segment.attachments.length);
}
