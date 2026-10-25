import { modelEffortKey, resolveReasoningEfforts } from "@ash/shared/cli-presets";
import type { CliExecSpec, CliModelsSpec } from "./catalog/types.js";

export const kimiEffortPreflight: NonNullable<CliExecSpec["preflight"]> = ({ args, reasoningEffort, modelEfforts }) => {
  if (!reasoningEffort) return null;
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-p" || argument === "--prompt" || argument === "--session" || argument === "-S") index += 1;
    else if (argument === "--model" || argument === "-m") model = args[++index];
    else if (argument.startsWith("--model=")) model = argument.slice("--model=".length);
    else if (argument.startsWith("-m") && argument.length > 2) model = argument.slice(argument[2] === "=" ? 3 : 2);
  }
  const resolution = resolveReasoningEfforts("kimi", model, modelEfforts);
  if (resolution.efforts.includes(reasoningEffort)) return null;
  return resolution.source === "cli-fallback"
    ? "Kimi Code 无法确认实际模型的智能水平能力；请先明确选择模型并刷新模型列表，或将智能水平设为跟随执行器"
    : `Kimi Code 模型 ${model} 不支持智能水平 ${reasoningEffort}；可选：${resolution.efforts.join("、") || "跟随执行器"}`;
};

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
