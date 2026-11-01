import type { NativeAgentActivity } from "@ash/shared";
import { appendExecutionEvent } from "../lib/executionTrace.ts";
import { eventSplitAt } from "./conversationSegments.ts";
import type { AgentContentSegment } from "./conversationModel.ts";

export function nativeAgentSegments(activity: NativeAgentActivity[]): AgentContentSegment[] {
  // 后面还会不会再来正文(回放整串活动时算得出来)—— 切点规则见 eventSplitAt。
  const lastText = activity.reduce((last, event, index) => event.kind === "text" ? index : last, -1);
  const segments: AgentContentSegment[] = [];
  const next = () => {
    const segment = { id: `child:${segments.length}`, markdown: "", events: [], attachments: [] } as AgentContentSegment;
    segments.push(segment);
    return segment;
  };
  let current = next();
  for (const [index, event] of activity.entries()) {
    if (event.kind === "text") current.markdown += event.text;
    else if (event.kind === "attachment") {
      if (event.path && !current.attachments.includes(event.path)) current.attachments.push(event.path);
      // 子智能体那条路同样要把来源带上,否则抽屉里的正文一样配不上图(见 turnImages)。
      // 没有 path 的那条照样要留:它是「这处引用没副本」的明确交代,配对要靠它。
      if (event.source) (current.attachmentSources ??= []).push({ path: event.path, source: event.source, ref: event.ref, pos: event.pos, lost: event.lost });
    } else {
      /* 切点规则跟主会话那两路共用一份(eventSplitAt,理由写在 conversationSegments)。 */
      const cut = eventSplitAt(current.markdown, index > lastText);
      if (cut) {
        const tail = current.markdown.slice(cut);
        current.markdown = current.markdown.slice(0, cut);
        current = next();
        current.markdown = tail;
      }
      // 相邻思考由 appendExecutionEvent 合并成一行,与主会话那两路同一份规则。
      current.events = appendExecutionEvent(current.events, event.kind === "tool"
        ? { kind: "tool", label: event.name, detail: event.detail }
        : event.kind === "error"
          // `level:"notice"` 是**过程提示**(上游在重试),不是执行故障 —— 这一位从主会话到
          // 子线程一路带到了这里(shared/src/native-work.ts),末端却曾经一律归约成 error:
          // 一场重连风暴在子智能体抽屉里就是几百条红色「执行异常」,而它只是在重试(审查 N1)。
          ? { kind: event.level === "notice" ? "notice" : "error", label: event.message }
          : { kind: "thinking", label: "思考过程", detail: event.text });
    }
  }
  return segments.filter((segment) => segment.markdown || segment.events.length || segment.attachments.length);
}
