import type { AgentExecutorProfile, LlmProvider } from "@harness/shared";
import type { ExecutorSelection } from "./ExecutorPicker";
import {
  ModelConfigPicker,
  profileForSelection,
  providerForSelection,
  ReasoningEffortPicker,
} from "./ModelConfigPicker";

export const taskConfigChipClass =
  "inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised focus:border-accent focus:outline-none";

export function TaskModelControls({
  selection,
  profiles,
  providers,
  model,
  reasoningEffort,
  onModelChange,
  onReasoningEffortChange,
  triggerClassName = taskConfigChipClass,
}: {
  selection: ExecutorSelection;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  model?: string | null;
  reasoningEffort?: string | null;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  triggerClassName?: string;
}) {
  const profile = profileForSelection(selection, profiles);
  const provider = providerForSelection(selection, profiles, providers);
  const profileName = profile?.name ?? `默认 ${selection.agentType}`;
  const modelDetail = profile?.model
    ? `使用执行器「${profileName}」的 ${profile.model}`
    : `使用执行器「${profileName}」的默认模型`;
  const effortDetail = profile?.reasoningEffort
    ? `使用执行器「${profileName}」的 ${profile.reasoningEffort}`
    : `使用执行器「${profileName}」的默认强度`;

  return (
    <>
      <ModelConfigPicker
        type={selection.agentType}
        provider={provider}
        value={model}
        onChange={onModelChange}
        defaultLabel="跟随执行器"
        defaultDetail={modelDetail}
        fallback="跟随执行器"
        triggerClassName={triggerClassName}
      />
      <ReasoningEffortPicker
        type={selection.agentType}
        value={reasoningEffort}
        onChange={onReasoningEffortChange}
        defaultLabel="跟随执行器"
        defaultDetail={effortDetail}
        fallback="跟随执行器"
        label="思考强度"
        triggerClassName={triggerClassName}
      />
    </>
  );
}
