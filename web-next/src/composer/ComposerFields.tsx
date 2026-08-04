import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  Priority,
  TaskMode,
  TeamPresetConfig,
} from "@harness/shared";
import { GearSix, SlidersHorizontal } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { ExecutorModelField } from "../components/ExecutorModelField.tsx";
import { Toggle } from "../components/ui.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import { executorRunSummary, parseExecutorValue } from "../lib/agentAvailability.ts";
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
  /** 该角色的模型/思考强度覆盖——决定这一栏底下写什么，见 executorRunSummary。 */
  override?: { model?: string | null; effort?: string | null };
  onChange: (value: string) => void;
  /** 传了就在同一个下拉里接着选模型与思考强度；不传就是纯执行器选择（辩论）。 */
  onOverrideChange?: (patch: { model?: string; effort?: string }) => void;
}) {
  const selection = parseExecutorValue(value, knownProfiles, { agentType: fallbackType, executorId: null });
  // 选项文本里的模型是 Profile 自带的那个;覆盖存在时它就不是实际会跑的模型了。
  const run = executorRunSummary(selection, knownProfiles, override);
  return (
    <ExecutorModelField
      label={label}
      value={value}
      types={types}
      profiles={profiles}
      knownProfiles={knownProfiles}
      fallbackType={fallbackType}
      model={override?.model ?? ""}
      effort={override?.effort ?? ""}
      onChange={onChange}
      onModelChange={onOverrideChange ? (model) => onOverrideChange({ model }) : undefined}
      onEffortChange={onOverrideChange ? (effort) => onOverrideChange({ effort }) : undefined}
      hint={run.overridden && (
        <small className="composer-field-run">
          实际运行：{run.model ?? "跟随执行器"}{run.effort ? ` · ${run.effort}` : ""}
          <em>覆盖</em>
        </small>
      )}
    />
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
}) {
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
            <ExecutorSelect label="执行器" value={executors.single.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="claude" override={executors.single} onChange={(value) => onExecutorChange("single", value)} onOverrideChange={(patch) => onOverrideChange("single", patch)} />
          )}
          {mode === "team" && (
            <>
              <ExecutorSelect label="调度者执行器" value={executors.lead.profile} types={leadTypes} profiles={leadProfiles} knownProfiles={profiles} fallbackType="claude" override={executors.lead} onChange={(value) => onExecutorChange("lead", value)} onOverrideChange={(patch) => onOverrideChange("lead", patch)} />
              <ExecutorSelect label="执行者执行器" value={executors.worker.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="codex" override={executors.worker} onChange={(value) => onExecutorChange("worker", value)} onOverrideChange={(patch) => onOverrideChange("worker", patch)} />
              <ExecutorSelect label="审查者执行器" value={executors.reviewer.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType={executorTypes.worker} override={executors.reviewer} onChange={(value) => onExecutorChange("reviewer", value)} onOverrideChange={(patch) => onOverrideChange("reviewer", patch)} />
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
