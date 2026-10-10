import type { Group, Session, Task, TaskListItem } from "@ash/shared";
import { Browser, FolderOpen, GitPullRequest, Images, Info, MagnifyingGlass, Pulse, Robot, Chats } from "@phosphor-icons/react";
import { WorkflowIcon } from "../components/WorkflowIcon.tsx";
import type { InspectorDescriptor } from "../inspector/index.ts";
import { PreviewWorkspaceEntry } from "../preview-workspace/PreviewWorkspace.tsx";
import { NativeWorkInspector, type NativeWorkInspectorProps } from "./NativeWorkInspector.tsx";
import { FileTreeInspector } from "../files/FileTreeInspector.tsx";
import { ArtifactsInspector } from "../files/ArtifactsInspector.tsx";
import { ScmInspector } from "../scm/ScmInspector.tsx";
import type { ScmDiffTarget } from "../scm/scmModel.ts";
import type { Notify } from "../lib/notify.ts";
import { TaskInspector } from "./TaskInspector.tsx";
import { TaskReviewInspector } from "./TaskReviewInspector.tsx";
import { WorkflowInspector } from "../workflow/WorkflowInspector.tsx";
import { FreeWorkflowInspector } from "../free-workflow/FreeWorkflowInspector.tsx";
import { SideChatPane } from "../side-chat/SideChatPane.tsx";
import { monitorBlockedReason } from "@ash/shared/monitor";
import { MonitorInspector } from "../monitors/MonitorInspector.tsx";
import type { TaskMonitorsState } from "../monitors/useTaskMonitors.ts";

export interface TaskInspectorContext {
  nativeWork: NativeWorkInspectorProps;
  /** 哨兵那一格的数据源；由 `useMonitorInspector` 提上来，面板开不开都在拉。 */
  monitors: TaskMonitorsState;
  task: Task;
  groups: Group[];
  sessions: Session[];
  allTasks: TaskListItem[];
  followUps: { text: string; attachments: string[]; at?: string }[];
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  onOpenPreview: () => void;
  onTaskUpdated: (task: Task) => void;
  onPatch: (patch: Partial<Task>) => Promise<void>;
  onQueueChanged: (updatedTask?: Task) => void;
  /** 入队响应波及的全体成员快照(含前驱)整批上交,由上层按 updatedAt 合并进任务列表。 */
  onTasksSynced: (tasks: Task[]) => void;
  /** 第二个参数是「这一串」：同组生成物、同一层文件，中间栏据此能翻上一张/下一张。 */
  onOpenFile: (path: string, reel?: readonly string[]) => void;
  /** 在中间栏摊开文件夹详情（里面有多少东西、能不能删）。 */
  onOpenFolder: (path: string) => void;
  /** 文件树该高亮哪一行：摊的是全文、diff 还是文件夹，对它来说是同一个路径。 */
  activeFilePath: string | null;
  openScmDiff: ScmDiffTarget | null;
  onOpenScmDiff: (target: ScmDiffTarget) => void;

  notify: Notify;
}

// 图标条的顺序就是这个数组的顺序（`orderedValidTabs` 按它归位，localStorage 里存的次序
// 不作数）。排法是「看任务本身 → 看它改了什么 → 跟它一起干活」：
// 信息 · 文件 · 生成物 · 改动 · 子智能体 · 侧聊 · 工作流 · 审查 · 预览指正 · 哨兵。
// 每一格都带快捷键（`I` 加面板名首字母），键位表在 inspector/shortcuts.ts。
export const TASK_INSPECTORS: readonly InspectorDescriptor<TaskInspectorContext>[] = [
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    defaultOpen: true,
    shortcut: "i",
    render: (context) => <TaskInspector {...context} />,
  },
  {
    id: "files",
    title: "文件",
    icon: <FolderOpen size={14} />,
    defaultOpen: true,
    shortcut: "f",
    render: (context) => (
      <FileTreeInspector
        taskId={context.task.id}
        activePath={context.activeFilePath}
        onOpenFile={context.onOpenFile}
        onOpenFolder={context.onOpenFolder}
        onOpenDiff={context.onOpenScmDiff}
      />
    ),
  },
  {
    // 跟「文件」分开的理由：文件树答的是「目录里现在有什么」，这一格答的是「它做出了
    // 什么可以直接看的东西」。一张生成的图在树里只是几十行里的一行，在 diff 里是一句
    // `Binary files differ` —— 两边都等于没有。
    id: "artifacts",
    title: "生成物",
    icon: <Images size={14} />,
    defaultOpen: true,
    shortcut: "a",
    render: (context) => (
      <ArtifactsInspector
        taskId={context.task.id}
        activePath={context.activeFilePath}
        onOpenFile={context.onOpenFile}
        notify={context.notify}
      />
    ),
  },
  {
    id: "scm",
    title: "改动",
    icon: <GitPullRequest size={14} />,
    defaultOpen: true,
    shortcut: "g",
    render: (context) => (
      <ScmInspector
        taskId={context.task.id}
        activeDiff={context.openScmDiff}
        onOpenDiff={context.onOpenScmDiff}
        onOpenReview={context.onOpenReview}
        notify={context.notify}
      />
    ),
  },
  {
    // 这一格由 useSubagents 按「这个任务到底有没有派出子智能体」决定在不在：没有就整格不给，
    // 免得图标条上常年挂着一个点进去必然是空的面板。
    id: "subagents",
    title: "子智能体",
    icon: <Robot size={14} />,
    defaultOpen: true,
    shortcut: "s",
    render: (context) => <NativeWorkInspector {...context.nativeWork} />,
  },
  {
    id: "side-chat",
    title: "侧聊",
    icon: <Chats size={14} />,
    defaultOpen: true,
    shortcut: "c",
    render: (context) => <SideChatPane key={context.task.id} task={context.task} />,
  },
  {
    id: "workflow",
    title: "工作流",
    icon: <WorkflowIcon size={14} />,
    defaultOpen: true,
    shortcut: "w",
    render: (context) => context.task.workflowMode === "free"
      ? <FreeWorkflowInspector task={context.task} />
      : <WorkflowInspector task={context.task} onTaskUpdated={context.onTaskUpdated} notify={context.notify} />,
  },
  {
    id: "review",
    title: "审查",
    icon: <MagnifyingGlass size={14} />,
    defaultOpen: true,
    shortcut: "r",
    render: (context) => context.task.workflowMode === "free"
      ? <FreeWorkflowInspector task={context.task} reviewOnly onOpenReview={context.onOpenReview} onOpenTask={context.onOpenTask} notify={context.notify} />
      : <TaskReviewInspector {...context} />,
  },
  {
    id: "preview",
    title: "预览指正",
    icon: <Browser size={14} />,
    defaultOpen: true,
    shortcut: "p",
    render: (context) => <PreviewWorkspaceEntry onOpen={context.onOpenPreview} />,
  },
  {
    // 跟其它几格一样默认开着：哨兵不只是「agent 挂了什么」的回看面板，人也会想自己挂一个，
    // 而这一格就是手动起哨兵唯一的入口——藏到「+」菜单里等于让人先知道它在那儿才找得到。
    // 没有哨兵时空态自己会解释这是什么（见 MonitorInspector），不是一片空白。
    id: "monitors",
    title: "哨兵",
    icon: <Pulse size={14} />,
    defaultOpen: true,
    shortcut: "m",
    render: (context) => (
      <MonitorInspector monitors={context.monitors} blockedReason={monitorBlockedReason(context.task)} />
    ),
  },
];

