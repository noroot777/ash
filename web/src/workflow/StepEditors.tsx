// 点开一颗 chip 之后弹出来的东西：**只有这一个字段**，选完即关。
//
// 设计上刻意不做成「选中这一站 → 右边面板 → 找到那一行」的三步走：一条几站的线，
// 绝大多数改动应该是一次点击。所以每种字段的编辑器都做得尽量短，能一眼看完。
//
// 例外是执行器那一组（谁来干 / 什么模型 / 多高的智能水平）：它们本来就是联动的一组，
// 拆成三个弹层反而更烦，所以点其中任意一颗都开这一个编辑器。这一组不自己画控件，
// 直接用全站统一的那副形状（composer/ExecutorPickerField.tsx 的三段胶囊）。
import type { FailPolicy, WorkflowStep } from "@ash/shared/workflow";
import { FAIL_MODES, FAIL_MODE_LABELS, MAX_FAIL_ROUNDS } from "@ash/shared/workflow";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import { executorValue, parseExecutorValue, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { executorProfile, type ExecutorCatalog } from "./executorCatalog.ts";
import type { FieldSpec } from "./stepFields.ts";

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
      {/* 「一个都不选」得有个能点的地方。靠「把最后一项也点掉」表达同一件事，界面上看不
          出这是允许的（人工关口尤其：什么都不给、自己去点前一站的预览，是正经用法）。 */}
      {spec.emptyOk && (
        <button
          type="button"
          aria-pressed={!values.length}
          className={`wf-pop-option is-none${values.length ? "" : " is-on"}`}
          onClick={() => onToggle([])}
        >
          {spec.emptyText}
        </button>
      )}
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
    <div className="wf-pop-form">
      <textarea
        className="wf-pop-text"
        value={value}
        rows={spec.key === "instruction" ? 3 : 1}
        placeholder={spec.placeholder}
        spellCheck={false}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
      />
      {/* 填的时候就得知道的事（典型：预览的 $PORT），写在填字的地方才有用 —— 等命令
          跑挂了再从日志里看出来，用户已经白等一轮了。 */}
      {spec.hint && <p className="wf-pop-hint">{spec.hint}</p>}
    </div>
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
  const types = registeredAgentTypes(catalog.profiles);
  const missing = !!params.executorId && !profile;

  return (
    <div className="wf-pop-form">
      {/* 跟新建面板、模式预设同一副形状的三段胶囊，多一档「跟随任务的执行器」。 */}
      <ExecutorPickerField
        label="智能体 · 模型 · 智能水平"
        value={profile ? executorValue({ agentType: profile.type, executorId: profile.id }) : ""}
        types={types}
        profiles={catalog.profiles}
        knownProfiles={catalog.profiles}
        fallbackType={profile?.type ?? types[0] ?? "claude"}
        override={{ model: params.model, effort: params.reasoningEffort }}
        unsetText="跟随任务的执行器"
        // 换执行器就把模型和强度打回「跟随执行器」由 ExecutorPickerField 负责；改回
        // 跟随任务时三项一起清——这一站从此完全照任务的执行器跑，留着旧模型名多半
        // 跑不起来。
        onUnset={() => onPatch({ executorId: null, model: null, reasoningEffort: null })}
        onChange={(next, override) => {
          const picked = parseExecutorValue(next, catalog.profiles, {
            agentType: profile?.type ?? types[0] ?? "claude",
            executorId: null,
          });
          // 站点参数只存 executorId，null 在这儿的意思是「跟随任务的执行器」而不是
          // 「类型默认」。所以选中的行没带 Profile（没挂 Profile 的供应商那一块）时，
          // 落到该类型的默认 Profile 上，别写成 null 把语义偷换了。
          const byType = catalog.profiles.find((p) => p.type === picked.agentType && p.isDefault)
            ?? catalog.profiles.find((p) => p.type === picked.agentType);
          onPatch({
            executorId: picked.executorId ?? byType?.id ?? null,
            model: override.model.trim() || null,
            reasoningEffort: override.effort || null,
          });
        }}
        onEffortChange={(effort) => onPatch({ reasoningEffort: effort || null })}
      />
      {missing && (
        // 失效的 id 还在参数里（胶囊上没法照实显示一个不存在的执行器），得给条清掉它的路。
        <p className="wf-pop-hint">
          原来指定的执行器已经不在了。
          <button
            type="button"
            className="composer-field-unset"
            onClick={() => onPatch({ executorId: null, model: null, reasoningEffort: null })}
          >
            清掉它，跟随任务的执行器
          </button>
        </p>
      )}
    </div>
  );
}

export function FailEditor({
  step, onPatch,
}: {
  step: WorkflowStep;
  onPatch: (patch: Partial<FailPolicy>) => void;
}) {
  const fail = step.fail;
  if (!fail) return null;

  return (
    <div className="wf-pop-form">
      <div className="wf-pop-options">
        {FAIL_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`wf-pop-option${fail.mode === mode ? " is-on" : ""}`}
            onClick={() => onPatch({ mode })}
          >
            {FAIL_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      {/* 「打回给 AI 重做」就是把报错交回给干活的那个 agent 自己修 —— 没有「回到第几站」
          这个旋钮：夹在锚点之间的命令/预览是成段跑的，单独回到其中一站既没有触发它的
          事件，也没有从那儿接着往下的入口。所以只剩「最多来几轮」要选。 */}
      {fail.mode === "back" && (
        <label className="wf-pop-row">
          <span>最多重做</span>
          <select value={fail.max} onChange={(event) => onPatch({ max: Number(event.target.value) })}>
            {Array.from({ length: MAX_FAIL_ROUNDS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n} 轮</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
