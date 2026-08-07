import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { sameExecutor } from "@harness/shared/executors";
import { WarningCircle } from "@phosphor-icons/react";
import { EffortPicker } from "../components/EffortPicker.tsx";
import { ExecutorModelPicker } from "../components/ExecutorModelPicker.tsx";
import {
  executorRunSummary,
  executorValue,
  isExecutorPickable,
  parseExecutorValue,
} from "../lib/agentAvailability.ts";

/**
 * 新建任务里的「选执行器」——和对话框 `@` 那套是**同一个** AgentModelPicker：
 * 智能体 → 模型（按供应商分块）一路选到底。
 *
 * 以前这里是一个只列执行器的下拉，模型得再去「高级配置」里单独设；两个地方交互
 * 不一样、还得来回跳，而它们要回答的其实是同一个问题：这活儿派给谁、用哪家的哪个
 * 模型。所以直接复用对话框那套浮层，别再各画各的。
 *
 * 摆成两颗胶囊：前面「执行器 · 模型」，后面「思考强度」。强度不跟着模型走同一个
 * 浮层——只想调档位的人不该被逼着重选一遍模型；模型不支持已选档位时由后面那颗自己
 * 出提示，见 components/EffortPicker.tsx。
 *
 * 有的表面还多一档「不指定」（工作流的站点可以跟随任务的执行器）：传 `unsetText`
 * 就打开这一档，`onUnset` 是改回去的入口。别为这一档另做一副形状——它只是这副形状
 * 的一个取值。
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
  onOverrideChange,
}: {
  label: string;
  /** 空串 = 还没指定；只有传了 unsetText 的表面会用到这一档。 */
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles: AgentExecutorProfile[];
  fallbackType: AgentType;
  /** 该角色的模型/思考强度覆盖——决定胶囊上写的「实际会跑什么」，见 executorRunSummary。 */
  override?: { model?: string | null; effort?: string | null };
  disabled?: boolean;
  /** 传了就允许「不指定执行器」：value 为空时胶囊写这句话（如「跟随任务的执行器」）。 */
  unsetText?: string;
  /** 传了就多给一个改回「不指定」的入口——不然选出去就回不来了。 */
  onUnset?: () => void;
  onChange: (value: string) => void;
  /** 不传就只落执行器（讨论者那种服务端根本不收模型的表面）。 */
  onOverrideChange?: (patch: { model?: string; effort?: string }) => void;
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
        <ExecutorModelPicker
          label={label}
          types={types}
          profiles={profiles}
          knownProfiles={knownProfiles}
          selection={selection}
          fallbackType={fallbackType}
          model={run.model}
          disabled={disabled}
          unsetText={unsetText}
          onCommit={(target) => {
            // 先落执行器：切换执行器会把模型/强度清成「跟随」（executorOverrides.ts），
            // 所以这一步必须在覆盖之前，否则刚选的模型当场被清掉。
            onChange(executorValue({ agentType: target.agent, executorId: target.executorId }));
            // 执行器没换就把强度原样放回去：这颗胶囊管的是执行器和模型，用户只是换了
            // 个模型，不该顺手把旁边那颗清掉。真换了执行器才跟着清（旧档位在新 CLI
            // 上多半根本不存在，见 shared/executor-overrides.ts）；原来压根没指定
            // 执行器的，同样按「换了」算。
            const kept = selection && sameExecutor(
              { agentType: target.agent, executorId: target.executorId },
              selection,
            ) ? override?.effort ?? "" : "";
            onOverrideChange?.({ model: target.model ?? "", effort: kept });
          }}
        />
        {onOverrideChange && (
          <EffortPicker
            type={selection?.agentType ?? null}
            model={run.model}
            value={override?.effort ?? ""}
            disabled={disabled || empty}
            onChange={(effort) => onOverrideChange({ effort })}
          />
        )}
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
