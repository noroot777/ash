import { useRef, useState } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { CaretDown, Robot, WarningCircle } from "@phosphor-icons/react";
import { AgentModelPicker } from "../task-detail/AgentModelPicker.tsx";
import { useProviders } from "../lib/modelCatalog.ts";
import {
  executorRunSummary,
  executorValue,
  isExecutorPickable,
  parseExecutorValue,
} from "../lib/agentAvailability.ts";

/**
 * 新建任务里的「选执行器」——和对话框 `@` 那套是**同一个** AgentModelPicker：
 * 智能体 → 供应商 → 模型 → 思考强度，一路选到底。
 *
 * 以前这里是一个只列执行器的下拉，模型和强度得再去「高级配置」里单独设；两个地方
 * 交互不一样、还得来回跳，而它们要回答的其实是同一个问题：这活儿派给谁、用哪家的
 * 哪个模型、想多久。所以直接复用对话框那套浮层，别再各画各的。
 *
 * 落点上的两处差异（也仅有这两处）：
 * ① 浮层朝下弹（对话框在页面底部，是朝上弹的）——见 `.composer-executor-picker`；
 * ② 选完落到本角色的 profile/model/effort 三个状态上，而不是「本回合召唤」。
 */
export function ExecutorPickerField({
  label,
  value,
  types,
  profiles,
  knownProfiles,
  fallbackType,
  override,
  onChange,
  onOverrideChange,
}: {
  label: string;
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles: AgentExecutorProfile[];
  fallbackType: AgentType;
  /** 该角色的模型/思考强度覆盖——决定胶囊上写的「实际会跑什么」，见 executorRunSummary。 */
  override?: { model?: string | null; effort?: string | null };
  onChange: (value: string) => void;
  /** 不传就只落执行器（辩手那种服务端根本不收模型的表面）。 */
  onOverrideChange?: (patch: { model?: string; effort?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const providers = useProviders();

  const selection = parseExecutorValue(value, knownProfiles, { agentType: fallbackType, executorId: null });
  const profile = selection.executorId
    ? knownProfiles.find((candidate) => candidate.id === selection.executorId)
    : undefined;
  const run = executorRunSummary(selection, knownProfiles, override);
  const empty = types.length + profiles.length === 0;
  const unavailable = !empty && !isExecutorPickable(selection, types, profiles);

  return (
    <div className="composer-field">
      <span>{label}</span>
      <div className="composer-executor-picker">
        <button
          ref={triggerRef}
          type="button"
          className="ui-select-trigger composer-executor-trigger"
          disabled={empty}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label}：${selection.agentType}${profile ? ` · ${profile.name}` : ""}，模型 ${run.model ?? "跟随执行器"}${run.effort ? `，思考强度 ${run.effort}` : ""}；点击更改`}
          onClick={() => setOpen((current) => !current)}
        >
          {empty ? (
            <span className="is-placeholder">暂无可用执行器</span>
          ) : (
            <>
              <Robot size={12} aria-hidden="true" />
              <b>{selection.agentType}</b>
              <span>{profile ? profile.name : "类型默认"}</span>
              <code>{run.model ?? "跟随执行器"}</code>
              {run.effort && <em>{run.effort}</em>}
            </>
          )}
          <CaretDown size={11} weight="bold" className="ui-select-caret" aria-hidden="true" />
        </button>
        {open && (
          <AgentModelPicker
            types={types}
            profiles={profiles}
            providers={providers}
            initialStage="agent"
            initialAgent={selection.agentType}
            triggerRef={triggerRef}
            anchorRef={triggerRef}
            onCommit={(target) => {
              setOpen(false);
              // 先落执行器：切换执行器会把模型/强度清成「跟随」（executorOverrides.ts），
              // 所以这一步必须在覆盖之前，否则刚选的模型当场被清掉。
              onChange(executorValue({ agentType: target.agent, executorId: target.executorId }));
              onOverrideChange?.({ model: target.model ?? "", effort: target.reasoningEffort ?? "" });
              triggerRef.current?.focus();
            }}
            onCancel={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          />
        )}
      </div>
      {unavailable && (
        <small className="composer-field-run is-error">
          <WarningCircle size={11} weight="fill" aria-hidden="true" />
          {profile ? `${profile.name} 已不可用` : `${selection.agentType} 尚未注册`}，请重新选择
        </small>
      )}
    </div>
  );
}
