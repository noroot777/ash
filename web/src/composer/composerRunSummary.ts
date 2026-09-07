import type { AgentExecutorProfile, LlmProvider } from "@ash/shared";
import { executorProfileFor, executorRunSummary, type ExecutorSelection } from "../lib/agentAvailability.ts";
import { useCliModelCatalog } from "../lib/cliModelCatalog.ts";
import { useProviders } from "../lib/modelCatalog.ts";

export type ComposerRunSummary = {
  executor: string;
  provider: string;
  model: string;
  effort: string;
};

export function composerRunSummary(
  target: ExecutorSelection & { model: string | null; reasoningEffort: string | null },
  profiles: AgentExecutorProfile[],
  providers: LlmProvider[],
  defaultModel: string | null = null,
): ComposerRunSummary {
  const profile = executorProfileFor(target, profiles);
  const provider = profile?.providerId
    ? providers.find((candidate) => candidate.id === profile.providerId)
    : null;
  const run = executorRunSummary(target, profiles, { model: target.model, effort: target.reasoningEffort });
  return {
    executor: profile?.name || target.agentType,
    provider: profile?.providerId ? provider?.name || profile.providerId : "CLI 官方账号",
    model: run.model || provider?.model.trim() || defaultModel || "CLI 默认模型",
    effort: run.effort || "CLI 默认档位",
  };
}

export function useComposerRunSummary(
  target: ExecutorSelection & { model: string | null; reasoningEffort: string | null },
  profiles: AgentExecutorProfile[],
): ComposerRunSummary {
  const providers = useProviders();
  const { catalog } = useCliModelCatalog(target.agentType);
  return composerRunSummary(target, profiles, providers, catalog?.defaultModel ?? null);
}
