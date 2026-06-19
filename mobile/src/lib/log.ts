// Streamed-output model, ported from web (App.tsx `renderEvent` + TaskDetail's
// LogLine). Each agent.event becomes one LogLine appended to the task's log; the
// detail screen groups consecutive lines from the same session into bubbles.
import type { AgentEvent, AgentType } from "@harness/shared";
import { parseSessionOutput } from "@harness/shared";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done" | "user" | "system";
  text: string;
  name?: string; // tool name (kind "tool")
  agent?: AgentType; // which agent produced it (@-mention multi-agent threads)
  sessionId?: string; // groups lines into bubbles + locates the resume credential
  at?: string; // ISO time (user replies / system traces show a timestamp)
};

export function renderEvent(e: AgentEvent, agent?: AgentType, sessionId?: string): LogLine | null {
  const tag = (l: LogLine): LogLine => ({ ...l, agent, sessionId });
  switch (e.kind) {
    case "text":
      return tag({ kind: "text", text: e.text });
    case "thinking":
      return tag({ kind: "thinking", text: e.text });
    case "system":
      return tag({ kind: "system", text: e.text, at: new Date().toISOString() });
    case "tool":
      return tag({ kind: "tool", name: e.name, text: e.detail ?? "" });
    case "error":
      return tag({ kind: "error", text: e.message });
    case "done":
      return tag({ kind: "done", text: `— 结束 (exit ${e.exitStatus}) —` });
    default:
      return null; // "session" events carry no displayable line
  }
}

// Turn a persisted session's output into display LogLines. Parsing lives in
// @harness/shared (parseSessionOutput) so web and mobile share one source of
// truth: the agent Markdown plus the interleaved 你→/〔系统〕 turns come back as
// ordered segments. Agent prose becomes a "text" line (Conversation merges
// consecutive ones into a single bubble); user/system turns keep their timestamp
// and get a unique sessionId so each renders as its own bubble.
export function snapshotToLogLines(out: string, sessionId: string, agentType?: AgentType): LogLine[] {
  return parseSessionOutput(out).map((seg, i): LogLine => {
    if (seg.kind === "agent") return { kind: "text", text: seg.text, agent: agentType, sessionId };
    return { kind: seg.kind, text: seg.text, at: seg.at, sessionId: `${sessionId}-seg-${i}` };
  });
}
