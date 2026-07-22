import type { AgentEvent, AgentType } from "@harness/shared";
import type { RunTracePaths } from "./diagnostics.js";

export interface RunOpts {
  prompt: string;
  cwd: string;
  sessionId?: string; // resume an existing CLI session
  model?: string;
  extraArgs?: string[];
  trace?: RunTracePaths;
}

// A planned invocation: the resolved session id + exact command, plus a live
// event stream. The orchestrator records sessionId/commandLine for traceability
// (DESIGN.md §13) before/while consuming the stream. `kill` terminates the
// underlying subprocess (manual stop) — the stream then ends like a normal exit.
export interface RunHandle {
  sessionId: string;
  commandLine: string;
  events: AsyncIterable<AgentEvent>;
  kill(): void;
}

// Hand-rolled adapter (DESIGN.md §7/§10: no Vercel AI SDK). Each CLI type gets
// one implementation that knows its flags, stream-json format, and resume scheme.
export interface AgentExecutor {
  readonly type: AgentType;
  readonly label: string; // e.g. "claude@local·opus"
  run(opts: RunOpts): RunHandle;
  // Build the ready-to-paste resume command for a finished session (§13).
  resumeCommand(cwd: string, sessionId: string): string;
}
