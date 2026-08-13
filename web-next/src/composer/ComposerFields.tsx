import type { ReactNode } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  TaskMode,
  TaskWorkflowMode,
  TeamPresetConfig,
} from "@harness/shared";
import { GearSix, SlidersHorizontal } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { PillTabs, Toggle } from "../components/ui.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import type { ComposerExecutorConfigs, ComposerExecutorRole } from "./executorOverrides.ts";
import { ExecutorPickerField } from "./ExecutorPickerField.tsx";
import { PresetBar } from "./PresetBar.tsx";

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
  onEffortChange,
  currentTeamConfig,
  onApplyTeamPreset,
  notify,
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
  labels,
  onLabelsChange,
  onCreateGroup,
  workflowSlot,
  workflowMode,
  onWorkflowModeChange,
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
  onExecutorChange: (
    role: ComposerExecutorRole,
    value: string,
    override: { model: string; effort: string },
  ) => void;
  onEffortChange: (role: ComposerExecutorRole, effort: string) => void;
  currentTeamConfig: TeamPresetConfig;
  onApplyTeamPreset: (config: TeamPresetConfig) => void;
  notify: (message: string) => void;
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
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  onCreateGroup: () => void;
  /** 「干完之后」那一节。它只在单任务下出现，位置固定在最上面（起手式即执行配置）。 */
  workflowSlot?: ReactNode;
  workflowMode: TaskWorkflowMode;
  onWorkflowModeChange: (mode: TaskWorkflowMode) => void;
}) {
  return (
    <div className="composer-config">
      {/* 单任务没有「执行模式」这一节：谁来干活写在起手式的「让 AI 干活」那一站上，
          两处各摆一个执行器选择迟早对不上（用户在这儿改了，起手式上还写着另一个）。
          团队/讨论仍要这一节 —— 它们的角色分工（调度者/执行者/审查者、两位讨论者）不在
          起手式里。 */}
      {mode !== "single" && (
      <section className="composer-config-section is-execution">
        <header className="composer-section-heading">
          <span><SlidersHorizontal size={14} /></span>
          <div><h2>执行模式</h2><p>决定由谁接手，以及团队内的角色分工。</p></div>
        </header>
        {mode === "team" && (
          <PresetBar currentConfig={currentTeamConfig} profiles={profiles} onApply={onApplyTeamPreset} notify={notify} />
        )}
        <div className={`composer-executor-grid is-${mode}`}>
          {mode === "team" && (
            <>
              <ExecutorPickerField label="调度者执行器" value={executors.lead.profile} types={leadTypes} profiles={leadProfiles} knownProfiles={profiles} fallbackType="claude" override={executors.lead} onChange={(value, override) => onExecutorChange("lead", value, override)} onEffortChange={(effort) => onEffortChange("lead", effort)} />
              <ExecutorPickerField label="执行者执行器" value={executors.worker.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="codex" override={executors.worker} onChange={(value, override) => onExecutorChange("worker", value, override)} onEffortChange={(effort) => onEffortChange("worker", effort)} />
              <ExecutorPickerField label="审查者执行器" value={executors.reviewer.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType={executorTypes.worker} override={executors.reviewer} onChange={(value, override) => onExecutorChange("reviewer", value, override)} onEffortChange={(effort) => onEffortChange("reviewer", effort)} />
            </>
          )}
          {mode === "duet" && (
            <>
              <ExecutorPickerField label="讨论者 A" value={executors.voiceA.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="claude" override={executors.voiceA} onChange={(value, override) => onExecutorChange("voiceA", value, override)} onEffortChange={(effort) => onEffortChange("voiceA", effort)} />
              <ExecutorPickerField label="讨论者 B" value={executors.voiceB.profile} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType="codex" override={executors.voiceB} onChange={(value, override) => onExecutorChange("voiceB", value, override)} onEffortChange={(effort) => onEffortChange("voiceB", effort)} />
            </>
          )}
        </div>
        {availabilityMessage && (
          <p className={`composer-agent-availability is-${availabilityTone ?? "warning"}`}>{availabilityMessage}</p>
        )}
      </section>
      )}

      {/* 单任务的执行器提示没了宿主 section，单独摆一行，别让「没有可用执行器」这类话消失。 */}
      {mode === "single" && availabilityMessage && (
        <p className={`composer-agent-availability is-${availabilityTone ?? "warning"}`}>{availabilityMessage}</p>
      )}

      {mode === "single" && (
        <section className="composer-config-section is-workflow-mode">
          <header className="composer-section-heading">
            <span><SlidersHorizontal size={14} /></span>
            <div><h2>工作方式</h2><p>自由模式按需派审、预览和合并；起手式按预设线路自动推进。</p></div>
          </header>
          <PillTabs
            label="工作方式"
            value={workflowMode}
            items={[{ value: "free", label: "自由工作流" }, { value: "preset", label: "起手式" }]}
            onChange={onWorkflowModeChange}
          />
          {workflowMode === "free" && (
            <ExecutorPickerField
              label="任务执行器"
              value={executors.single.profile}
              types={workerTypes}
              profiles={profiles}
              knownProfiles={profiles}
              fallbackType="claude"
              override={executors.single}
              onChange={(value, override) => onExecutorChange("single", value, override)}
              onEffortChange={(effort) => onEffortChange("single", effort)}
            />
          )}
        </section>
      )}

      {workflowMode === "preset" && workflowSlot}

      <section className="composer-config-section is-options">
        <header className="composer-section-heading">
          <span><GearSix size={14} /></span>
          <div><h2>任务选项</h2><p>运行位置、组织方式与标签。</p></div>
        </header>
        <div className="composer-option-grid">
          {mode === "team" && (
            <label className="composer-toggle-field">
              <span>自动审查</span>
              <Toggle checked={review} onChange={onReviewChange} label={review ? "已开启" : "已关闭"} />
            </label>
          )}
          {mode === "duet" && (
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
          {mode !== "duet" && isRepo && (
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
          {mode !== "duet" && (
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
          <div className="composer-label-field">
            <span>标签</span>
            <TaskLabelsEditor labels={labels} onChange={onLabelsChange} />
          </div>
        </div>
      </section>
    </div>
  );
}
