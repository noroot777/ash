// 会话落盘的写入格式(单点)。一次性 run(orchestrator.ts)和常驻调度台
// (team/session.ts)都用这里的函数写 RUNS_DIR/<taskId>/<sessId>.md,于是
// 「实时(SSE)看到的」和「刷新后(解析 .md)看到的」必然一致 —— 这是仓库既有约定。
import { join } from "node:path";
import type { AgentType } from "@harness/shared";
import { RUNS_DIR } from "./paths.js";

// Canonical persisted Markdown path for one session. Keep API serialization and
// cross-task handoffs on the same derivation as the writers in orchestrator/team.
export function sessionTranscriptPath(taskId: string, sessionId: string): string {
  return join(RUNS_DIR, taskId, `${sessionId}.md`);
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
