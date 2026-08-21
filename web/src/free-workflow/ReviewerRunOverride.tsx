import type { AgentExecutorProfile, AgentType, FreeReviewExecutorOverride, ReviewerProfile } from "@ash/shared";
import { executorValue, parseExecutorValue } from "../lib/agentAvailability.ts";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";

/** 派审面上「这一次用谁跑」的草稿——形状与审查者表单同源，只是不含名称。 */
export interface ReviewerRunDraft {
  target: string;
  model: string;
  effort: string;
}

/** 改动落到哪里：只作用于这一次 / 写回这位审查者 / 另存成一位新审查者。 */
export type ReviewerRunSaveMode = "once" | "overwrite" | "new";

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
 * 选中审查者的执行器，可以就地改。**改了不等于要存**：三选一决定这套改动的去向，
 * 默认「仅本次使用」——用户来这个对话框是为了发起一次审查，顺手换个模型是常态，
 * 把它写回配置反而是意外副作用。三段没动时整块保存选择不出现，别拿一个无从选起
 * 的单选题占版面。
 */
export function ReviewerRunOverride({
  reviewer,
  profiles,
  types,
  draft,
  changed,
  saveMode,
  newName,
  disabled = false,
  onChange,
  onSaveModeChange,
  onNewNameChange,
}: {
  reviewer: ReviewerProfile | null;
  profiles: AgentExecutorProfile[];
  types: AgentType[];
  draft: ReviewerRunDraft;
  changed: boolean;
  saveMode: ReviewerRunSaveMode;
  newName: string;
  disabled?: boolean;
  onChange: (draft: ReviewerRunDraft) => void;
  onSaveModeChange: (mode: ReviewerRunSaveMode) => void;
  onNewNameChange: (name: string) => void;
}) {
  if (!reviewer) return null;
  const modes: Array<{ value: ReviewerRunSaveMode; label: string; hint: string }> = [
    { value: "once", label: "仅本次使用", hint: `不改动「${reviewer.name}」的配置` },
    { value: "overwrite", label: `覆盖「${reviewer.name}」`, hint: "以后用这位审查者都按新配置" },
    { value: "new", label: "另存为新审查者", hint: "保留原审查者，多出一位新的" },
  ];

  return (
    <div className="free-review-run-override">
      <ExecutorPickerField
        label="本次审查用"
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
      {changed && (
        <div className="free-review-save-mode" role="radiogroup" aria-label="改动的保存方式">
          {modes.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={saveMode === mode.value}
              disabled={disabled}
              onClick={() => onSaveModeChange(mode.value)}
            >
              <b>{mode.label}</b><small>{mode.hint}</small>
            </button>
          ))}
          {saveMode === "new" && (
            <label className="free-review-new-name">
              <span>新审查者名称</span>
              <input
                value={newName}
                disabled={disabled}
                placeholder={`例如：${reviewer.name} · 加强版`}
                onChange={(event) => onNewNameChange(event.target.value)}
              />
            </label>
          )}
          <small className="free-review-save-hint">无论选哪种，这次审查都按上面改后的配置跑。</small>
        </div>
      )}
    </div>
  );
}
