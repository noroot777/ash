import { eq } from "drizzle-orm";
import type { AgentType, ExecTarget } from "@harness/shared";
import { isReasoningEffortSupported, reasoningEffortsFor } from "@harness/shared/cli-presets";
import { normalizeCliConfigOverrides } from "@harness/shared/cli-overrides";
import { db } from "../db/index.js";
import { agents, llmProviders } from "../db/schema.js";
import type { AgentExecutor, ExecutorBuildOpts, RelayConfig } from "./types.js";
import { cliSpec } from "./catalog/index.js";
import { execBinFor } from "./bin-probe.js";
import { GenericCliExecutor } from "./generic.js";
import { normalizeProfileExtraArgs } from "./args.js";

type AgentRow = typeof agents.$inferSelect;
type ExecutorOverrides = { model?: string | null; reasoningEffort?: string | null };

async function defaultProfile(type: AgentType): Promise<AgentRow | null> {
  const rows = await db.select().from(agents).where(eq(agents.type, type));
  return rows.find((r) => r.isDefault) ?? rows[0] ?? null;
}

// Resolve an AgentType to a concrete executor (two-level model:
// you pick a *type*, the registry resolves the default executor profile under
// it, including model + local/ssh target). Falls back to a built-in local
// default when no profile is registered.
export async function resolveExecutor(type: AgentType): Promise<AgentExecutor> {
  return build(await defaultProfile(type), type);
}

// Resolve a *specific* executor profile by id — used where the user picked one
// by name (事项解析的执行器下拉) rather than just a type. Unknown/deleted id
// degrades to that type's default, then to claude's, so a stale stored reference
// never breaks execution.
export async function resolveExecutorById(id: string): Promise<AgentExecutor> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  if (!row) return resolveExecutor("claude");
  return build(row, row.type as AgentType);
}

// Task/team execution resolver. executorId is the precise user-selected profile;
// if it is empty or stale, degrade to the type's current default executor.
export async function resolveExecutorFor(opts: {
  executorId?: string | null;
  type?: AgentType | null;
  model?: string | null;
  reasoningEffort?: string | null;
}): Promise<AgentExecutor> {
  if (opts.executorId) {
    const [row] = await db.select().from(agents).where(eq(agents.id, opts.executorId));
    if (row) return build(row, row.type as AgentType, opts);
  }
  const type = opts.type ?? "claude";
  return build(await defaultProfile(type), type, opts);
}

async function build(
  profile: AgentRow | null,
  type: AgentType,
  overrides: ExecutorOverrides = {},
): Promise<AgentExecutor> {
  const target = profile ? JSON.parse(profile.target) as ExecTarget : undefined;
  const model = overrides.model || profile?.model || undefined;
  const reasoningEffort = overrides.reasoningEffort || profile?.reasoningEffort || undefined;
  if (!isReasoningEffortSupported(type, model, reasoningEffort)) {
    const allowed = reasoningEffortsFor(type, model);
    throw new Error(
      `${type} 模型 ${model ?? "（跟随 CLI）"} 不支持思考强度 ${reasoningEffort}`
      + (allowed.length ? `；可选：${allowed.join("、")}` : "；该模型没有独立思考强度档位"),
    );
  }
  const opts: ExecutorBuildOpts = profile
    ? {
        name: profile.name,
        model,
        extraArgs: normalizeProfileExtraArgs(JSON.parse(profile.extraArgs), target!),
        reasoningEffort,
        speed: profile.speed === "fast" ? ("fast" as const) : undefined,
        target,
        bin: undefined as string | undefined,
        relay: await loadRelay(profile.providerId),
        // 存库时已归一过一次；这里再走一遍，是为了让「profile 建于该覆盖项声明之前 /
        // 声明后来改了范围」的老值也按当前声明夹一遍，而不是把一个 CLI 会静默忽略的
        // 数原样注进去。
        configOverrides: normalizeCliConfigOverrides(type, JSON.parse(profile.configOverrides ?? "{}")),
      }
    : {
        model,
        reasoningEffort,
      };

  // 目录是唯一的分派表:有 factory 的走专用类(claude 的常驻会话、codex 的诊断
  // 链路),其余全部由 GenericCliExecutor 按 spec.exec 装配命令行。所以「新增一个
  // 可派任务的 CLI」不需要碰这里 —— 加一个 spec 文件就行。
  const spec = cliSpec(type);
  if (spec.factory) return spec.factory(opts);
  // 检测能命中备用命令名(cursor 的 agent、antigravity 的 agy),执行就必须用同一个
  // —— 死认 bins[0] 会让「目录显示可用」的环境派任务稳定 ENOENT(第 1 轮审查)。
  opts.bin ??= await execBinFor(spec, opts.target);
  return new GenericCliExecutor(spec, opts);
}

// 挂载的供应商 → 启动 CLI 时要注入的配置。供应商被删掉(悬空 providerId)或没配
// key 时当作没挂,执行器退回 CLI 自己的官方登录账号 —— 宁可用官方账号跑通,也不
// 拿半截配置去撞一个必然 401 的端点。
async function loadRelay(providerId: string | null): Promise<RelayConfig | undefined> {
  if (!providerId) return undefined;
  const [p] = await db.select().from(llmProviders).where(eq(llmProviders.id, providerId));
  if (!p || !p.apiKey) return undefined;
  return {
    providerId: p.id,
    name: p.name,
    baseUrl: p.baseUrl.replace(/\/+$/, ""),
    apiKey: p.apiKey,
    protocolConversionEnabled: p.protocol === "openai" && p.protocolConversionEnabled,
  };
}
