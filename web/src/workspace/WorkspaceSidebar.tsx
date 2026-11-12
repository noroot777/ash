import { AssistantIcon } from "../assistant/AssistantIcon.tsx";
import { useState, type FocusEvent, type MouseEvent } from "react";
import type { HandoffTarget, ProjectView, TaskListItem } from "@ash/shared";
import type { TerminalSessionInfo } from "../lib/api.ts";
import type { OutboundBar } from "./OutboundStatusBar.tsx";
import {
  ListBullets,
  ListChecks,
  MagnifyingGlass,
  NotePencil,
  Plus,
  SidebarSimple,
  ChatCircleDots,
} from "@phosphor-icons/react";
import { CommandsLauncher } from "./CommandsLauncher.tsx";
import { ProjectAvatar } from "./ProjectAvatar.tsx";
import { ProjectGitContext } from "./ProjectGitContext.tsx";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { SidebarIconButton } from "./SidebarIconButton.tsx";
import { SpreadFilterControls } from "./SpreadFilterControls.tsx";
import { TaskTree } from "./TaskTree.tsx";
import { TASK_MODE_LABEL, type TaskScope } from "./taskScope.ts";
import { type SidebarSpread } from "./useSidebarSpread.ts";
import { workspaceModifierLabel } from "./useWorkspaceShortcuts.ts";
import { WorkspaceResizeHandle } from "./WorkspaceResizeHandle.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";


export function WorkspaceSidebar({
  projects,
  currentProject,
  scope,
  tasks,
  selectedTaskId,
  selectedRemoteTaskId,
  connected,
  collapsed,
  spread,
  width,
  onWidthChange,
  onProject,
  onTaskMode,
  onTask,
  onRemoteTask,
  onTaskStarred,
  onHandoffFinished,
  onQueueChanged,
  outbound,
  onOpenTerminal,
  commands,
  notify,
  onToggleCollapsed,
  onSearch,
  onNotes,
  onChat,
  chatOpen,
  onAssistant,
  assistantOpen,
  onCreate,
  onNewProject,
  onSettings,
}: {
  projects: ProjectView[];
  currentProject: ProjectView | null;
  /** 任务列表看哪些行：当前项目一家，还是「任务模式」——所有项目里在跑和待验收的那些。 */
  scope: TaskScope;
  tasks: TaskListItem[];
  selectedTaskId: string | null;
  selectedRemoteTaskId: string | null;
  connected: boolean;
  collapsed: boolean;
  spread: SidebarSpread;
  width: number;
  onWidthChange: (width: number) => void;
  onProject: (projectId: string) => void;
  onTaskMode: () => void;
  onTask: (task: TaskListItem) => void;
  onRemoteTask: (task: TaskListItem, target: HandoffTarget) => void;
  onTaskStarred: (taskId: string, starredAt: number | null) => void;
  onHandoffFinished: () => Promise<void> | void;
  onQueueChanged: () => void;
  outbound: OutboundBar;
  onOpenTerminal: (() => void) | null;
  /** 顶行那颗 ▶(常用命令)要的一整套接线;没权限用终端时由 CommandsLauncher 自己收掉。 */
  commands: {
    canUseTerminal: boolean;
    /** 递增序号,变一次 = 快捷键 G C 按了一下。 */
    openSignal: number;
    onOpenCommandLog: (session: TerminalSessionInfo) => void;
    onManageCommands: () => void;
  };
  notify: (message: string) => void;
  onToggleCollapsed: () => void;
  onSearch: () => void;
  onNotes: () => void;
  onChat?: () => void;
  chatOpen?: boolean;
  onAssistant?: () => void;
  assistantOpen?: boolean;
  onCreate: () => void;
  onNewProject: () => void;
  onSettings: () => void;
}) {
  const modifier = workspaceModifierLabel();
  const taskMode = scope.kind === "tasks";
  const connectionLabel = connected ? "实时已连接" : "实时连接中断";
  const hoverTip = useHoverTip({ placement: "above" });
  const focusTip = useHoverTip({ placement: "above" });
  const [hoveredKind, setHoveredKind] = useState<"assistant" | "connection">("connection");
  const [focusedKind, setFocusedKind] = useState<typeof hoveredKind>("connection");
  const footerTip = {
    at: hoverTip.at ?? focusTip.at,
    hide: () => { hoverTip.hide(); focusTip.hide(); },
  };
  const tipKind = hoverTip.at ? hoveredKind : focusedKind;
  const tipProps = (kind: typeof tipKind) => ({
    onMouseEnter: (event: MouseEvent<Element>) => { setHoveredKind(kind); hoverTip.anchorProps.onMouseEnter(event); },
    onMouseLeave: hoverTip.hide,
    onPointerDown: focusTip.hide,
    onFocus: (event: FocusEvent<Element>) => {
      if (!event.currentTarget.matches(":focus-visible")) { focusTip.hide(); return; }
      setFocusedKind(kind);
      focusTip.anchorProps.onFocus(event);
    },
    onBlur: focusTip.hide,
  });
  const tipContent = tipKind === "connection" ? connectionLabel : "ash 助手";
  if (collapsed) {
    return (
      <aside className="workspace-sidebar workspace-sidebar--collapsed" aria-label="已收起的侧边栏">
        {/* 收起后这颗方块是「列表在看谁」剩下的唯一说明。任务模式下摆项目头像会说反话 ——
            那时候列表根本不是这个项目的，所以换成和下拉里同一枚清单图标。 */}
        {taskMode
          ? <span className="workspace-project-avatar workspace-project-avatar--task-mode is-large" aria-label={TASK_MODE_LABEL}><ListChecks size={17} weight="bold" /></span>
          : currentProject && <ProjectAvatar project={currentProject} size="large" />}
        {/* 收起后常用命令也得有落点:不然侧栏一收,▶ 和快捷键 G C 就一起没了去处。 */}
        <CommandsLauncher
          currentProject={currentProject}
          canUseTerminal={commands.canUseTerminal}
          collapsed
          openSignal={commands.openSignal}
          onOpenCommandLog={commands.onOpenCommandLog}
          onManageCommands={commands.onManageCommands}
          notify={notify}
        />
        <span className={`workspace-connection-light${connected ? " is-connected" : ""}`} role="status" aria-label={connectionLabel} tabIndex={0} {...tipProps("connection")} />
        <button className="workspace-side-icon" type="button" onClick={onToggleCollapsed} aria-label="展开侧边栏">
          <SidebarSimple size={17} weight="bold" aria-hidden="true" />
        </button>
        {onAssistant && <button className="workspace-side-icon workspace-assistant-entry" type="button" aria-label="ash 助手" aria-pressed={!!assistantOpen} {...tipProps("assistant")} onClick={() => { footerTip.hide(); onAssistant(); }}><AssistantIcon size={18} filled={assistantOpen} /></button>}
        <HoverTip at={footerTip.at}>{tipContent}</HoverTip>
      </aside>
    );
  }

  return (
    <aside className={`workspace-sidebar${spread.laidOut ? " is-spread" : ""}${spread.open ? " is-spread-open" : ""}`} aria-label="项目和任务导航">
      {/* 一行只管一件事：顶行「在哪儿」（项目、常用命令），第二行「新建」，第三行「找」。
          分组管理不在这几行里：它在项目菜单的「设置」和 ⌘K 里。 */}
      <div className="workspace-sidebar-top">
        <div className="workspace-sidebar-selectors">
          <ProjectSwitcher
            projects={projects}
            current={currentProject}
            taskMode={taskMode}
            onProject={onProject}
            onTaskMode={onTaskMode}
            onCreate={onNewProject}
            onSettings={onSettings}
            notify={notify}
          />
          {currentProject && (
            <ProjectGitContext
              projectId={currentProject.id}
              health={currentProject.health}
              project={taskMode ? currentProject : null}
              canManage={currentProject.myRole === "admin"}
              onOpenTerminal={onOpenTerminal}
            />
          )}
          {/* 顶行最右:常用命令的启动入口。 */}
          <CommandsLauncher
            currentProject={currentProject}
            canUseTerminal={commands.canUseTerminal}
            openSignal={commands.openSignal}
            onOpenCommandLog={commands.onOpenCommandLog}
            onManageCommands={commands.onManageCommands}
            notify={notify}
          />
        </div>
        <div className="workspace-sidebar-make">
          <NewTaskButton onCreate={onCreate} />
          <SidebarIconButton label="随手记" onClick={onNotes}>
            <NotePencil size={15} aria-hidden="true" />
          </SidebarIconButton>
        </div>
        {/* 「找」：一颗星加五颗点的筛选靠左（铺开时原地换成带字带数的胶囊），右边搜索和
            任务列表。F 原来只是底部一句点不动的提示，现在是这一行最右的一颗键。 */}
        <div className="workspace-sidebar-find" role="toolbar" aria-label="筛选与搜索">
          <SpreadFilterControls spread={spread} tasks={tasks} scope={scope} />
          <SidebarIconButton label="搜索" keys={`${modifier} K`} haspopup="dialog" onClick={onSearch}>
            <MagnifyingGlass size={15} aria-hidden="true" />
          </SidebarIconButton>
          <SidebarIconButton className="workspace-spread-toggle" label={spread.open ? "收起任务列表" : "打开任务列表"} keys="F" pressed={spread.open} onClick={spread.toggle}>
            <ListBullets size={16} aria-hidden="true" />
          </SidebarIconButton>
        </div>
      </div>

      <TaskTree
        projects={projects}
        currentProjectId={currentProject?.id ?? null}
        scope={scope}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        selectedRemoteTaskId={selectedRemoteTaskId}
        spread={spread}
        onTask={onTask}
        onRemoteTask={onRemoteTask}
        onTaskStarred={onTaskStarred}
        onHandoffFinished={onHandoffFinished}
        onQueueChanged={onQueueChanged}
        outbound={outbound}
        notify={notify}
      />

      <div className={`workspace-sidebar-bottom${onAssistant ? " has-assistant" : ""}`}>
        <span className={`workspace-connection${connected ? " is-connected" : ""}`} role="status" aria-label={connectionLabel} tabIndex={0} {...tipProps("connection")}>
          <i aria-hidden="true" />
        </span>
        {spread.open && (
          <span className="workspace-spread-hint">
            <kbd>J</kbd><kbd>K</kbd> 选 · <kbd>Enter</kbd> 打开 · 指住右边两列看全文 · <kbd>F</kbd>/<kbd>Esc</kbd> 收起
          </span>
        )}
        {onChat && <button type="button" aria-label="聊天" aria-pressed={!!chatOpen} onClick={() => onChat()}><ChatCircleDots size={15} aria-hidden="true" /></button>}
        {onAssistant && <button className="workspace-assistant-entry" type="button" aria-label="ash 助手" aria-pressed={!!assistantOpen} {...tipProps("assistant")} onClick={() => { footerTip.hide(); onAssistant(); }}>
          <AssistantIcon size={15} filled={assistantOpen} />
          <span className="workspace-assistant-label">助手</span>
        </button>}
        <button type="button" onClick={onToggleCollapsed} aria-label="收起侧边栏">
          <SidebarSimple size={14} weight="bold" aria-hidden="true" />
          收起
        </button>
      </div>
      <HoverTip at={footerTip.at}>{tipContent}</HoverTip>
      <WorkspaceResizeHandle width={width} onChange={onWidthChange} />
    </aside>
  );
}

// 「新建任务」占满第二行：它是侧栏里最常按的一下，值得一整行，而不是工具行里六颗长得差不多的图标之一。
function NewTaskButton({ onCreate }: { onCreate: () => void }) {
  const tip = useHoverTip();
  return (
    <>
      <button className="workspace-new-task" type="button" {...tip.anchorProps} onClick={() => { tip.hide(); onCreate(); }}>
        <Plus size={14} aria-hidden="true" />
        <span>新建任务</span>
      </button>
      <HoverTip at={tip.at}>新建任务 <kbd>C</kbd></HoverTip>
    </>
  );
}
