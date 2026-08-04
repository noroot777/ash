import type { ReactNode } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  Priority,
  TaskMode,
  TeamPresetConfig,
} from "@harness/shared";
import { CaretDown, GearSix, SlidersHorizontal } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { ModelCatalogField, type EffortStep } from "../components/ModelCatalogField.tsx";
import { Toggle } from "../components/ui.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import {
  executorOptions,
  executorRunSummary,
  executorValue,
  parseExecutorValue,
} from "../lib/agentAvailability.ts";
import type { ComposerExecutorConfigs, ComposerExecutorRole } from "./executorOverrides.ts";
import { ExecutorPickerField } from "./ExecutorPickerField.tsx";
import { PresetBar } from "./PresetBar.tsx";

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "none", label: "无优先级" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "urgent", label: "紧急" },
];

export function ExecutorSelect({
  label,
  value,
  types,
  profiles,
  knownProfiles,
  fallbackType,
  override,
  onChange,
}: {
  label: string;
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles: AgentExecutorProfile[];
  fallbackType: AgentType;
  /** 该角色的模型/思考强度覆盖——决定这一栏底下写什么，见 executorRunSummary。 */
  override?: { model?: string | null; effort?: string | null };
  onChange: (value: string) => void;
}) {
  const selection = parseExecutorValue(value, knownProfiles, { agentType: fallbackType, executorId: null });
  const options = executorOptions({ types, profiles, knownProfiles, selection });
  const pickableCount = types.length + profiles.length;
  // 选项文本里的模型是 Profile 自带的那个;覆盖存在时它就不是实际会跑的模型了。
  const run = executorRunSummary(selection, knownProfiles, override);
  return (
    <div className="composer-field">
      <span>{label}</span>
      <Dropdown
        label={label}
        value={pickableCount || options.length ? executorValue(selection) : ""}
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
        onChange={onChange}
      />
      {run.overridden && (
        <small className="composer-field-run">
          实际运行：{run.model ?? "跟随执行器"}{run.effort ? ` · ${run.effort}` : ""}
          <em>覆盖</em>
        </small>
      )}
    </div>
  );
}

/**
 * 候选来自统一的模型目录（供应商固定清单或实时 API），不再只有 CLI 别名。
 * 传 `effort` 时思考强度是同一个下拉的第二步——先定模型再定档位，因为档位表
 * 是跟着模型走的。
 */
export function ModelField({
  label,
  value,
  type,
  profiles,
  effort,
  onChange,
}: {
  label: string;
  value: string;
  type: AgentType;
  profiles: AgentExecutorProfile[];
  effort?: EffortStep;
  onChange: (value: string) => void;
}) {
  return (
    <ModelCatalogField
      label={label}
      value={value}
      type={type}
      profiles={profiles}
      effort={effort}
      onChange={onChange}
    />
  );
}

function OverrideGroup({
  role,
  label,
  config,
  type,
  profiles,
  onChange,
}: {
  role: ComposerExecutorRole;
  label: string;
  config: ComposerExecutorConfigs[ComposerExecutorRole];
  type: AgentType;
  profiles: AgentExecutorProfile[];
  onChange: (role: ComposerExecutorRole, patch: { model?: string; effort?: string }) => void;
}) {
  return (
    <div className="composer-override-group">
      <b>{label}</b>
      <div>
        <ModelField
          label="模型"
          value={config.model}
          type={type}
          profiles={profiles}
          effort={{ value: config.effort, onChange: (effort) => onChange(role, { effort }) }}
          onChange={(model) => onChange(role, { model })}
        />
      </div>
    </div>
  );
}

export function ComposerFields({
  mode,
  profiles,
  workerTypes,
  leadTypes,
  leadProfiles,
  executors,
  executorTypes,
  availabilityMessage,
  availabilityTone,
  onExecutorChange,
  onOverrideChange,
  currentTeamConfig,
  onApplyTeamPreset,
  notify,
  debaterAProfile,
  debaterBProfile,
  onDebaterAChange,
  onDebaterBChange,
  review,
  onReviewChange,
  rounds,
  onRoundsChange,
  gate,
  onGateChange,
  isRepo,
  useWorktree,
  onUseWorktreeChange,
  branches,
  base,
  onBaseChange,
  groups,
  groupId,
  onGroupChange,
  priority,
  onPriorityChange,
  labels,
  onLabelsChange,
  onCreateGroup,
  workflowSlot,
}: {
  mode: TaskMode;
  profiles: AgentExecutorProfile[];
  workerTypes: AgentType[];
  leadTypes: AgentType[];
  leadProfiles: AgentExecutorProfile[];
  executors: ComposerExecutorConfigs;
  executorTypes: Record<ComposerExecutorRole, AgentType>;
  availabilityMessage: string | null;
  availabilityTone: "loading" | "warning" | "empty" | null;
  onExecutorChange: (role: ComposerExecutorRole, value: string) => void;
  onOverrideChange: (role: ComposerExecutorRole, patch: { model?: string; effort?: string }) => void;
  currentTeamConfig: TeamPresetConfig;
  onApplyTeamPreset: (config: TeamPresetConfig) => void;
  notify: (message: string) => void;
  debaterAProfile: string;
  debaterBProfile: string;
  onDebaterAChange: (value: string) => void;
  onDebaterBChange: (value: string) => void;
  review: boolean;
  onReviewChange: (value: boolean) => void;
  rounds: string;
  onRoundsChange: (value: string) => void;
  gate: boolean;
  onGateChange: (value: boolean) => void;
  isRepo: boolean;
  useWorktree: boolean;
  onUseWorktreeChange: (value: boolean) => void;
  branches: string[];
  base: string;
  onBaseChange: (value: string) => void;
  groups: Group[];
  groupId: string;
  onGroupChange: (value: string) => void;
  priority: Priority;
  onPriorityChange: (value: Priority) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  onCreateGroup: () => void;
  /** 「干完之后」那一节。它只在单任务下出现，位置固定在执行模式与任务选项之间。 */
  workflowSlot?: ReactNode;
}) {
  const overrideRoles: ComposerExecutorRole[] = mode === "team" ? ["lead", "worker", "reviewer"] : ["single"];
  const overrideCount = overrideRoles.reduce(
    (count, role) => count + Number(!!executors[role].model) + Number(!!executors[role].effort),
    0,
  );

  return (
    <div className="composer-config">
      <section className="composer-config-section is-execution">
        <header className="composer-section-heading">
          <span><SlidersHorizontal size={14} /></span>
          <div><h2>执行模式</h2><p>决定由谁接手，以及团队内的角色分工。</p></div>
        </header>
        {mode === "team" && (
          <PresetBar currentConfig={currentTeamConfig} profiles={profiles} onApply={onApplyTeamPreset} notify={notify} />
        )}
        <div className={`composer-executor-grid is-${mode}`}>
          {mode === "single" && (
            <ExecutorPickerField label="执行器" value={executors.single.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="claude" override={executors.single} onChange={(value) => onExecutorChange("single", value)} onOverrideChange={(patch) => onOverrideChange("single", patch)} />
          )}
          {mode === "team" && (
            <>
              <ExecutorPickerField label="调度者执行器" value={executors.lead.profile} types={leadTypes} profiles={leadProfiles} knownProfiles={profiles} fallbackType="claude" override={executors.lead} onChange={(value) => onExecutorChange("lead", value)} onOverrideChange={(patch) => onOverrideChange("lead", patch)} />
              <ExecutorPickerField label="执行者执行器" value={executors.worker.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="codex" override={executors.worker} onChange={(value) => onExecutorChange("worker", value)} onOverrideChange={(patch) => onOverrideChange("worker", patch)} />
              <ExecutorPickerField label="审查者执行器" value={executors.reviewer.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType={executorTypes.worker} override={executors.reviewer} onChange={(value) => onExecutorChange("reviewer", value)} onOverrideChange={(patch) => onOverrideChange("reviewer", patch)} />
            </>
          )}
          {mode === "debate" && (
            // 辩手只选执行器：辩论配置里没有「每个辩手各自的模型」这个字段（见 shared 的
            // DebateConfig），换成四步选择器会让人选完模型却无处存放。
            <>
              <ExecutorSelect label="正方执行器" value={debaterAProfile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="claude" onChange={onDebaterAChange} />
              <ExecutorSelect label="反方执行器" value={debaterBProfile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="codex" onChange={onDebaterBChange} />
            </>
          )}
        </div>
        {availabilityMessage && (
          <p className={`composer-agent-availability is-${availabilityTone ?? "warning"}`}>{availabilityMessage}</p>
        )}
      </section>

      {workflowSlot}

      {mode !== "debate" && (
        <details className="composer-advanced">
          <summary>
            <span className="composer-advanced-icon"><GearSix size={14} /></span>
            <span><b>高级配置</b><small>模型与思考强度默认跟随执行器</small></span>
            {overrideCount > 0 && <em>{overrideCount} 项覆盖</em>}
            <CaretDown className="composer-advanced-caret" size={13} />
          </summary>
          <div className="composer-advanced-body">
            {mode === "single" && (
              <OverrideGroup role="single" label="执行器覆盖" config={executors.single} type={executorTypes.single} profiles={profiles} onChange={onOverrideChange} />
            )}
            {mode === "team" && (
              <>
                <OverrideGroup role="lead" label="调度者覆盖" config={executors.lead} type={executorTypes.lead} profiles={profiles} onChange={onOverrideChange} />
                <OverrideGroup role="worker" label="执行者覆盖" config={executors.worker} type={executorTypes.worker} profiles={profiles} onChange={onOverrideChange} />
                <OverrideGroup role="reviewer" label="审查者覆盖" config={executors.reviewer} type={executorTypes.reviewer} profiles={profiles} onChange={onOverrideChange} />
              </>
            )}
          </div>
        </details>
      )}

      <section className="composer-config-section is-options">
        <header className="composer-section-heading">
          <span><GearSix size={14} /></span>
          <div><h2>任务选项</h2><p>运行位置、组织方式与调度优先级。</p></div>
        </header>
        <div className="composer-option-grid">
          {mode === "team" && (
            <label className="composer-toggle-field">
              <span>自动审查</span>
              <Toggle checked={review} onChange={onReviewChange} label={review ? "已开启" : "已关闭"} />
            </label>
          )}
          {mode === "debate" && (
            <>
              <div className="composer-field">
                <span>最多轮数</span>
                <Dropdown
                  label="最多轮数"
                  value={rounds}
                  options={[
                    { value: "", label: "不限" },
                    ...[1, 2, 3, 5, 8].map((value) => ({ value: String(value), label: `${value} 轮` })),
                  ]}
                  filterable={false}
                  placeholder="不限"
                  onChange={onRoundsChange}
                />
              </div>
              <label className="composer-toggle-field">
                <span>共识闸门</span>
                <Toggle checked={gate} onChange={onGateChange} label={gate ? "需要确认" : "自动结束"} />
              </label>
            </>
          )}
          {mode !== "debate" && isRepo && (
            <>
              <label className="composer-toggle-field">
                <span>worktree</span>
                <Toggle checked={useWorktree} onChange={onUseWorktreeChange} label={useWorktree ? "独立 worktree" : "直接使用项目目录"} />
              </label>
              <div className="composer-field">
                <span>base 分支</span>
                <Dropdown
                  label="base 分支"
                  value={base}
                  options={[
                    { value: "", label: "当前 HEAD" },
                    ...branches.map((branch) => ({ value: branch, label: branch, mono: true })),
                  ]}
                  disabled={!useWorktree}
                  filterable={branches.length > 6}
                  filterPlaceholder="筛选分支…"
                  placeholder="当前 HEAD"
                  onChange={onBaseChange}
                />
              </div>
            </>
          )}
          {mode !== "debate" && (
            <div className="composer-field">
              <span>分组</span>
              <Dropdown
                label="分组"
                value={groupId}
                options={[
                  { value: "", label: "无分组" },
                  ...groups.filter((group) => !group.ownerTaskId).map((group) => ({
                    value: group.id,
                    label: group.name,
                    detail: group.mode === "parallel" ? "并行" : "串行",
                  })),
                  { value: "__new", label: "＋ 新建分组…" },
                ]}
                filterable={groups.length > 6}
                filterPlaceholder="筛选分组…"
                placeholder="无分组"
                onChange={(value) => {
                  if (value === "__new") onCreateGroup();
                  else onGroupChange(value);
                }}
              />
            </div>
          )}
          <div className="composer-field">
            <span>优先级</span>
            <Dropdown
              label="优先级"
              value={priority}
              options={PRIORITIES.map((item) => ({ value: item.value, label: item.label }))}
              filterable={false}
              onChange={(value) => onPriorityChange(value as Priority)}
            />
          </div>
          <div className="composer-label-field">
            <span>标签</span>
            <TaskLabelsEditor labels={labels} onChange={onLabelsChange} />
          </div>
        </div>
      </section>
    </div>
  );
}
