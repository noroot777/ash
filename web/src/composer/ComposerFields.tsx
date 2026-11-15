import type { ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, Group } from "@ash/shared";
import { DotsThree, FolderSimple, GitBranch, Tag } from "@phosphor-icons/react";
import { ComposerStarters } from "./ComposerStudio.tsx";
import { ComposerPopover } from "./ComposerPopover.tsx";
import { Dropdown } from "../components/Dropdown.tsx";
import { Toggle } from "../components/ui.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import type { ComposerExecutorConfig } from "./executorOverrides.ts";
import { ExecutorPickerField } from "./ExecutorPickerField.tsx";

/** 摆进新建卡片的几块：输入区下面那排入口、右下角的「谁来做」。 */
export type ComposerFieldParts = {
  options: { where: ReactNode; org: ReactNode; more: ReactNode };
  executorTools: ReactNode;
};

export function ComposerFields({
  profiles,
  types,
  executor,
  executorType,
  call,
  availabilityMessage,
  availabilityTone,
  onExecutorChange,
  onEffortChange,
  isRepo,
  useWorktree,
  onUseWorktreeChange,
  worktreeDefault,
  savingWorktreeDefault,
  onSaveWorktreeDefault,
  branches,
  base,
  automaticBaseLabel,
  switchingBranch,
  onBaseChange,
  groups,
  groupId,
  onGroupChange,
  labels,
  onLabelsChange,
  onCreateGroup,
  onPickStarter,
  children,
}: {
  profiles: AgentExecutorProfile[];
  types: AgentType[];
  executor: ComposerExecutorConfig;
  executorType: AgentType;
  /** 叫着人时排在任务自己那颗胶囊后面的那一颗（ComposerCall.tsx）；任务自己的那颗随之缩成一段。 */
  call: ReactNode;
  availabilityMessage: string | null;
  availabilityTone: "loading" | "warning" | "empty" | null;
  onExecutorChange: (value: string, override: { model: string; effort: string }) => void;
  onEffortChange: (effort: string) => void;
  isRepo: boolean;
  useWorktree: boolean;
  onUseWorktreeChange: (value: boolean) => void;
  /** 本项目的默认工作目录（projects.useWorktreeDefault），用来判断这次选择是不是在临时偏离它。 */
  worktreeDefault: boolean;
  savingWorktreeDefault: boolean;
  onSaveWorktreeDefault: () => void;
  branches: string[];
  base: string;
  automaticBaseLabel: string;
  switchingBranch: boolean;
  onBaseChange: (value: string) => void;
  groups: Group[];
  groupId: string;
  onGroupChange: (value: string) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  onCreateGroup: () => void;
  onPickStarter: (body: string) => void;
  children: (parts: ComposerFieldParts) => ReactNode;
}) {
  const workspaceLabel = (on: boolean) => (on ? "独立 worktree" : "项目目录");
  // 这颗开关每次新建任务都要面对一遍，所以把「本项目默认是什么」和「把这次的选择变成本项目
  // 默认」就放在改它的地方 —— 手机端(mobile/src/app/new.tsx)早就是这样，桌面端此前只能翻到
  // 设置页去改，用户只好每建一个任务手动拨一次。
  const workspaceEditor = <>
    <div className="composer-option-grid">
      <label className="composer-toggle-field"><span>worktree</span><Toggle checked={useWorktree} onChange={onUseWorktreeChange} label={useWorktree ? "独立 worktree" : "直接使用项目目录"} /></label>
      <div className="composer-field"><span>base 分支</span><Dropdown label="base 分支" value={base}
        options={[{ value: "", label: automaticBaseLabel }, ...branches.map((branch) => ({ value: branch, label: branch, mono: true }))]}
        disabled={!useWorktree || switchingBranch} filterable={branches.length > 6} filterPlaceholder="筛选分支…" placeholder={automaticBaseLabel} onChange={onBaseChange} /></div>
    </div>
    {switchingBranch && <p className="studio-help" role="status">正在切换项目分支，完成后可创建任务。</p>}
    <p className="studio-help composer-workspace-default">
      {useWorktree === worktreeDefault
        ? <>本项目默认就是「{workspaceLabel(worktreeDefault)}」，到「设置 → 项目设置 → 工作目录」可随时改。</>
        : <>本项目默认是「{workspaceLabel(worktreeDefault)}」，这次只对本任务生效。
          <button type="button" className="composer-workspace-default-save"
            disabled={savingWorktreeDefault} onClick={onSaveWorktreeDefault}>
            {savingWorktreeDefault ? "保存中…" : "设为本项目默认"}
          </button></>}
    </p>
  </>;
  const directory = isRepo && useWorktree ? "独立 worktree" : "项目目录";
  const groupName = groups.find((group) => group.id === groupId)?.name;
  const organization = [groupName, labels.length > 0 && `${labels.length} 个标签`].filter(Boolean).join(" · ");
  // 「谁来做」：底排那颗三段胶囊。叫着人时它缩成一段（还看得见、改得了这条任务由谁跑），后面跟着被叫的人。
  const executorTools = <div className="studio-inline-executor">
    <ExecutorPickerField label="任务执行器" value={executor.profile} types={types} profiles={profiles} knownProfiles={profiles}
      fallbackType={executorType} override={executor} agentOnly={!!call} onChange={onExecutorChange} onEffortChange={onEffortChange} />
    {call}
  </div>;
  // 输入区下面那排入口：图标 + 当前值，点开才是开关和下拉。名字和次序照旧。
  const where = <ComposerPopover tone="opt" label="工作目录" value={`${directory}${isRepo && useWorktree ? ` · ${base || automaticBaseLabel}` : ""}`}
    trigger={<>{isRepo && useWorktree ? <GitBranch size={14} /> : <FolderSimple size={14} />}<span>{directory}</span></>}>
    {isRepo ? workspaceEditor : <p className="studio-help">当前项目不是 Git 仓库，直接使用项目目录。</p>}
  </ComposerPopover>;
  const org = <ComposerPopover tone="opt" label="组织与标签" value={organization || "无分组、无标签"} className={`is-org${organization ? " is-configured" : ""}`}
    trigger={<><Tag size={14} /><span>{organization || "分组与标签"}</span></>}>
    <div className="composer-option-grid">
      <div className="composer-field"><span>分组</span><Dropdown label="分组" value={groupId}
        options={[{ value: "", label: "无分组" }, ...groups.filter((group) => !group.ownerTaskId).map((group) => ({ value: group.id, label: group.name, detail: group.mode === "parallel" ? "并行" : "串行" })), { value: "__new", label: "＋ 新建分组…" }]}
        filterable={groups.length > 6} filterPlaceholder="筛选分组…" placeholder="无分组"
        onChange={(value) => { if (value === "__new") onCreateGroup(); else onGroupChange(value); }} /></div>
      <div className="composer-label-field"><span>标签</span><TaskLabelsEditor labels={labels} onChange={onLabelsChange} /></div>
    </div>
  </ComposerPopover>;
  // 「更多」里眼下只有写作参考（原来的「任务示例」）：浮层标题直接叫它的名字。
  const more = <ComposerPopover tone="opt" iconOnly label="更多选项" heading="写作参考" trigger={<DotsThree size={16} weight="bold" />}>
    {(close) => <ComposerStarters onPick={(text) => { close(); onPickStarter(text); }} />}
  </ComposerPopover>;
  return (
    <>
      {children({ options: { where, org, more }, executorTools })}
      {availabilityMessage && <p role="status" className={"composer-agent-availability is-" + (availabilityTone ?? "warning")}>{availabilityMessage}</p>}
    </>
  );
}
