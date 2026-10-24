import { modelEffortKey } from "@ash/shared/cli-presets";
import type { CliModelsSpec } from "./catalog/types.js";

export const parseKimiModels: CliModelsSpec["parse"] = (stdout) => {
  try {
    const config = JSON.parse(stdout);
    if (!config || typeof config.models !== "object" || !config.models || Array.isArray(config.models)) {
      return { models: [] };
    }
    const models: string[] = [];
    const modelEfforts: Record<string, readonly string[]> = {};
    for (const [alias, entry] of Object.entries(config.models)) {
      if (!alias.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const model = entry as Record<string, unknown>;
      if (typeof model.model !== "string" || !model.model || typeof model.provider !== "string") continue;
      models.push(alias);
      const provider = config.providers?.[model.provider];
      const efforts = provider?.type === "kimi" && Array.isArray(model.supportEfforts)
        ? model.supportEfforts.filter((effort: unknown): effort is string =>
          typeof effort === "string" && /^(low|medium|high|xhigh|max)$/.test(effort))
        : [];
      modelEfforts[modelEffortKey(alias)] = [...new Set<string>(efforts)];
    }
    return { models, modelEfforts };
  } catch {
    return { models: [] };
  }
};
