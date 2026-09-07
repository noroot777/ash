import type { ReactNode } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  TaskMode,
  TaskWorkflowMode,
  TeamPresetConfig,
} from "@ash/shared";
import { ComposerExecution } from "./ComposerStudio.tsx";
import { parseExecutorValue } from "../lib/agentAvailability.ts";
import { Dropdown } from "../components/Dropdown.tsx";
import { PillTabs, Toggle } from "../components/ui.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import type { ComposerExecutorConfigs, ComposerExecutorRole } from "./executorOverrides.ts";
import { ExecutorPickerField } from "./ExecutorPickerField.tsx";
import { PresetBar } from "./PresetBar.tsx";
import type { ComposerRunSummary } from "./composerRunSummary.ts";

export function ComposerFields({
  mode,
  singleRunSummary,
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
  singleRunSummary: ComposerRunSummary;
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
  workflowSlot?: ReactNode;
  workflowMode: TaskWorkflowMode;
  onWorkflowModeChange: (mode: TaskWorkflowMode) => void;
}) {
  const nameFor = (role: ComposerExecutorRole) => {
    const selection = parseExecutorValue(executors[role].profile, profiles, { agentType: executorTypes[role], executorId: null });
    return profiles.find((profile) => profile.id === selection.executorId)?.name || selection.agentType;
  };
  const picker = (role: ComposerExecutorRole, label: string) => <ExecutorPickerField
    label={label} value={executors[role].profile} types={role === "lead" ? leadTypes : workerTypes}
    profiles={role === "lead" ? leadProfiles : profiles} knownProfiles={profiles}
    fallbackType={executorTypes[role]} override={executors[role]}
    onChange={(value, override) => onExecutorChange(role, value, override)}
    onEffortChange={(effort) => onEffortChange(role, effort)} />;
  const single = mode === "single";
  const duet = mode === "duet";
  const preset = single && workflowMode === "preset";
  const workflowEditor = <>
    <PillTabs label="工作方式" value={workflowMode}
      items={[{ value: "free", label: "自由工作流" }, { value: "preset", label: "起手式" }]}
      onChange={onWorkflowModeChange} />
    {preset ? workflowSlot : <p className="studio-help">按需派审和预览，完成后统一验收；不会自动合并。</p>}
  </>;
  return (
    <div className="composer-config studio-config">
      {availabilityMessage && <p role="status" className={"composer-agent-availability is-" + (availabilityTone ?? "warning")}>{availabilityMessage}</p>}
      <ComposerExecution key={mode} sections={[
        {
          id: "people", label: "谁来做",
          value: single ? singleRunSummary.executor : duet ? nameFor("voiceA") + " × " + nameFor("voiceB") : nameFor("lead") + " 调度",
          detailClassName: single ? "studio-run-summary" : undefined,
          detail: single ? `${singleRunSummary.provider} · ${singleRunSummary.model} · ${singleRunSummary.effort}`
            : duet ? "两种视角，共同结论" : nameFor("worker") + " 执行 · " + (review ? nameFor("reviewer") + " 审查" : "不自动审查"),
          content: <>
            {mode === "team" && <PresetBar currentConfig={currentTeamConfig} profiles={profiles} onApply={onApplyTeamPreset} notify={notify} />}
            <div className="studio-executors">
              {single && (preset ? <><p className="studio-help">执行器由起手式中的「让 AI 干活」站点决定。</p>{workflowSlot}</> : picker("single", "任务执行器"))}
              {mode === "team" && <>{picker("lead", "调度者执行器")}{picker("worker", "执行者执行器")}{picker("reviewer", "审查者执行器")}</>}
              {duet && <>{picker("voiceA", "讨论者 A")}{picker("voiceB", "讨论者 B")}</>}
            </div>
          </>,
        },
        {
          id: "space", label: "在哪里做", disabled: duet || !isRepo,
          value: duet ? "讨论会话" : isRepo && useWorktree ? "独立 worktree" : "项目目录",
          detail: duet ? "不创建工作目录" : isRepo && useWorktree ? "基于 " + (base || "当前 HEAD") : "直接使用项目目录",
          content: <div className="composer-option-grid">
            <div className="composer-toggle-field"><span>worktree</span><Toggle checked={useWorktree} onChange={onUseWorktreeChange} label={useWorktree ? "独立 worktree" : "直接使用项目目录"} /></div>
            <div className="composer-field"><span>base 分支</span><Dropdown label="base 分支" value={base}
              options={[{ value: "", label: "当前 HEAD" }, ...branches.map((branch) => ({ value: branch, label: branch, mono: true }))]}
              disabled={!useWorktree} filterable={branches.length > 6} filterPlaceholder="筛选分支…" placeholder="当前 HEAD" onChange={onBaseChange} /></div>
          </div>,
        },
        {
          id: "flow", label: "如何交付",
          value: single ? preset ? "起手式" : "自由工作流" : duet ? "共同结论" : review ? "自动审查" : "按需审查",
          detail: single ? "完成后，由你验收" : duet ? (rounds ? "最多 " + rounds + " 轮" : "不限轮数") + " · " + (gate ? "需要确认共识" : "自动结束") : review ? "执行者完成后派审" : "完成后手动派审",
          content: single ? workflowEditor : duet ? <div className="composer-option-grid">
            <div className="composer-field"><span>最多轮数</span><Dropdown label="最多轮数" value={rounds}
              options={[{ value: "", label: "不限" }, ...[1, 2, 3, 5, 8].map((value) => ({ value: String(value), label: value + " 轮" }))]}
              filterable={false} placeholder="不限" onChange={onRoundsChange} /></div>
            <div className="composer-toggle-field"><span>共识闸门</span><Toggle checked={gate} onChange={onGateChange} label={gate ? "需要确认" : "自动结束"} /></div>
          </div> : <div className="composer-toggle-field"><span>自动审查</span><Toggle checked={review} onChange={onReviewChange} label={review ? "已开启" : "已关闭"} /></div>,
        },
      ]} />
      <details className="studio-organization">
        <summary><span>组织与标签</span><small>{duet ? "" : (groups.find((group) => group.id === groupId)?.name || "无分组") + " · "}{labels.length ? labels.join("、") : "无标签"}</small></summary>
        <div className="composer-option-grid">
          {!duet && <div className="composer-field"><span>分组</span><Dropdown label="分组" value={groupId}
            options={[{ value: "", label: "无分组" }, ...groups.filter((group) => !group.ownerTaskId).map((group) => ({ value: group.id, label: group.name, detail: group.mode === "parallel" ? "并行" : "串行" })), { value: "__new", label: "＋ 新建分组…" }]}
            filterable={groups.length > 6} filterPlaceholder="筛选分组…" placeholder="无分组"
            onChange={(value) => { if (value === "__new") onCreateGroup(); else onGroupChange(value); }} /></div>}
          <div className="composer-label-field"><span>标签</span><TaskLabelsEditor labels={labels} onChange={onLabelsChange} /></div>
        </div>
      </details>
    </div>
  );
}
