// 新建面板里「谁来干这活」的一整套状态变换。UI 在 TaskComposerPanel，纯数据在这里
// ——一是给主文件腾行数（全局 700 行硬限），二是这三步（开局人选 / 拉回可用值 / 套用
// 团队预设）都是同一份 configs 的整体替换，散在组件里改一处漏一处。
import type { AgentExecutorProfile, AgentType, TeamPresetConfig } from "@ash/shared";
import {
  executorValue,
  isExecutorPickable,
  parseExecutorValue,
  preferredExecutor,
  type ExecutorSelection,
} from "../lib/agentAvailability.ts";

export type ComposerExecutorRole = "single" | "lead" | "worker" | "reviewer" | "voiceA" | "voiceB";

export interface ComposerExecutorConfig {
  profile: string;
  model: string;
  effort: string;
}

export type ComposerExecutorConfigs = Record<ComposerExecutorRole, ComposerExecutorConfig>;

export function emptyComposerExecutorConfigs(): ComposerExecutorConfigs {
  const empty = (): ComposerExecutorConfig => ({ profile: "", model: "", effort: "" });
  return {
    single: empty(),
    lead: empty(),
    worker: empty(),
    reviewer: empty(),
    voiceA: empty(),
    voiceB: empty(),
  };
}

/**
 * 选了执行器/模型：模型与智能水平由选择器一起算好（换了执行器就是空串 = 跟随执行器），
 * 三项一次落地——拆成两次更新时，后一次会带着旧值把前一次刚选的执行器盖回去。
 */
export function setComposerExecutorProfile(
  configs: ComposerExecutorConfigs,
  role: ComposerExecutorRole,
  profile: string,
  override: { model: string; effort: string },
): ComposerExecutorConfigs {
  return { ...configs, [role]: { profile, model: override.model, effort: override.effort } };
}

export function patchComposerExecutor(
  configs: ComposerExecutorConfigs,
  role: ComposerExecutorRole,
  patch: Partial<Pick<ComposerExecutorConfig, "model" | "effort">>,
): ComposerExecutorConfigs {
  return { ...configs, [role]: { ...configs[role], ...patch } };
}

/** 该类型的默认 profile；没设默认就用注册的第一个。 */
export function defaultProfile(profiles: AgentExecutorProfile[], type: AgentType) {
  return profiles.find((profile) => profile.type === type && profile.isDefault)
    ?? profiles.find((profile) => profile.type === type);
}

/**
 * 开局人选：claude 打主力（单任务 / 调度者 / 讨论者 A），codex 站对面（执行者 / 审查者 /
 * 讨论者 B）。同一个类型只注册了一个时两边会重合，随后由 reconcile 按可用性拉开。
 */
export function initialComposerExecutors(
  configs: ComposerExecutorConfigs,
  agents: AgentExecutorProfile[],
): ComposerExecutorConfigs {
  const claude = defaultProfile(agents, "claude") ?? agents[0];
  const codex = defaultProfile(agents, "codex")
    ?? agents.find((profile) => profile.id !== claude?.id)
    ?? claude;
  const claudeValue = executorValue(claude
    ? { agentType: claude.type, executorId: claude.id }
    : { agentType: "claude", executorId: null });
  const codexValue = executorValue(codex
    ? { agentType: codex.type, executorId: codex.id }
    : { agentType: "codex", executorId: null });
  return {
    ...configs,
    single: { ...configs.single, profile: claudeValue },
    lead: { ...configs.lead, profile: claudeValue },
    worker: { ...configs.worker, profile: codexValue },
    reviewer: { ...configs.reviewer, profile: codexValue },
    voiceA: { ...configs.voiceA, profile: claudeValue },
    voiceB: { ...configs.voiceB, profile: codexValue },
  };
}

/**
 * 把每个角色拉回「当下真的能选」的执行器：注册表变了、探测结果回来了、或者用户手上
 * 那份是从别处继承来的，都可能让原选择失效。**没有任何一项要改就原样返回入参**，
 * 这样调用方 setState 时引用相等，不会自激渲染。
 */
export function reconcileComposerExecutors(
  configs: ComposerExecutorConfigs,
  ctx: {
    profiles: AgentExecutorProfile[];
    workerTypes: AgentType[];
    leadTypes: AgentType[];
    leadProfiles: AgentExecutorProfile[];
  },
): ComposerExecutorConfigs {
  const { profiles, workerTypes, leadTypes, leadProfiles } = ctx;
  const reconcile = (
    value: string,
    types: AgentType[],
    candidates: AgentExecutorProfile[],
    preferred: AgentType,
    avoid?: AgentType,
  ): ExecutorSelection | null => {
    const current = parseExecutorValue(value, profiles, { agentType: preferred, executorId: null });
    return value && isExecutorPickable(current, types, candidates)
      ? current
      : preferredExecutor(types, candidates, preferred, avoid);
  };
  const single = reconcile(configs.single.profile, workerTypes, profiles, "claude");
  const lead = reconcile(configs.lead.profile, leadTypes, leadProfiles, "claude");
  const worker = reconcile(configs.worker.profile, workerTypes, profiles, "codex", lead?.agentType);
  const reviewer = reconcile(
    configs.reviewer.profile,
    workerTypes,
    profiles,
    worker?.agentType ?? "codex",
  ) ?? worker;
  const voiceA = reconcile(configs.voiceA.profile, workerTypes, profiles, "claude");
  const voiceB = reconcile(configs.voiceB.profile, workerTypes, profiles, "codex", voiceA?.agentType);
  let changed = false;
  const next = { ...configs };
  const resolved = { single, lead, worker, reviewer, voiceA, voiceB };
  for (const [role, selection] of Object.entries(resolved) as [ComposerExecutorRole, ExecutorSelection | null][]) {
    if (!selection || configs[role].profile === executorValue(selection)) continue;
    next[role] = { profile: executorValue(selection), model: "", effort: "" };
    changed = true;
  }
  return changed ? next : configs;
}

/**
 * 套用一份团队预设：预设里存的执行器 id 可能已经删了或换了类型，对不上就退回「类型
 * 默认」而不是把一个不存在的 id 塞回选择器。审查者没单独存类型时跟执行者走。
 */
export function teamPresetExecutors(
  configs: ComposerExecutorConfigs,
  config: TeamPresetConfig,
  profiles: AgentExecutorProfile[],
): ComposerExecutorConfigs {
  const profileValue = (candidate: string | null | undefined, type: AgentType) => {
    const candidateProfile = candidate ? profiles.find((profile) => profile.id === candidate) : null;
    return executorValue(candidateProfile?.type === type
      ? { agentType: type, executorId: candidate! }
      : { agentType: type, executorId: null });
  };
  const reviewerType = config.reviewerAgentType ?? config.worker;
  return {
    ...configs,
    lead: {
      profile: profileValue(config.leadExecutorId, config.lead),
      model: config.leadModel ?? "",
      effort: config.leadReasoningEffort ?? "",
    },
    worker: {
      profile: profileValue(config.workerExecutorId, config.worker),
      model: config.workerModel ?? "",
      effort: config.workerReasoningEffort ?? "",
    },
    reviewer: {
      profile: profileValue(config.reviewerExecutorId, reviewerType),
      model: config.reviewerModel ?? "",
      effort: config.reviewerReasoningEffort ?? "",
    },
  };
}
