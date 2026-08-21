import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { WarningCircle } from "@phosphor-icons/react";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import {
  executorRunSummary,
  executorValue,
  isExecutorPickable,
  parseExecutorValue,
} from "../lib/agentAvailability.ts";

/**
 * 新建任务里的「选执行器」——和对话框 `@` 那套是**同一个** AgentModelPicker：
 * 智能体、模型（按供应商分块）用的是同一份候选。
 *
 * 以前这里是一个只列执行器的下拉，模型得再去「高级配置」里单独设；两个地方交互
 * 不一样、还得来回跳，而它们要回答的其实是同一个问题：这活儿派给谁、用哪家的哪个
 * 模型、跑多高的智能水平。所以直接复用全站统一的那颗胶囊，别再各画各的。
 *
 * 形状是**一颗三段胶囊：智能体 · 模型 · 智能水平**（components/RunTargetPicker.tsx）。
 * 三段各管一件事，也可从左往右连续配置：前一段选定后默认接着打开后一段。
 *
 * 有的表面还多一档「不指定」（工作流的站点可以跟随任务的执行器）：传 `unsetText`
 * 就打开这一档，`onUnset` 是改回去的入口。别为这一档另做一副形状——它只是这副形状
 * 的一个取值。
 *
 * **一次选择只回调一次**：选中一行同时决定「派给谁」和「模型/智能水平要不要清」，
 * 两者必须一起从 `onChange` 交出去。拆成两发（曾经的 onChange + onOverrideChange）会
 * 落在同一 tick 里，消费方从 props 旧值展开（`{...draft, model}`）时，后一发就把前一发
 * 刚选好的执行器盖回去。
 */
export function ExecutorPickerField({
  label,
  value,
  types,
  profiles,
  knownProfiles,
  fallbackType,
  override,
  disabled = false,
  unsetText,
  onUnset,
  onChange,
  onEffortChange,
}: {
  label: string;
  /** 空串 = 还没指定；只有传了 unsetText 的表面会用到这一档。 */
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles: AgentExecutorProfile[];
  fallbackType: AgentType;
  /** 该角色的模型/智能水平覆盖——决定胶囊上写的「实际会跑什么」，见 executorRunSummary。 */
  override?: { model?: string | null; effort?: string | null };
  disabled?: boolean;
  /** 传了就允许「不指定执行器」：value 为空时第一段写这句话（如「跟随任务的执行器」）。 */
  unsetText?: string;
  /** 传了就多给一个改回「不指定」的入口——不然选出去就回不来了。 */
  onUnset?: () => void;
  /**
   * 选了执行器或模型：`override` 是这次选择之后该存的模型与智能水平（换了执行器就
   * 是空串 = 跟随执行器）。两者是同一次选择的结果，一起落进同一次状态更新即可。
   */
  onChange: (value: string, override: { model: string; effort: string }) => void;
  /** 不传就只画前两段（讨论者那种服务端根本不收智能水平的表面）。 */
  onEffortChange?: (effort: string) => void;
}) {
  const unset = unsetText !== undefined && !value;
  const selection = unset
    ? null
    : parseExecutorValue(value, knownProfiles, { agentType: fallbackType, executorId: null });
  const profile = selection?.executorId
    ? knownProfiles.find((candidate) => candidate.id === selection.executorId)
    : undefined;
  const run = executorRunSummary(
    selection ?? { agentType: fallbackType, executorId: null },
    knownProfiles,
    override,
  );
  const empty = types.length + profiles.length === 0;
  const unavailable = !empty && !!selection && !isExecutorPickable(selection, types, profiles);

  return (
    <div className="composer-field">
      <span>{label}</span>
      <div className="composer-executor-picker">
        <RunTargetPicker
          label={label}
          types={types}
          profiles={profiles}
          knownProfiles={knownProfiles}
          selection={selection}
          fallbackType={fallbackType}
          model={run.model}
          effort={override?.effort ?? ""}
          disabled={disabled}
          unsetText={unsetText}
          onCommit={(target) => {
            // 执行器没换就把智能水平原样放回去：用户只是换了个模型，不该顺手把第三段
            // 清掉。真换了执行器才跟着清（旧档位在新 CLI 上多半根本不存在，见
            // shared/executor-overrides.ts）；原来压根没指定执行器的，同样按「换了」算。
            const kept = selection && sameExecutor(
              { agentType: target.agent, executorId: target.executorId },
              selection,
            ) ? override?.effort ?? "" : "";
            onChange(
              executorValue({ agentType: target.agent, executorId: target.executorId }),
              { model: target.model ?? "", effort: kept },
            );
          }}
          onEffortChange={onEffortChange}
        />
      </div>
      {onUnset && !unset && (
        <button type="button" className="composer-field-unset" disabled={disabled} onClick={onUnset}>
          改回{unsetText}
        </button>
      )}
      {unavailable && (
        <small className="composer-field-run is-error">
          <WarningCircle size={11} weight="fill" aria-hidden="true" />
          {profile ? `${profile.name} 已不可用` : `${selection?.agentType} 尚未注册`}，请重新选择
        </small>
      )}
    </div>
  );
}
