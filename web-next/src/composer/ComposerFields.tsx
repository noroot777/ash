import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  Priority,
  TaskMode,
  TeamPresetConfig,
} from "@harness/shared";
import { CLI_MODEL_PRESETS, REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import { CaretDown, GearSix, SlidersHorizontal } from "@phosphor-icons/react";
import { Toggle } from "../components/ui.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import {
  executorOptions,
  executorValue,
  parseExecutorValue,
} from "../lib/agentAvailability.ts";
import type { ComposerExecutorConfigs, ComposerExecutorRole } from "./executorOverrides.ts";
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
  onChange,
}: {
  label: string;
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles: AgentExecutorProfile[];
  fallbackType: AgentType;
  onChange: (value: string) => void;
}) {
  const selection = parseExecutorValue(value, knownProfiles, { agentType: fallbackType, executorId: null });
  const options = executorOptions({ types, profiles, knownProfiles, selection });
  const pickableCount = types.length + profiles.length;
  return (
    <label className="composer-field">
      <span>{label}</span>
      <select
        value={pickableCount || options.length ? executorValue(selection) : ""}
        disabled={pickableCount === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.length === 0 && <option value="">暂无可用执行器</option>}
        {options.map((option) => (
          <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function ModelField({
  role,
  label,
  value,
  type,
  onChange,
}: {
  role: string;
  label: string;
  value: string;
  type: AgentType;
  onChange: (value: string) => void;
}) {
  const listId = `composer-models-${type}-${role}`;
  return (
    <label className="composer-field">
      <span>{label}</span>
      <input
        value={value}
        list={listId}
        onChange={(event) => onChange(event.target.value)}
        placeholder="跟随执行器"
      />
      <datalist id={listId}>
        {CLI_MODEL_PRESETS[type].map((item) => <option value={item} key={item} />)}
      </datalist>
    </label>
  );
}

export function EffortField({
  label,
  value,
  type,
  onChange,
}: {
  label: string;
  value: string;
  type: AgentType;
  onChange: (value: string) => void;
}) {
  return (
    <label className="composer-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">跟随执行器</option>
        {REASONING_EFFORT_VALUES[type].map((item) => <option value={item} key={item}>{item}</option>)}
      </select>
    </label>
  );
}

function OverrideGroup({
  role,
  label,
  config,
  type,
  onChange,
}: {
  role: ComposerExecutorRole;
  label: string;
  config: ComposerExecutorConfigs[ComposerExecutorRole];
  type: AgentType;
  onChange: (role: ComposerExecutorRole, patch: { model?: string; effort?: string }) => void;
}) {
  return (
    <div className="composer-override-group">
      <b>{label}</b>
      <div>
        <ModelField role={role} label="模型" value={config.model} type={type} onChange={(model) => onChange(role, { model })} />
        <EffortField label="思考强度" value={config.effort} type={type} onChange={(effort) => onChange(role, { effort })} />
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
            <ExecutorSelect label="执行器" value={executors.single.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="claude" onChange={(value) => onExecutorChange("single", value)} />
          )}
          {mode === "team" && (
            <>
              <ExecutorSelect label="调度者执行器" value={executors.lead.profile} types={leadTypes} profiles={leadProfiles} knownProfiles={profiles} fallbackType="claude" onChange={(value) => onExecutorChange("lead", value)} />
              <ExecutorSelect label="执行者执行器" value={executors.worker.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="codex" onChange={(value) => onExecutorChange("worker", value)} />
              <ExecutorSelect label="审查者执行器" value={executors.reviewer.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType={executorTypes.worker} onChange={(value) => onExecutorChange("reviewer", value)} />
            </>
          )}
          {mode === "debate" && (
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
              <OverrideGroup role="single" label="执行器覆盖" config={executors.single} type={executorTypes.single} onChange={onOverrideChange} />
            )}
            {mode === "team" && (
              <>
                <OverrideGroup role="lead" label="调度者覆盖" config={executors.lead} type={executorTypes.lead} onChange={onOverrideChange} />
                <OverrideGroup role="worker" label="执行者覆盖" config={executors.worker} type={executorTypes.worker} onChange={onOverrideChange} />
                <OverrideGroup role="reviewer" label="审查者覆盖" config={executors.reviewer} type={executorTypes.reviewer} onChange={onOverrideChange} />
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
              <label className="composer-field">
                <span>最多轮数</span>
                <select value={rounds} onChange={(event) => onRoundsChange(event.target.value)}>
                  <option value="">不限</option>
                  {[1, 2, 3, 5, 8].map((value) => <option value={value} key={value}>{value} 轮</option>)}
                </select>
              </label>
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
              <label className="composer-field">
                <span>base 分支</span>
                <select value={base} disabled={!useWorktree} onChange={(event) => onBaseChange(event.target.value)}>
                  <option value="">当前 HEAD</option>
                  {branches.map((branch) => <option value={branch} key={branch}>{branch}</option>)}
                </select>
              </label>
            </>
          )}
          {mode !== "debate" && (
            <label className="composer-field">
              <span>分组</span>
              <select value={groupId} onChange={(event) => onGroupChange(event.target.value)}>
                <option value="">无分组</option>
                {groups.filter((group) => !group.ownerTaskId).map((group) => (
                  <option value={group.id} key={group.id}>{group.name} · {group.mode === "parallel" ? "并行" : "串行"}</option>
                ))}
              </select>
            </label>
          )}
          <label className="composer-field">
            <span>优先级</span>
            <select value={priority} onChange={(event) => onPriorityChange(event.target.value as Priority)}>
              {PRIORITIES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
            </select>
          </label>
          <div className="composer-label-field">
            <span>标签</span>
            <TaskLabelsEditor labels={labels} onChange={onLabelsChange} />
          </div>
        </div>
      </section>
    </div>
  );
}
