import type { Group, Session, Task, TaskListItem } from "@ash/shared";
import { Browser, FolderOpen, GitBranch, GitPullRequest, Info, MagnifyingGlass, Robot, Chats } from "@phosphor-icons/react";
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
  openFilePath: string | null;
  onOpenFile: (path: string) => void;
  openScmDiff: ScmDiffTarget | null;
  onOpenScmDiff: (target: ScmDiffTarget) => void;
  notify: Notify;
}

export const TASK_INSPECTORS: readonly InspectorDescriptor<TaskInspectorContext>[] = [
  {
    id: "side-chat",
    title: "侧聊",
    icon: <Chats size={14} />,
    defaultOpen: true,
    render: (context) => <SideChatPane key={context.task.id} task={context.task} />,
  },
  {
    id: "preview",
    title: "预览工作区",
    icon: <Browser size={14} />,
    defaultOpen: true,
    render: (context) => <PreviewWorkspaceEntry onOpen={context.onOpenPreview} />,
  },
  {
    id: "subagents",
    title: "子智能体",
    shortcut: "s",
    icon: <Robot size={14} />,
    defaultOpen: true,
    render: (context) => <NativeWorkInspector {...context.nativeWork} />,
  },
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
        activePath={context.openFilePath}
        onOpenFile={context.onOpenFile}
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
    id: "workflow",
    title: "工作流",
    icon: <GitBranch size={14} />,
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
];

