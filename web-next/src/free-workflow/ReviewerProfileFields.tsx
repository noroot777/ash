import type { AgentExecutorProfile, AgentType, ReviewerProfile } from "@harness/shared";
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

export function ReviewerProfileSummary({
  reviewer,
  profiles,
}: {
  reviewer: ReviewerProfile;
  profiles: AgentExecutorProfile[];
}) {
  const selection = { agentType: reviewer.agentType, executorId: reviewer.executorId };
  const inheritedProfile = executorProfileFor(selection, profiles);
  const run = executorRunSummary(
    selection,
    profiles,
    { model: reviewer.model, effort: reviewer.reasoningEffort },
  );
  const model = run.model ?? "跟随 CLI";
  const effort = run.effort ?? "跟随 CLI";

  return (
    <span className="reviewer-profile-summary">
      <small>{reviewer.executorLabel ?? inheritedProfile?.name ?? reviewer.agentType}</small>
      <span className="reviewer-run-details">
        <span aria-label={`模型：${model}`}><i>模型</i><code>{model}</code></span>
        <span aria-label={`智能水平：${effort}`}><i>智能水平</i><code>{effort}</code></span>
      </span>
    </span>
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
        onChange={(target) => onChange({ ...draft, target, model: "", effort: "" })}
        onOverrideChange={(patch) => onChange({
          ...draft,
          model: patch.model === undefined ? draft.model : patch.model,
          effort: patch.effort === undefined ? draft.effort : patch.effort,
        })}
      />
    </div>
  );
}
