// 点开一颗 chip 之后弹出来的东西：**只有这一个字段**，选完即关。
//
// 设计上刻意不做成「选中这一站 → 右边面板 → 找到那一行」的三步走：一条几站的线，
// 绝大多数改动应该是一次点击。所以每种字段的编辑器都做得尽量短，能一眼看完。
//
// 例外是执行器那一组（谁来干 / 什么模型 / 多大强度）：它们本来就是联动的一组，
// 拆成三个弹层反而更烦，所以点其中任意一颗都开这一个编辑器。
import { REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import type { FailPolicy, WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { FAIL_MODES, FAIL_MODE_LABELS, MAX_FAIL_ROUNDS } from "@harness/shared/workflow";
import { ProviderModelInput } from "../settings/ProviderModelInput.tsx";
import { backTargets } from "./workflowEdit.ts";
import { executorProfile, providerOf, type ExecutorCatalog } from "./executorCatalog.ts";
import type { FieldSpec } from "./stepFields.ts";

// 没指定执行器时给不出「这个 CLI 支持哪些档位」，用通用档位兜着，真正的取舍由
// 任务自己的执行器设置决定。
const GENERIC_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export function SelectEditor({
  spec, value, onPick,
}: {
  spec: Extract<FieldSpec, { type: "select" }>;
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="wf-pop-options" role="listbox" aria-label={spec.label}>
      {spec.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={option.value === value}
          className={`wf-pop-option${option.value === value ? " is-on" : ""}`}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function MultiEditor({
  spec, values, onToggle,
}: {
  spec: Extract<FieldSpec, { type: "multi" }>;
  values: string[];
  onToggle: (next: string[]) => void;
}) {
  const flip = (value: string) => {
    onToggle(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  };
  return (
    <div className="wf-pop-options">
      {spec.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={values.includes(option.value)}
          className={`wf-pop-option${values.includes(option.value) ? " is-on" : ""}`}
          onClick={() => flip(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function TextEditor({
  spec, value, onChange,
}: {
  spec: Extract<FieldSpec, { type: "text" }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      className="wf-pop-text"
      value={value}
      rows={spec.key === "instruction" ? 3 : 1}
      placeholder={spec.placeholder}
      spellCheck={false}
      autoFocus
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function ExecutorEditor({
  step, catalog, onPatch,
}: {
  step: WorkflowStep;
  catalog: ExecutorCatalog;
  onPatch: (patch: Record<string, string | null>) => void;
}) {
  const params = step.p as { executorId: string | null; model?: string | null; reasoningEffort?: string | null };
  const profile = executorProfile(catalog, params.executorId);
  const provider = providerOf(catalog, profile);
  const efforts = profile ? REASONING_EFFORT_VALUES[profile.type] : GENERIC_EFFORTS;

  return (
    <div className="wf-pop-form">
      <label className="wf-pop-row">
        <span>谁来干</span>
        <select
          value={params.executorId ?? ""}
          onChange={(event) => onPatch({
            executorId: event.target.value || null,
            // 换执行器就把模型和强度打回「跟随执行器」——留着上一个执行器的模型名
            // 多半跑不起来，这跟 composer 换执行器的规矩是同一条。
            model: null,
            reasoningEffort: null,
          })}
        >
          <option value="">跟随任务的执行器</option>
          {catalog.profiles.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}{candidate.isDefault ? "（默认）" : ""}
            </option>
          ))}
          {params.executorId && !profile && (
            <option value={params.executorId} disabled>这个执行器已经不在了</option>
          )}
        </select>
      </label>

      {"model" in params && (
        <label className="wf-pop-row">
          <span>模型</span>
          {profile ? (
            <ProviderModelInput
              type={profile.type}
              provider={provider}
              value={params.model ?? ""}
              compact
              onChange={(model) => onPatch({ model: model.trim() || null })}
            />
          ) : (
            <input
              className="wf-pop-input"
              value={params.model ?? ""}
              placeholder="跟随执行器"
              spellCheck={false}
              onChange={(event) => onPatch({ model: event.target.value.trim() || null })}
            />
          )}
        </label>
      )}

      {"reasoningEffort" in params && (
        <label className="wf-pop-row">
          <span>思考强度</span>
          <select
            value={params.reasoningEffort ?? ""}
            onChange={(event) => onPatch({ reasoningEffort: event.target.value || null })}
          >
            <option value="">跟随执行器</option>
            {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

export function FailEditor({
  def, step, onPatch,
}: {
  def: WorkflowDef;
  step: WorkflowStep;
  onPatch: (patch: Partial<FailPolicy>) => void;
}) {
  const fail = step.fail;
  if (!fail) return null;
  const targets = backTargets(def, step.id);

  return (
    <div className="wf-pop-form">
      <div className="wf-pop-options">
        {FAIL_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`wf-pop-option${fail.mode === mode ? " is-on" : ""}`}
            disabled={mode === "back" && !targets.length}
            onClick={() => onPatch(
              mode === "back" ? { mode, backTo: fail.backTo ?? targets[targets.length - 1]?.id ?? null } : { mode },
            )}
          >
            {FAIL_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      {!targets.length && (
        <p className="wf-pop-hint">这是第一站，前面没有可以回去的地方。</p>
      )}
      {fail.mode === "back" && (
        <>
          <label className="wf-pop-row">
            <span>回到哪一站</span>
            <select value={fail.backTo ?? ""} onChange={(event) => onPatch({ backTo: event.target.value })}>
              {targets.map((target, i) => (
                <option key={target.id} value={target.id}>第 {i + 1} 站</option>
              ))}
            </select>
          </label>
          <label className="wf-pop-row">
            <span>最多重做</span>
            <select value={fail.max} onChange={(event) => onPatch({ max: Number(event.target.value) })}>
              {Array.from({ length: MAX_FAIL_ROUNDS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n} 轮</option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
