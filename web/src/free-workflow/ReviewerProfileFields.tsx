import type { AgentExecutorProfile, AgentType, ReviewerProfile } from "@ash/shared";
import { executorProfileFor, executorRunSummary, executorValue, parseExecutorValue } from "../lib/agentAvailability.ts";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";

export interface ReviewerDraft {
  name: string;
  target: string;
  model: string;
  effort: string;
}

export function createReviewerDraft(profiles: AgentExecutorProfile[] = []): ReviewerDraft {
  const profile = profiles.find((candidate) => candidate.isDefault) ?? profiles[0];
  return {
    name: "",
    target: executorValue(profile
      ? { agentType: profile.type, executorId: profile.id }
      : { agentType: "codex", executorId: null }),
    model: "",
    effort: "",
  };
}

export function reviewerDraft(profile: ReviewerProfile): ReviewerDraft {
  return {
    name: profile.name,
    target: executorValue({ agentType: profile.agentType, executorId: profile.executorId }),
    model: profile.model ?? "",
    effort: profile.reasoningEffort ?? "",
  };
}

export function reviewerPayload(draft: ReviewerDraft, profiles: AgentExecutorProfile[]) {
  const selection = parseExecutorValue(draft.target, profiles, { agentType: "codex", executorId: null });
  return {
    name: draft.name.trim(),
    agentType: selection.agentType,
    executorId: selection.executorId,
    model: draft.model.trim() || null,
    reasoningEffort: draft.effort || null,
  };
}

/** 一位审查者实际会怎么跑：智能体 · 模型 · 智能水平（没覆盖的那段写「跟随 CLI」）。 */
export function reviewerRunParts(reviewer: ReviewerProfile, profiles: AgentExecutorProfile[]) {
  const selection = { agentType: reviewer.agentType, executorId: reviewer.executorId };
  const inheritedProfile = executorProfileFor(selection, profiles);
  const run = executorRunSummary(
    selection,
    profiles,
    { model: reviewer.model, effort: reviewer.reasoningEffort },
  );
  return {
    executor: reviewer.executorLabel ?? inheritedProfile?.name ?? reviewer.agentType,
    model: run.model ?? "跟随 CLI",
    effort: run.effort ?? "跟随 CLI",
  };
}

/** 同一份，压成一行字（下拉候选右边那段灰字）。 */
export function reviewerRunText(reviewer: ReviewerProfile, profiles: AgentExecutorProfile[]): string {
  const { executor, model, effort } = reviewerRunParts(reviewer, profiles);
  return `${executor} · ${model} · ${effort}`;
}

export function ReviewerProfileSummary({
  reviewer,
  profiles,
}: {
  reviewer: ReviewerProfile;
  profiles: AgentExecutorProfile[];
}) {
  const { executor, model, effort } = reviewerRunParts(reviewer, profiles);
  return (
    <small className="reviewer-profile-summary" aria-label={`智能体：${executor}；模型：${model}；智能水平：${effort}`}>
      <span>{executor}</span><i aria-hidden="true">·</i><code>{model}</code><i aria-hidden="true">·</i><code>{effort}</code>
    </small>
  );
}

export function ReviewerProfileFields({
  draft,
  profiles,
  types,
  disabled = false,
  onChange,
}: {
  draft: ReviewerDraft;
  profiles: AgentExecutorProfile[];
  types: AgentType[];
  disabled?: boolean;
  onChange: (draft: ReviewerDraft) => void;
}) {
  return (
    <div className="reviewer-profile-fields">
      <label>
        <span>审查者名称</span>
        <input
          value={draft.name}
          disabled={disabled}
          placeholder="例如：Codex 严格逻辑审查"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <ExecutorPickerField
        label="智能体 · 模型 · 智能水平"
        value={draft.target}
        types={types}
        profiles={profiles}
        knownProfiles={profiles}
        fallbackType="codex"
        override={{ model: draft.model, effort: draft.effort }}
        disabled={disabled}
        onChange={(target, override) => onChange({
          ...draft,
          target,
          model: override.model,
          effort: override.effort,
        })}
        onEffortChange={(effort) => onChange({ ...draft, effort })}
      />
    </div>
  );
}
