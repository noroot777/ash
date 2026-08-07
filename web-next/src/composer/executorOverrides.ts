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

export function setComposerExecutorProfile(
  configs: ComposerExecutorConfigs,
  role: ComposerExecutorRole,
  profile: string,
): ComposerExecutorConfigs {
  return { ...configs, [role]: { profile, model: "", effort: "" } };
}

export function patchComposerExecutor(
  configs: ComposerExecutorConfigs,
  role: ComposerExecutorRole,
  patch: Partial<Pick<ComposerExecutorConfig, "model" | "effort">>,
): ComposerExecutorConfigs {
  return { ...configs, [role]: { ...configs[role], ...patch } };
}
