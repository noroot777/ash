// 新建面板里「谁来跑这条任务」的状态变换。UI 在 TaskComposerPanel，纯数据在这里
// ——一是给主文件腾行数（全局 700 行硬限），二是开局人选、拉回可用值都是同一份 configs 的整体替换。
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import {
  executorValue,
  isExecutorPickable,
  parseExecutorValue,
  preferredExecutor,
} from "../lib/agentAvailability.ts";

export type ComposerExecutorRole = "single";

export interface ComposerExecutorConfig {
  profile: string;
  model: string;
  effort: string;
}

export type ComposerExecutorConfigs = Record<ComposerExecutorRole, ComposerExecutorConfig>;

export function emptyComposerExecutorConfigs(): ComposerExecutorConfigs {
  const empty = (): ComposerExecutorConfig => ({ profile: "", model: "", effort: "" });
  return { single: empty() };
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

/** 开局人选：claude 的默认执行器；没注册 claude 就用注册的第一个。可用性由 reconcile 再拉一遍。 */
export function initialComposerExecutors(
  configs: ComposerExecutorConfigs,
  agents: AgentExecutorProfile[],
): ComposerExecutorConfigs {
  const claude = defaultProfile(agents, "claude") ?? agents[0];
  const profile = executorValue(claude
    ? { agentType: claude.type, executorId: claude.id }
    : { agentType: "claude", executorId: null });
  return { ...configs, single: { ...configs.single, profile } };
}

/**
 * 把执行器拉回「当下真的能选」的那一个：注册表变了、探测结果回来了、或者用户手上那份是从别处继承来的，
 * 都可能让原选择失效。**不用改就原样返回入参**，这样调用方 setState 时引用相等，不会自激渲染。
 */
export function reconcileComposerExecutors(
  configs: ComposerExecutorConfigs,
  ctx: { profiles: AgentExecutorProfile[]; types: AgentType[] },
): ComposerExecutorConfigs {
  const { profiles, types } = ctx;
  const value = configs.single.profile;
  const current = parseExecutorValue(value, profiles, { agentType: "claude", executorId: null });
  const selection = value && isExecutorPickable(current, types, profiles)
    ? current
    : preferredExecutor(types, profiles, "claude");
  if (!selection || value === executorValue(selection)) return configs;
  return { ...configs, single: { profile: executorValue(selection), model: "", effort: "" } };
}
