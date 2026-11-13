import { useId } from "react";
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

/**
 * 设置 → 审查者里就地展开的那几行字段。跟飞书页的表单同一副：一行一个，左边字段名、右边控件
 * （样式在 styles/settings-list.css 的 .settings-editor）。
 */
export function ReviewerProfileFields({
  draft,
  profiles,
  types,
  disabled = false,
  autoFocus = false,
  onChange,
}: {
  draft: ReviewerDraft;
  profiles: AgentExecutorProfile[];
  types: AgentType[];
  disabled?: boolean;
  /** 新建时直接落在名称框里。 */
  autoFocus?: boolean;
  onChange: (draft: ReviewerDraft) => void;
}) {
  const nameId = useId();
  return (
    <>
      <div className="settings-field">
        <label htmlFor={nameId}>名称</label>
        <input
          id={nameId}
          value={draft.name}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder="例如：Codex 严格逻辑审查"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="settings-field">
        <span className="settings-field-name">智能体与模型</span>
        <div className="settings-field-body">
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
      </div>
    </>
  );
}
