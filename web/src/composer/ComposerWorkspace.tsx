import type { RemoteBranch } from "@navi/shared/task-branch";
import { FolderSimple, GitBranch } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { Toggle } from "../components/ui.tsx";

const FOLLOW_PREREQUISITES = "跟着前置走（起跑时定）";

/**
 * 输入卡底排打头的一组：在哪干活、从哪条分支开工。每建一条任务都要看一眼，所以直接摆在
 * 卡片里，不再收进点开才看得见的浮层。
 *
 * 这颗开关每次新建任务都要面对一遍，所以「把这次的选择变成本项目默认」就放在改它的地方 ——
 * 手机端(mobile/src/app/new.tsx)早就是这样；只在这次偏离了本项目默认时才出现。
 */
export function ComposerWorkspace({
  locked,
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
}: {
  locked: boolean;
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
}) {
  const tip = useHoverTip({ placement: "above" });
  if (!isRepo) {
    return <div className="composer-workspace is-static">
      <FolderSimple size={14} aria-hidden="true" /><span>项目目录</span>
    </div>;
  }
  const following = !!followPrerequisites && useWorktree;
  // 有远端分支时两组分开摆；从远端分支开工，成果合进本地同名分支（本地没有就建一条跟踪它的）。
  // 远端分支发完整引用：短名 `origin/foo` 会被同名 tag 抢先解析（RemoteBranch.fullRef）。
  const grouped = remote.branches.length > 0;
  const baseOptions = [
    { value: "", label: following ? FOLLOW_PREREQUISITES : automaticBaseLabel },
    ...branches.map((branch) => ({ value: branch, label: branch, mono: true, group: grouped ? "本地" : undefined })),
    ...remote.branches.map((branch) => ({ value: branch.fullRef, label: branch.ref, mono: true, group: "远端" })),
  ];
  const shownBase = following ? "" : base;
  // 「跟随」那一项是自己的文案：键上只写名字，括号里那半句说明留在展开的菜单里（底排寸土寸金）。
  // 分支名一律原样写 —— `release（稳定）` 是合法分支名，截掉括号会让两条分支显示成同一个名字。
  const baseLabel = shownBase
    ? baseOptions.find((option) => option.value === shownBase)?.label ?? shownBase
    : (following ? FOLLOW_PREREQUISITES : automaticBaseLabel).replace(/（[^）]*）$/, "");
  const remoteBase = following || branches.includes(base) ? null : remote.branches.find((branch) => branch.fullRef === base) ?? null;
  const mergeInto = following ? followPrerequisites.mergeTarget ?? automaticBaseLabel
    : remoteBase ? branches.includes(remoteBase.branch) ? remoteBase.branch : `${remoteBase.branch}（新建，跟踪 ${remoteBase.ref}）`
    : null;
  const workspaceLabel = (on: boolean) => (on ? "独立 worktree" : "项目目录");
  return <div className="composer-workspace">
    <Toggle checked={useWorktree} onChange={onUseWorktreeChange} disabled={locked} label="独立 worktree" />
    {useWorktree && <Dropdown label="base 分支" size="compact" className="composer-workspace-base" value={shownBase}
      options={baseOptions} mono={!!shownBase}
      display={<><GitBranch size={13} aria-hidden="true" />{baseLabel}</>}
      disabled={locked || switchingBranch || following} filterable={baseOptions.length > 7} filterPlaceholder="筛选分支…"
      placeholder={automaticBaseLabel} onChange={onBaseChange}
      footerAction={remote.refresh ? { label: remote.fetching ? "正在刷新远端分支…" : "刷新远端分支", onClick: remote.refresh, disabled: remote.fetching } : undefined} />}
    {useWorktree && mergeInto && <span className="composer-workspace-merge">合入 <code>{mergeInto}</code></span>}
    {switchingBranch && <span className="composer-workspace-note" role="status">正在切换项目分支…</span>}
    {!locked && useWorktree !== worktreeDefault && <>
      <button type="button" className="composer-workspace-save" disabled={savingWorktreeDefault}
        onClick={() => { tip.hide(); onSaveWorktreeDefault(); }} {...tip.anchorProps}>
        {savingWorktreeDefault ? "保存中…" : "设为默认"}
      </button>
      <HoverTip at={tip.at}>本项目默认是「{workspaceLabel(worktreeDefault)}」，这次只对本任务生效；点它把这次的选择设为本项目默认</HoverTip>
    </>}
  </div>;
}
