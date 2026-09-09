import type { AgentEvent, NativeAgentActivity } from "@ash/shared";
import { childActivity } from "./native-agent-activity.js";

type TextActivity = Extract<NativeAgentActivity, { kind: "text" | "thinking" }>;

export class NativeActivityBuffer {
  private pending = new Map<string, TextActivity>();

  private flush(id?: string): AgentEvent[] {
    const entries = id === undefined ? [...this.pending] : this.pending.has(id) ? [[id, this.pending.get(id)!] as const] : [];
    for (const [key] of entries) this.pending.delete(key);
    return entries.map(([key, event]) => childActivity(key, event));
  }

  push(event: AgentEvent): AgentEvent[] {
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    if (work?.type === "activity") {
      const part = work.event;
      if (part.kind === "text" || part.kind === "thinking") {
        if (!part.text) return [];
        const previous = this.pending.get(work.id);
        const out = previous && previous.kind !== part.kind ? this.flush(work.id) : [];
        const text = (previous?.kind === part.kind ? previous.text : "") + part.text;
        this.pending.set(work.id, { kind: part.kind, text });
        // Same threshold as the main Claude stream; each child's ordering is independent.
        if (text.length >= 40 || text.includes("\n")) out.push(...this.flush(work.id));
        return out;
      }
    }
    if (event.kind === "done" || event.kind === "turnEnd" || event.kind === "error") {
      return [...this.flush(), event];
    }
    return [...(work ? this.flush(work.id) : []), event];
  }
}
