import { eq } from "drizzle-orm";
import type { AgentType, ExecTarget } from "@harness/shared";
import { db } from "../db/index.js";
import { agents, llmProviders } from "../db/schema.js";
import type { AgentExecutor, RelayConfig } from "./types.js";
import { ClaudeExecutor } from "./claude.js";
import { CodexExecutor } from "./codex.js";

type AgentRow = typeof agents.$inferSelect;

// Resolve an AgentType to a concrete executor (DESIGN.md §5: two-level model —
// you pick a *type*, the registry resolves the default executor profile under
// it, including model + local/ssh target). Falls back to a built-in local
// default when no profile is registered.
export async function resolveExecutor(type: AgentType): Promise<AgentExecutor> {
  const rows = await db.select().from(agents).where(eq(agents.type, type));
  return build(rows.find((r) => r.isDefault) ?? rows[0] ?? null, type);
}

// Resolve a *specific* executor profile by id — used where the user picked one
// by name (事项解析的执行者下拉) rather than just a type. Unknown/deleted id
// degrades to that type's default, then to claude's, so a stale reference in an
// old issue never breaks parsing.
export async function resolveExecutorById(id: string): Promise<AgentExecutor> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  if (!row) return resolveExecutor("claude");
  return build(row, row.type as AgentType);
}

async function build(profile: AgentRow | null, type: AgentType): Promise<AgentExecutor> {
  const opts = profile
    ? {
        name: profile.name,
        model: profile.model ?? undefined,
        extraArgs: JSON.parse(profile.extraArgs) as string[],
        reasoningEffort: profile.reasoningEffort ?? undefined,
        speed: profile.speed === "fast" ? ("fast" as const) : undefined,
        target: JSON.parse(profile.target) as ExecTarget,
        bin: undefined as string | undefined,
        relay: await loadRelay(profile.providerId),
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

// 挂载的供应商 → 启动 CLI 时要注入的配置。供应商被删掉(悬空 providerId)或没配
// key 时当作没挂,执行者退回 CLI 自己的官方登录账号 —— 宁可用官方账号跑通,也不
// 拿半截配置去撞一个必然 401 的端点。
async function loadRelay(providerId: string | null): Promise<RelayConfig | undefined> {
  if (!providerId) return undefined;
  const [p] = await db.select().from(llmProviders).where(eq(llmProviders.id, providerId));
  if (!p || !p.apiKey) return undefined;
  return { name: p.name, baseUrl: p.baseUrl.replace(/\/+$/, ""), apiKey: p.apiKey };
}
