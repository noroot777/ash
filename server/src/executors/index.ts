import type { AgentType } from "@harness/shared";
import type { AgentExecutor } from "./types.js";
import { ClaudeExecutor } from "./claude.js";
import { CodexExecutor } from "./codex.js";

// Resolves an AgentType to its default executor. M6 will extend this with the
// agent registry (DB `agents` table) for per-type default / load-based
// selection and remote (ssh) targets (DESIGN.md §5).
export function resolveExecutor(type: AgentType): AgentExecutor {
  switch (type) {
    case "claude":
      return new ClaudeExecutor();
    case "codex":
      return new CodexExecutor();
    default:
      throw new Error(`executor for type "${type}" not implemented yet (M6: ${type})`);
  }
}
