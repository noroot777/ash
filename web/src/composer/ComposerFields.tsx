import type { ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, Group } from "@navi/shared";
import type { RemoteBranch } from "@navi/shared/task-branch";
import { DotsThree, Tag } from "@phosphor-icons/react";
import { ComposerStarters } from "./ComposerStudio.tsx";
import { ComposerPopover } from "./ComposerPopover.tsx";
import { Dropdown } from "../components/Dropdown.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import type { ComposerExecutorConfig } from "./executorOverrides.ts";
import { ExecutorPickerField } from "./ExecutorPickerField.tsx";
import { ComposerWorkspace } from "./ComposerWorkspace.tsx";

/** 摆进新建卡片的几块：输入区下面那排入口（工作目录打头）、右下角的「谁来做」。 */
export type ComposerFieldParts = {
  options: { org: ReactNode; more: ReactNode };
  /** 底排打头那一组：工作目录和 base 分支，常驻、不用点开。 */
  workspace: ReactNode;
  executorTools: ReactNode;
};

export function ComposerFields({
  profiles,
  types,
  executor,
  executorType,
  locked,
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
  remote,
  base,
  automaticBaseLabel,
  switchingBranch,
  onBaseChange,
  followPrerequisites,
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
  /** 任务已经建好、在等重发第一回合：它的执行器、工作目录、分组标签都定了，只看不改。 */
  locked: boolean;
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
  /** 远端分支（`origin/foo`）和「刷新远端分支」（没有远端时 refresh 为 null）。 */
  remote: { branches: RemoteBranch[]; refresh: (() => void) | null; fetching: boolean };
  base: string;
  automaticBaseLabel: string;
  switchingBranch: boolean;
  onBaseChange: (value: string) => void;
  /**
   * 启动方式是「创建并等前置」：起点在起跑那一刻按前置定，base 分支不可选；合入分支跟着前置走
   * （`mergeTarget`，null = 前置不限制、照常按项目分支定）。
   */
  followPrerequisites?: { mergeTarget: string | null } | null;
  groups: Group[];
  groupId: string;
  onGroupChange: (value: string) => void;
  labels: string[];
  onLabelsChange: (labels: string[]) => void;
  onCreateGroup: () => void;
  onPickStarter: (body: string) => void;
  children: (parts: ComposerFieldParts) => ReactNode;
}) {
  const workspace = <ComposerWorkspace locked={locked} isRepo={isRepo} useWorktree={useWorktree} onUseWorktreeChange={onUseWorktreeChange}
    worktreeDefault={worktreeDefault} savingWorktreeDefault={savingWorktreeDefault} onSaveWorktreeDefault={onSaveWorktreeDefault}
    branches={branches} remote={remote} base={base} automaticBaseLabel={automaticBaseLabel} switchingBranch={switchingBranch}
    onBaseChange={onBaseChange} followPrerequisites={followPrerequisites} />;
  const groupName = groups.find((group) => group.id === groupId)?.name;
  const organization = [groupName, labels.length > 0 && `${labels.length} 个标签`].filter(Boolean).join(" · ");
  // 「谁来做」：底排那颗三段胶囊。叫着人时它缩成一段（还看得见、改得了这条任务由谁跑），后面跟着被叫的人。
  const executorTools = <div className="studio-inline-executor">
    <ExecutorPickerField label="任务执行器" value={executor.profile} types={types} profiles={profiles} knownProfiles={profiles}
      fallbackType={executorType} override={executor} disabled={locked} compact={!!call} onChange={onExecutorChange} onEffortChange={onEffortChange} />
    {call}
  </div>;
  // 输入区下面那排入口：图标 + 当前值，点开才是下拉和输入。名字和次序照旧。
  const org = <ComposerPopover tone="opt" label="组织与标签" disabled={locked} value={organization || "无分组、无标签"} className={`is-org${organization ? " is-configured" : ""}`}
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
      {children({ options: { org, more }, workspace, executorTools })}
      {availabilityMessage && <p role="status" className={"composer-agent-availability is-" + (availabilityTone ?? "warning")}>{availabilityMessage}</p>}
    </>
  );
}
