import type { Group, Session, Task, TaskListItem } from "@ash/shared";
import { Browser, FolderOpen, GitPullRequest, Info, MagnifyingGlass, Robot, Chats } from "@phosphor-icons/react";
import { WorkflowIcon } from "../components/WorkflowIcon.tsx";
import type { InspectorDescriptor } from "../inspector/index.ts";
import { PreviewWorkspaceEntry } from "../preview-workspace/PreviewWorkspace.tsx";
import { NativeWorkInspector, type NativeWorkInspectorProps } from "./NativeWorkInspector.tsx";
import { FileTreeInspector } from "../files/FileTreeInspector.tsx";
import { ScmInspector } from "../scm/ScmInspector.tsx";
import type { ScmDiffTarget } from "../scm/scmModel.ts";
import type { Notify } from "../lib/notify.ts";
import { TaskInspector } from "./TaskInspector.tsx";
import { TaskReviewInspector } from "./TaskReviewInspector.tsx";
import { WorkflowInspector } from "../workflow/WorkflowInspector.tsx";
import { FreeWorkflowInspector } from "../free-workflow/FreeWorkflowInspector.tsx";
import { SideChatPane } from "../side-chat/SideChatPane.tsx";

export interface TaskInspectorContext {
  nativeWork: NativeWorkInspectorProps;
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
  onOpenFile: (path: string) => void;
  /** 文件树该高亮哪一行：摊的是全文还是 diff，对它来说是同一个文件。 */
  activeFilePath: string | null;
  openScmDiff: ScmDiffTarget | null;
  onOpenScmDiff: (target: ScmDiffTarget) => void;

  notify: Notify;
}

// 图标条的顺序就是这个数组的顺序（`orderedValidTabs` 按它归位，localStorage 里存的次序
// 不作数）。排法是「看任务本身 → 看它改了什么 → 跟它一起干活」：
// 信息 · 文件 · 改动 · 子智能体 · 侧聊 · 工作流 · 审查 · 预览指正。
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
        onOpenDiff={context.onOpenScmDiff}
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
];

