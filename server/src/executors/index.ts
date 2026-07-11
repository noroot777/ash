import { eq } from "drizzle-orm";
import type { AgentType, ExecTarget } from "@harness/shared";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import type { AgentExecutor } from "./types.js";
import { ClaudeExecutor } from "./claude.js";
import { CodexExecutor } from "./codex.js";

// Resolve an AgentType to a concrete executor (DESIGN.md §5: two-level model —
// you pick a *type*, the registry resolves the default executor profile under
// it, including model + local/ssh target). Falls back to a built-in local
// default when no profile is registered.
export async function resolveExecutor(type: AgentType): Promise<AgentExecutor> {
  const rows = await db.select().from(agents).where(eq(agents.type, type));
  const profile = rows.find((r) => r.isDefault) ?? rows[0];
  const opts = profile
    ? {
        name: profile.name,
        model: profile.model ?? undefined,
        extraArgs: JSON.parse(profile.extraArgs) as string[],
        target: JSON.parse(profile.target) as ExecTarget,
        bin: undefined as string | undefined,
      }
    : {};

  switch (type) {
    case "claude":
      return new ClaudeExecutor(opts);
    case "codex":
      return new CodexExecutor(opts);
    default:
      throw new Error(`"${type}" 没有可用的执行器：请在「智能体」里为它配置一个执行者（暂无内置 ${type} 解析器）`);
  }
}
