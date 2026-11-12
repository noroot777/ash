import type { AgentExecutorProfile, AgentType, FreeReviewExecutorOverride, ReviewerProfile } from "@ash/shared";
import { executorValue, parseExecutorValue } from "../lib/agentAvailability.ts";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";

/** 派审面上「这一次用谁跑」的草稿——形状与审查者表单同源，只是不含名称。 */
export interface ReviewerRunDraft {
  target: string;
  model: string;
  effort: string;
}

export function reviewerRunDraft(reviewer: ReviewerProfile | null | undefined): ReviewerRunDraft {
  if (!reviewer) return { target: executorValue({ agentType: "codex", executorId: null }), model: "", effort: "" };
  return {
    target: executorValue({ agentType: reviewer.agentType, executorId: reviewer.executorId }),
    model: reviewer.model ?? "",
    effort: reviewer.reasoningEffort ?? "",
  };
}

/** 预约里存着的覆盖回显成草稿（「调整预约审查」再打开时，看到的得是上次改后的配置）。 */
export function reviewerRunDraftFrom(override: FreeReviewExecutorOverride): ReviewerRunDraft {
  return {
    target: executorValue({ agentType: override.agentType, executorId: override.executorId }),
    model: override.model ?? "",
    effort: override.reasoningEffort ?? "",
  };
}

/** 草稿跟审查者存的配置是不是同一套。三段都比，任何一段不同都算改过。 */
export function sameAsReviewer(draft: ReviewerRunDraft, reviewer: ReviewerProfile | null | undefined): boolean {
  if (!reviewer) return true;
  const stored = reviewerRunDraft(reviewer);
  return draft.target === stored.target
    && draft.model.trim() === stored.model.trim()
    && draft.effort === stored.effort;
}

export function reviewerRunPayload(
  draft: ReviewerRunDraft,
  profiles: AgentExecutorProfile[],
): FreeReviewExecutorOverride {
  const selection = parseExecutorValue(draft.target, profiles, { agentType: "codex", executorId: null });
  return {
    agentType: selection.agentType,
    executorId: selection.executorId,
    model: draft.model.trim() || null,
    reasoningEffort: draft.effort || null,
  };
}

/**
 * 这一次换个执行器跑：只作用于这一次（或这一份预约），选中那位审查者的配置不动。
 * 要长期改、或另存一位新的，去设置页「审查者」——那里能编辑和新建。
 */
export function ReviewerRunOnce({
  reviewer,
  profiles,
  types,
  draft,
  changed,
  disabled = false,
  onChange,
}: {
  reviewer: ReviewerProfile;
  profiles: AgentExecutorProfile[];
  types: AgentType[];
  draft: ReviewerRunDraft;
  changed: boolean;
  disabled?: boolean;
  onChange: (draft: ReviewerRunDraft) => void;
}) {
  return (
    <div className="free-review-run-once">
      <ExecutorPickerField
        label="这一次用"
        value={draft.target}
        types={types}
        profiles={profiles}
        knownProfiles={profiles}
        fallbackType="codex"
        override={{ model: draft.model, effort: draft.effort }}
        disabled={disabled}
        onChange={(target, override) => onChange({ target, model: override.model, effort: override.effort })}
        onEffortChange={(effort) => onChange({ ...draft, effort })}
      />
      {changed && <small className="free-review-run-once__hint">只用这一次，「{reviewer.name}」的配置不变</small>}
    </div>
  );
}
