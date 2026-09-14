// Display model for a task's conversation. The transcript is parsed from each
// session's persisted .md — parseSessionOutput lives in @ash/shared so web and
// mobile agree on the format: agent prose becomes a "text" line (Conversation
// merges consecutive ones into one bubble); the interleaved 你→ / 〔系统〕 turns keep
// their timestamp and get a unique sessionId so each renders as its own bubble.
import type { AgentType } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done" | "user" | "system";
  text: string;
  name?: string; // tool name (kind "tool")
  agent?: AgentType; // which agent produced it (@-mention multi-agent threads)
  sessionId?: string; // groups lines into bubbles + locates the resume credential
  at?: string; // ISO time (user replies / system traces show a timestamp)
  endedAt?: string; // exec end of an agent turn (from the .md agentEnd marker) — excludes idle wait
  // 任务时间线旁注（预约审查、验收阶段更新…）：不是说给 agent 听的话，落在哪一秒纯属
  // 偶然，多半正砸在某个回合说到一半的地方。所以它既不拆气泡也不定回合起止（见 shared
  // ConvSeg 的 aside）。2026-09-14 之前的老会话没有这个标，照旧当边界。
  aside?: boolean;
};

export function snapshotToLogLines(out: string, sessionId: string, agentType?: AgentType): LogLine[] {
  return parseSessionOutput(out).map((seg, i): LogLine => {
    if (seg.kind === "agent") return { kind: "text", text: seg.text, agent: agentType, sessionId, endedAt: seg.endedAt };
    return {
      kind: seg.kind,
      text: seg.text,
      at: seg.at,
      sessionId: `${sessionId}-seg-${i}`,
      ...(seg.kind === "system" && seg.aside ? { aside: true } : {}),
    };
  });
}
