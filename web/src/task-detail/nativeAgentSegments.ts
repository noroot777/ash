import type { NativeAgentActivity } from "@ash/shared";
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
      if (!current.attachments.includes(event.path)) current.attachments.push(event.path);
    } else {
      if (current.markdown) current = next();
      if (event.kind === "tool") current.events.push({ kind: "tool", label: event.name, detail: event.detail });
      else if (event.kind === "error") current.events.push({ kind: "error", label: event.message });
      else {
        const previous = current.events.at(-1);
        if (previous?.kind === "thinking") previous.detail = (previous.detail ?? "") + event.text;
        else current.events.push({ kind: "thinking", label: "思考过程", detail: event.text });
      }
    }
  }
  return segments.filter((segment) => segment.markdown || segment.events.length || segment.attachments.length);
}
