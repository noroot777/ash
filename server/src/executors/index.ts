import type { AgentType } from "@harness/shared";
import type { AgentExecutor } from "./types.js";
import { ClaudeExecutor } from "./claude.js";

// M1: resolves an AgentType to its default executor. M3 will replace this with
// lookup against the agent registry (DB `agents` table) + per-type default /
// load-based selection (DESIGN.md §5).
export function resolveExecutor(type: AgentType): AgentExecutor {
  switch (type) {
    case "claude":
      return new ClaudeExecutor();
    default:
      throw new Error(`executor for type "${type}" not implemented yet (M3)`);
  }
}
