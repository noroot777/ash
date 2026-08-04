import type { ReactNode } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { Dropdown, type DropdownStep } from "./Dropdown.tsx";
import { effortStepOf, modelCatalogStep } from "./ModelCatalogField.tsx";
import { useAgentModelCatalog, useProviders } from "../lib/modelCatalog.ts";
import { executorOptions, executorValue, parseExecutorValue } from "../lib/agentAvailability.ts";

/**
 * 「这一栏派谁跑」的统一控件：**执行器 → 模型 → 思考强度**，一个下拉里依次问完。
 *
 * 之所以是一个控件而不是三个并排的下拉：后两步的候选完全由前一步决定——模型目录跟着
 * 执行器挂的供应商走，档位表跟着 CLI 走。并排摆着的话，用户可以在还没选执行器时先挑
 * 一个该执行器根本没有的模型/档位，非法组合要等 CLI 真跑起来才被上游拒绝。原来的做法
 * 更远一层：执行器在「执行模式」区、模型和强度折在下面的「高级配置」里，同一个决定被
 * 拆到两个区块。
 *
 * 只传 `onChange` 就退化成纯执行器选择器（辩论那种没有模型覆盖的场景）；`onModelChange`
 * / `onEffortChange` 传谁就多出哪一步。换执行器时把模型与强度重置为「跟随执行器」是
 * **调用方**的责任（见 web-next/CLAUDE.md），这里不替它决定。
 */
export function ExecutorModelField({
  label,
  value,
  types,
  profiles,
  knownProfiles = profiles,
  fallbackType,
  model = "",
  effort = "",
  hint,
  className = "composer-field",
  onChange,
  onModelChange,
  onEffortChange,
}: {
  label: string;
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles?: AgentExecutorProfile[];
  fallbackType: AgentType;
  /** 模型覆盖，空 = 跟随执行器。 */
  model?: string;
  /** 思考强度覆盖，空 = 跟随执行器。 */
  effort?: string;
  /** 控件下方那行小字（例：实际运行的模型）。 */
  hint?: ReactNode;
  className?: string;
  onChange: (value: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
}) {
  const selection = parseExecutorValue(value, knownProfiles, { agentType: fallbackType, executorId: null });
  const options = executorOptions({ types, profiles, knownProfiles, selection });
  const pickableCount = types.length + profiles.length;

  const providers = useProviders();
  // 没有模型这一步时传 null：省掉一整轮 /models 探测。
  const groups = useAgentModelCatalog(onModelChange ? selection.agentType : null, knownProfiles, providers);

  const steps: DropdownStep[] = [];
  if (onModelChange) steps.push(modelCatalogStep(groups, model, onModelChange));
  const effortStep = onEffortChange
    ? effortStepOf(selection.agentType, { value: effort, onChange: onEffortChange })
    : undefined;
  if (effortStep) steps.push(effortStep);

  const overridden = [model, effort].filter(Boolean);
  const clearable = !!(onModelChange || onEffortChange) && overridden.length > 0;
  const currentValue = pickableCount || options.length ? executorValue(selection) : "";

  return (
    <div className={className}>
      <span>{label}</span>
      <Dropdown
        label={label}
        value={currentValue}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          disabled: option.disabled,
        }))}
        disabled={pickableCount === 0}
        filterable={options.length > 6}
        filterPlaceholder="筛选执行器…"
        placeholder="暂无可用执行器"
        emptyText="没有匹配的执行器"
        displaySuffix={overridden.join(" · ")}
        steps={steps.length ? steps : undefined}
        onClear={clearable ? () => { onModelChange?.(""); onEffortChange?.(""); } : undefined}
        clearLabel="模型与强度跟随执行器"
        // 选中的还是原来那个执行器时不回调：调用方在换执行器时会把模型与强度清空，
        // 而「只想改模型」的人必须先路过这一步——不拦住的话他每次都会先把自己的
        // 覆盖清掉一次。
        onChange={(next) => { if (next !== currentValue) onChange(next); }}
      />
      {hint}
    </div>
  );
}
