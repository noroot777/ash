import type { ReactNode } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  TaskMode,
  TaskWorkflowMode,
  TeamPresetConfig,
} from "@ash/shared";
import { ChatsCircle, Check, FlowArrow, FolderSimple, GitBranch, NotePencil, Tag, UsersThree } from "@phosphor-icons/react";
import { ComposerStarters } from "./ComposerStudio.tsx";
import { ComposerPopover } from "./ComposerPopover.tsx";
import { MODES } from "./composerParts.tsx";
import { parseExecutorValue } from "../lib/agentAvailability.ts";
import { Dropdown } from "../components/Dropdown.tsx";
import { PillTabs, Toggle } from "../components/ui.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import type { ComposerExecutorConfigs, ComposerExecutorRole } from "./executorOverrides.ts";
import { ExecutorPickerField } from "./ExecutorPickerField.tsx";
import { PresetBar } from "./PresetBar.tsx";
import { composerRunSummary, type ComposerRunSummary } from "./composerRunSummary.ts";
import { useProviders } from "../lib/modelCatalog.ts";

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
  onModeChange,
  onPickStarter,
  children,
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
  onModeChange: (mode: TaskMode) => void;
  onPickStarter: (body: string, mode: TaskMode) => void;
  children: (executorTools: ReactNode) => ReactNode;
}) {
  const nameFor = (role: ComposerExecutorRole) => {
    const selection = parseExecutorValue(executors[role].profile, profiles, { agentType: executorTypes[role], executorId: null });
    return profiles.find((profile) => profile.id === selection.executorId)?.name || selection.agentType;
  };
  const providers = useProviders();
  const summaryFor = (role: ComposerExecutorRole) => {
    const selection = parseExecutorValue(executors[role].profile, profiles, { agentType: executorTypes[role], executorId: null });
    return composerRunSummary({
      ...selection,
      model: executors[role].model || null,
      reasoningEffort: executors[role].effort || null,
    }, profiles, providers);
  };
  const leadRun = summaryFor("lead");
  const workerRun = summaryFor("worker");
  const reviewerRun = summaryFor("reviewer");
  const voiceARun = summaryFor("voiceA");
  const voiceBRun = summaryFor("voiceB");
  const runLine = (role: string, run: ComposerRunSummary) => <p className="studio-effective-run"><b>{role}</b> · {run.provider} · {run.model} · {run.effort}</p>;
  const picker = (role: ComposerExecutorRole, label: string) => <ExecutorPickerField
    label={label} value={executors[role].profile} types={role === "lead" ? leadTypes : workerTypes}
    profiles={role === "lead" ? leadProfiles : profiles} knownProfiles={profiles}
    fallbackType={executorTypes[role]} override={executors[role]}
    onChange={(value, override) => onExecutorChange(role, value, override)}
    onEffortChange={(effort) => onEffortChange(role, effort)} />;
  const single = mode === "single";
  const duet = mode === "duet";
  const preset = single && workflowMode === "preset";
  const workspaceEditor = <div className="composer-option-grid">
    <label className="composer-toggle-field"><span>worktree</span><Toggle checked={useWorktree} onChange={onUseWorktreeChange} label={useWorktree ? "独立 worktree" : "直接使用项目目录"} /></label>
    <div className="composer-field"><span>base 分支</span><Dropdown label="base 分支" value={base}
      options={[{ value: "", label: "当前 HEAD" }, ...branches.map((branch) => ({ value: branch, label: branch, mono: true }))]}
      disabled={!useWorktree} filterable={branches.length > 6} filterPlaceholder="筛选分支…" placeholder="当前 HEAD" onChange={onBaseChange} /></div>
  </div>;
  const directory = isRepo && useWorktree ? "独立 worktree" : "项目目录";
  const groupName = groups.find((group) => group.id === groupId)?.name;
  const organization = [!duet && groupName, labels.length > 0 && `${labels.length} 个标签`].filter(Boolean).join(" · ");
  const executorTools = single
    ? preset
      ? <span className="studio-preset-run" aria-label={`起手式执行器：${singleRunSummary.provider} · ${singleRunSummary.model} · ${singleRunSummary.effort}`}>
        <FlowArrow size={14} /><span>{singleRunSummary.model} · {singleRunSummary.effort}</span>
      </span>
      : <div className="studio-inline-executor">{picker("single", "任务执行器")}</div>
    : <ComposerPopover key={mode} label="谁来做" value={duet ? `${nameFor("voiceA")} × ${nameFor("voiceB")}` : `${nameFor("lead")} 调度`}
      trigger={<>{duet ? <ChatsCircle size={15} /> : <UsersThree size={15} />}<span>{duet ? "讨论者" : "团队配置"}</span></>} wide>
      {mode === "team" && <PresetBar currentConfig={currentTeamConfig} profiles={profiles} onApply={onApplyTeamPreset} notify={notify} />}
      <div className="studio-executors">
        {mode === "team" && <>
          <div>{picker("lead", "调度者执行器")}{runLine("调度", leadRun)}</div>
          <div>{picker("worker", "执行者执行器")}{runLine("执行", workerRun)}</div>
          <div>{picker("reviewer", "审查者执行器")}{runLine("审查", reviewerRun)}</div>
        </>}
        {duet && <>
          <div>{picker("voiceA", "讨论者 A")}{runLine("A", voiceARun)}</div>
          <div>{picker("voiceB", "讨论者 B")}{runLine("B", voiceBRun)}</div>
        </>}
      </div>
    </ComposerPopover>;
  return (
    <>
      <div className="studio-accessories" aria-label="任务辅助设置">
        <div className="studio-mode-tabs" role="tablist" aria-label="任务模式">
          {MODES.map((item) => { const Icon = item.icon; return <button type="button" role="tab" key={item.value}
            aria-selected={mode === item.value} onClick={() => onModeChange(item.value)}>
            <Icon size={14} /><span>{item.label}</span>
          </button>; })}
        </div>
        <span className="studio-tool-divider" aria-hidden="true" />
        {single ? <ComposerPopover label="工作方式" value={preset ? "起手式" : "自由工作流"} wide={preset}
          trigger={<><FlowArrow size={14} /><span>{preset ? "起手式" : "自由工作流"}</span></>}>
          <section className="studio-workflow">
            <PillTabs label="工作方式" value={workflowMode}
              items={[{ value: "free", label: "自由工作流" }, { value: "preset", label: "起手式" }]} onChange={onWorkflowModeChange} />
            {preset ? <>{runLine("让 AI 干活", singleRunSummary)}{workflowSlot}</>
              : <><p className="studio-help">由输入框下方的任务执行器完成目标，按需派审和预览，完成后统一验收。</p>{runLine("任务执行器", singleRunSummary)}</>}
          </section>
        </ComposerPopover> : <ComposerPopover label="如何交付"
          value={duet ? `${rounds ? `最多 ${rounds} 轮` : "不限轮数"} · ${gate ? "需要确认共识" : "自动结束"}` : review ? "自动审查" : "按需审查"}
          trigger={<><Check size={14} /><span>{duet ? "讨论规则" : review ? "自动审查" : "按需审查"}</span></>}>
          {duet ? <div className="composer-option-grid">
            <div className="composer-field"><span>最多轮数</span><Dropdown label="最多轮数" value={rounds}
              options={[{ value: "", label: "不限" }, ...[1, 2, 3, 5, 8].map((value) => ({ value: String(value), label: value + " 轮" }))]}
              filterable={false} placeholder="不限" onChange={onRoundsChange} /></div>
            <label className="composer-toggle-field"><span>共识闸门</span><Toggle checked={gate} onChange={onGateChange} label={gate ? "需要确认" : "自动结束"} /></label>
          </div> : <label className="composer-toggle-field"><span>自动审查</span><Toggle checked={review} onChange={onReviewChange} label={review ? "已开启" : "已关闭"} /></label>}
        </ComposerPopover>}
        {!duet && <ComposerPopover label="工作目录" value={`${directory}${isRepo && useWorktree ? ` · ${base || "当前 HEAD"}` : ""}`}
          trigger={<>{isRepo && useWorktree ? <GitBranch size={14} /> : <FolderSimple size={14} />}<span>{directory}</span></>}>
          {isRepo ? workspaceEditor : <p className="studio-help">当前项目不是 Git 仓库，直接使用项目目录。</p>}
        </ComposerPopover>}
        <ComposerPopover label="组织与标签" value={organization || "无分组、无标签"} className={organization ? "is-configured" : ""}
          trigger={<><Tag size={14} /><span>{organization || (duet ? "标签" : "分组与标签")}</span></>}>
        <div className="composer-option-grid">
          {!duet && <div className="composer-field"><span>分组</span><Dropdown label="分组" value={groupId}
            options={[{ value: "", label: "无分组" }, ...groups.filter((group) => !group.ownerTaskId).map((group) => ({ value: group.id, label: group.name, detail: group.mode === "parallel" ? "并行" : "串行" })), { value: "__new", label: "＋ 新建分组…" }]}
            filterable={groups.length > 6} filterPlaceholder="筛选分组…" placeholder="无分组"
            onChange={(value) => { if (value === "__new") onCreateGroup(); else onGroupChange(value); }} /></div>}
          <div className="composer-label-field"><span>标签</span><TaskLabelsEditor labels={labels} onChange={onLabelsChange} /></div>
        </div>
        </ComposerPopover>
        <div className="studio-template-tool"><ComposerPopover label="任务示例" trigger={<><NotePencil size={14} /><span>写作参考</span></>}>
          {(close) => <ComposerStarters onPick={(text, nextMode) => { close(); onPickStarter(text, nextMode); }} />}
        </ComposerPopover></div>
      </div>
      {children(executorTools)}
      {availabilityMessage && <p role="status" className={"composer-agent-availability is-" + (availabilityTone ?? "warning")}>{availabilityMessage}</p>}
    </>
  );
}
