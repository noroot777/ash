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
