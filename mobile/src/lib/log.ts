// Display model for a task's conversation. The transcript is parsed from each
// session's persisted .md — parseSessionOutput lives in @harness/shared so web and
// mobile agree on the format: agent prose becomes a "text" line (Conversation
// merges consecutive ones into one bubble); the interleaved 你→ / 〔系统〕 turns keep
// their timestamp and get a unique sessionId so each renders as its own bubble.
import type { AgentType } from "@harness/shared";
import { parseSessionOutput } from "@harness/shared";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done" | "user" | "system";
  text: string;
  name?: string; // tool name (kind "tool")
  agent?: AgentType; // which agent produced it (@-mention multi-agent threads)
  sessionId?: string; // groups lines into bubbles + locates the resume credential
  at?: string; // ISO time (user replies / system traces show a timestamp)
};

export function snapshotToLogLines(out: string, sessionId: string, agentType?: AgentType): LogLine[] {
  return parseSessionOutput(out).map((seg, i): LogLine => {
    if (seg.kind === "agent") return { kind: "text", text: seg.text, agent: agentType, sessionId };
    return { kind: seg.kind, text: seg.text, at: seg.at, sessionId: `${sessionId}-seg-${i}` };
  });
}
