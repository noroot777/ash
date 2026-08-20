import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { isReasoningEffortSupported, reasoningEffortsFor } from "@harness/shared/cli-presets";
import { readCliConfigOverrides } from "@harness/shared/cli-overrides";
import { db } from "../db/index.js";
import { agents, llmProviders } from "../db/schema.js";
import type { AgentExecutor, ExecutorBuildOpts, RelayConfig } from "./types.js";
import { cliSpec } from "./catalog/index.js";
import { execBinFor, probeBinFlag } from "./bin-probe.js";
import { GenericCliExecutor } from "./generic.js";
import { normalizeProfileExtraArgs } from "./args.js";
import { claudeEffortUnsupportedMessage } from "./claude.js";

type AgentRow = typeof agents.$inferSelect;
type ExecutorOverrides = { model?: string | null; reasoningEffort?: string | null };

async function defaultProfile(type: AgentType): Promise<AgentRow | null> {
  const rows = await db.select().from(agents).where(eq(agents.type, type));
  return rows.find((r) => r.isDefault) ?? rows[0] ?? null;
}

// Resolve an AgentType to a concrete executor (two-level model:
// you pick a *type*, the registry resolves the default executor profile under
// it, including model + overrides). Falls back to a built-in local
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

export type ExecutorResolveOpts = {
  executorId?: string | null;
  type?: AgentType | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

// 「这次到底选中了哪一条 profile」的单点：executorId 命中就用它（类型跟着这条 profile
// 走），否则退回该类型的默认 profile。降级逻辑只有这一份 —— 复制一份出去，两条路迟早
// 会在「id 悬空」这种边角上分叉。
async function pickProfile(opts: ExecutorResolveOpts): Promise<{ profile: AgentRow | null; type: AgentType }> {
  if (opts.executorId) {
    const [row] = await db.select().from(agents).where(eq(agents.id, opts.executorId));
    if (row) return { profile: row, type: row.type as AgentType };
  }
  const type = opts.type ?? "claude";
  return { profile: await defaultProfile(type), type };
}

// profile 主键只说得清「选中了谁」，说不清「它当时长什么样」——一条 profile 是可编辑、
// 可删除的：改一次 extraArgs / 供应商就换了套账号。所以「把上一回合原样再跑一遍」还要一个
// **当时那套执行环境的指纹**，两轮之间被改过就认得出来（第 1 轮审查 finding 2）。
//
// 进指纹的是**决定运行环境**的字段，不含展示名 —— 改个名字不该挡住重试。供应商只取
// 「上游是谁、协议怎么说」，不取 key 本身：轮换密钥是用户明确要生效的事，不是换环境。
async function fingerprintOf(profile: AgentRow): Promise<string> {
  const provider = profile.providerId
    ? (await db.select().from(llmProviders).where(eq(llmProviders.id, profile.providerId))).at(0)
    : undefined;
  const material = JSON.stringify([
    profile.type,
    // 已退役的 `target` 列在这一位上待过(ssh 执行器时代)。位置留着、值钉死成它当年
    // 唯一的取值,好让历史会话的指纹不因为删列而集体作废 —— 否则老会话一律被判
    // "changed"，重跑全被拒。
    '{"kind":"local"}',
    profile.extraArgs,
    profile.model ?? null,
    profile.reasoningEffort ?? null,
    profile.speed ?? null,
    profile.configOverrides ?? null,
    profile.providerId ?? null,
    provider ? [provider.baseUrl, provider.protocol, provider.protocolConversionEnabled, !!provider.apiKey] : null,
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** 上一回合记下的 profile 指纹跟现在还对不对得上。null = 没变（或无从核对）。 */
export async function profileDrift(
  executorId: string | null | undefined,
  fingerprint: string | null | undefined,
): Promise<"missing" | "changed" | null> {
  // 老会话行没记指纹：无从核对，按老行为放行（判据同 executor_id 为 null 时的降级）。
  if (!executorId || !fingerprint) return null;
  const [row] = await db.select().from(agents).where(eq(agents.id, executorId));
  if (!row) return "missing";
  return (await fingerprintOf(row)) === fingerprint ? null : "changed";
}

// 同 resolveExecutorFor，另外把**真正选中的 profile 主键**与那一刻的环境指纹一起还回来。
// 记账用：`agents.name` 非唯一、可随时改名，拿显示名反查 profile 会选中同名的另一位；
// 「把上一回合原样再跑一遍」只能认 id + 指纹（见 sessions.executor_id / executor_fingerprint）。
export async function resolveExecutorWithProfile(
  opts: ExecutorResolveOpts,
): Promise<{ executor: AgentExecutor; profileId: string | null; profileFingerprint: string | null }> {
  const { profile, type } = await pickProfile(opts);
  return {
    executor: await build(profile, type, opts),
    profileId: profile?.id ?? null,
    profileFingerprint: profile ? await fingerprintOf(profile) : null,
  };
}

// Task/team execution resolver. executorId is the precise user-selected profile;
// if it is empty or stale, degrade to the type's current default executor.
export async function resolveExecutorFor(opts: ExecutorResolveOpts): Promise<AgentExecutor> {
  return (await resolveExecutorWithProfile(opts)).executor;
}

async function build(
  profile: AgentRow | null,
  type: AgentType,
  overrides: ExecutorOverrides = {},
): Promise<AgentExecutor> {
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
        extraArgs: normalizeProfileExtraArgs(JSON.parse(profile.extraArgs)),
        reasoningEffort,
        speed: profile.speed === "fast" ? ("fast" as const) : undefined,
        bin: undefined as string | undefined,
        relay: await loadRelay(profile.providerId),
        // 存库时已归一过一次；这里再走一遍，是为了让「profile 建于该覆盖项声明之前 /
        // 声明后来改了范围」的老值也按当前声明夹一遍，而不是把一个 CLI 会静默忽略的
        // 数原样注进去。JSON 坏掉的老数据同样在这里被吃掉(否则整个 profile 派不出
        // 任务),判据跟设置页读的是同一份。
        configOverrides: readCliConfigOverrides(type, profile.configOverrides),
      }
    : {
        model,
        reasoningEffort,
      };

  const spec = cliSpec(type);
  // Claude Code 旧版会在真正读 prompt 之前直接拒绝 --effort。先问它自己的 help；
  // 不支持时仍构造执行器，但 run/openResident 走 failedChild，把错误留进会话记录，
  // 同时完全不启动真实 Claude 进程。
  if (type === "claude" && reasoningEffort) {
    const capability = await probeBinFlag(spec.bins, spec.fallbackVersionMatch, "--effort");
    if (capability) opts.bin ??= capability.bin;
    if (capability?.supported === false) {
      opts.startupError = claudeEffortUnsupportedMessage(capability.version, reasoningEffort);
    }
  }

  // 目录是唯一的分派表:有 factory 的走专用类(claude 的常驻会话、codex 的诊断
  // 链路),其余全部由 GenericCliExecutor 按 spec.exec 装配命令行。所以「新增一个
  // 可派任务的 CLI」不需要碰这里 —— 加一个 spec 文件就行。
  if (spec.factory) return spec.factory(opts);
  // 检测能命中备用命令名(cursor 的 agent、antigravity 的 agy),执行就必须用同一个
  // —— 死认 bins[0] 会让「目录显示可用」的环境派任务稳定 ENOENT(第 1 轮审查)。
  opts.bin ??= await execBinFor(spec);
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
