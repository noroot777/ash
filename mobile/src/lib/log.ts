// Streamed-output model, ported from web (App.tsx `renderEvent` + TaskDetail's
// LogLine). Each agent.event becomes one LogLine appended to the task's log; the
// detail screen groups consecutive lines from the same session into bubbles.
import type { AgentEvent, AgentType } from "@harness/shared";

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

// Parse a persisted session .md: agent Markdown + interleaved 你→@agent replies.
// New runs write each as a \x1e + JSON sentinel line; older runs use inline markers.
type ParsedSeg = { kind: "agent" | "user" | "system"; text: string; at?: string };

function parseSnapshot(out: string): ParsedSeg[] {
  const segs: ParsedSeg[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) segs.push({ kind: "agent", text: t });
    buf = [];
  };

  for (const line of out.split("\n")) {
    // New sentinel format: \x1e + JSON
    if (line.startsWith("\x1e")) {
      flush();
      try {
        const json = JSON.parse(line.slice(1));
        if (json.kind === "user" && json.text) {
          segs.push({ kind: "user", text: json.text, at: json.at });
        } else if (json.kind === "system" && json.text) {
          segs.push({ kind: "system", text: json.text, at: json.at });
        }
      } catch {
        // Malformed sentinel, skip
      }
      continue;
    }

    const trimmed = line.trim();
    // Legacy system marker
    if (trimmed === "〔系统〕继续（从中断处）") {
      flush();
      segs.push({ kind: "system", text: "〔系统〕继续（从中断处）" });
      continue;
    }
    // Legacy user reply marker: 〔你 → @agent〕text
    const m = /^〔你 → @[^〕]*〕([\s\S]*)$/.exec(trimmed);
    if (m) {
      flush();
      segs.push({ kind: "user", text: m[1] ?? "" });
      continue;
    }
    buf.push(line);
  }
  flush();
  return segs;
}

// Convert parsed segments back into LogLines for display
export function snapshotToLogLines(out: string, sessionId: string): LogLine[] {
  return parseSnapshot(out).map((seg, i) => ({
    kind: seg.kind,
    text: seg.text,
    at: seg.at,
    sessionId: `${sessionId}-snap-${i}`,
  }));
}

