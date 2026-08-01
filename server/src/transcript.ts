// 会话落盘格式的单点：assistant 正文写 <sessId>.md；结构化事件顺序写
// <sessId>.trace.jsonl，其中相邻 text delta 会先合并成正文片段再落盘。一次性 run
// 与常驻调度台都走这里，因此刷新能把每组 thinking/tool 放回它所启动的正文片段，
// 同时非正文事件绝不会混进 assistant Markdown。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEvent, AgentType } from "@harness/shared";
import { RUNS_DIR } from "./paths.js";

type AgentTraceEvent = Extract<AgentEvent, { kind: "thinking" | "tool" | "error" }>;
type TraceTextEvent = { kind: "text"; text: string };
export type SessionTraceEvent = AgentTraceEvent | TraceTextEvent;
export type SessionTraceEntry = {
  at: string;
  turnStartedAt: string;
  event: SessionTraceEvent;
};

// Canonical persisted Markdown path for one session. Keep API serialization and
// cross-task handoffs on the same derivation as the writers in orchestrator/team.
export function sessionTranscriptPath(taskId: string, sessionId: string): string {
  return join(RUNS_DIR, taskId, `${sessionId}.md`);
}

export function sessionTracePath(taskId: string, sessionId: string): string {
  return join(RUNS_DIR, taskId, `${sessionId}.trace.jsonl`);
}

export function appendSessionTrace(
  taskId: string,
  sessionId: string,
  turnStartedAt: string,
  event: SessionTraceEvent,
  at = new Date().toISOString(),
): void {
  const path = sessionTracePath(taskId, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at, turnStartedAt, event } satisfies SessionTraceEntry)}\n`);
  } catch (error) {
    // Trace persistence is diagnostic UI state. A disk failure must not alter the
    // executor's outcome, but it must remain visible to operators.
    console.warn(`[harness] failed to persist session trace ${sessionId}:`, error);
  }
}

export function parseSessionTrace(raw: string): SessionTraceEntry[] {
  const entries: SessionTraceEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<SessionTraceEntry>;
      const event = entry.event;
      if (
        typeof entry.at !== "string"
        || typeof entry.turnStartedAt !== "string"
        || !event
        || !["text", "thinking", "tool", "error"].includes(event.kind)
        || (event.kind === "text" && typeof event.text !== "string")
      ) continue;
      entries.push(entry as SessionTraceEntry);
    } catch {
      // A partially written final JSONL line should not hide earlier valid trace.
    }
  }
  return entries;
}

// A non-text interjection in the run timeline — a 你→@agent reply or a 〔系统〕
// continue — is persisted as ONE sentinel line: RS (\x1e, which never occurs in
// agent text) + JSON. JSON keeps it to a single physical line even when the text
// has newlines, so the reload parser can lift it back into its own bubble (with
// the timestamp it carries) instead of letting it bleed into the surrounding
// agent Markdown. Live, the same turn rides its own channel (a user reply shows
// optimistically client-side; a system trace via a `system` event), so both
// surfaces read identically.
export const TURN_SENTINEL = "\x1e";

export function writeTurn(
  out: NodeJS.WritableStream,
  turn: { t: "user" | "system"; agent: AgentType; text: string },
  at: string,
): void {
  out.write(`\n${TURN_SENTINEL}${JSON.stringify({ ...turn, at })}\n`);
}

// Fence where an agent turn ACTUALLY finished (real exec end), so per-turn 用时 in
// the conversation brackets [你→ reply → agent done] instead of [reply → your NEXT
// reply] — i.e. it excludes the idle wait while the agent sat waiting for you.
// Distinct from writeTurn (which fences human/system interjections, not exec ends).
export function writeTurnEnd(out: NodeJS.WritableStream, at: string): void {
  out.write(`\n${TURN_SENTINEL}${JSON.stringify({ t: "agentEnd", at })}\n`);
}

export function writeRunError(out: NodeJS.WritableStream, message: string): void {
  const quoted = message.trim().split("\n").map((line) => `> ${line}`).join("\n");
  out.write(`\n> **执行诊断**\n${quoted}\n`);
}

// codex 的原始事件/stderr/诊断落盘路径(每会话每回合一组)。
export function runTracePaths(runDir: string, sessionId: string, turnStart: string) {
  const turn = turnStart.replace(/[^0-9A-Za-z]/g, "");
  const base = join(runDir, `${sessionId}-${turn}`);
  return {
    eventsPath: `${base}.codex-events.jsonl`,
    stderrPath: `${base}.stderr.log`,
    diagnosticsPath: `${base}.diagnostics.json`,
  };
}
