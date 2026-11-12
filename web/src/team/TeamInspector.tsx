import type { Group, Session, Task, TaskListItem } from "@ash/shared";
import { Clock, FolderOpen, Images, Info, MagnifyingGlass, NotePencil, Pulse, Robot, UsersThree } from "@phosphor-icons/react";
import { NativeWorkInspector, type NativeWorkInspectorProps } from "../task-detail/NativeWorkInspector.tsx";
import { FileTreeInspector } from "../files/FileTreeInspector.tsx";
import { ArtifactsInspector } from "../files/ArtifactsInspector.tsx";
import type { ScmDiffTarget } from "../scm/scmModel.ts";
import { retireInspectorTab, type InspectorDescriptor } from "../inspector/index.ts";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import type { Notify } from "../lib/notify.ts";
import { TeamTimeline } from "./TeamTimeline.tsx";
import { TeamReviewInspector } from "./TeamReviewInspector.tsx";
import { WorkerRail } from "./WorkerRail.tsx";
import { monitorBlockedReason } from "@ash/shared/monitor";
import { MonitorInspector } from "../monitors/MonitorInspector.tsx";
import { TaskMemoInspector } from "../task-memos/TaskMemoInspector.tsx";
import type { TaskMonitorsState } from "../monitors/useTaskMonitors.ts";
import { TeamInfoPanel } from "./TeamInfoPanel.tsx";
import type { LeadTurn } from "./teamModel.ts";

export interface TeamInspectorContext {
  nativeWork: NativeWorkInspectorProps;
  /** 哨兵那一格的数据源；挂在调度台自己身上（执行者各有各的任务页）。 */
  monitors: TaskMonitorsState;
  task: Task;
  workers: TaskListItem[];
  groups: Group[];
  sessions: Session[];
  leadTurns: LeadTurn[];
  selectedWorkerId: string | null;
  onSelectWorker: (taskId: string) => void;
  onOpenReview: () => void;
  onOpenTask: (taskId: string) => void;
  indicatorForTask: IndicatorForTask;
  workerLiveLines: Record<string, string>;
  /** 文件树该高亮哪一行：摊的是全文、diff 还是文件夹，对它来说是同一个路径。 */
  activeFilePath: string | null;
  /** 第二个参数是「这一串」：同组生成物、同一层文件，中间栏据此能翻上一张/下一张。 */
  onOpenFile: (path: string, reel?: readonly string[]) => void;
  /** 在中间栏摊开文件夹详情（里面有多少东西、能不能删）。 */
  onOpenFolder: (path: string) => void;
  onOpenDiff: (target: ScmDiffTarget) => void;
  notify: Notify;
}

// 团队模式的默认面板里不放子智能体：调度台自己那点工具调用远不如「谁跟谁在并行」有用，
// 时间轴顶上它的位置。这一摘是一次性的历史迁移（当时它还是无条件默认开）；现在的开合统一
// 走「用过才浮现」——调度台真派过子智能体才上条，否则从「+」或 I S 打开。
retireInspectorTab("team-subagents-default", /^(?:ash|harness-next):inspector:team:/, "subagents");

export const TEAM_INSPECTORS: readonly InspectorDescriptor<TeamInspectorContext>[] = [
  {
    id: "workers",
    title: "执行者",
    icon: <UsersThree size={14} />,
    defaultOpen: true,
    shortcut: "e",
    render: (context) => (
      <WorkerRail
        workers={context.workers}
        groups={context.groups}
        selectedId={context.selectedWorkerId}
        onSelect={context.onSelectWorker}
        indicatorForTask={context.indicatorForTask}
        liveLines={context.workerLiveLines}
      />
    ),
  },
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    defaultOpen: true,
    shortcut: "i",
    render: (context) => <TeamInfoPanel task={context.task} workers={context.workers} sessions={context.sessions} notify={context.notify} />,
  },
  {
    // 跟单飞任务同一格（同一个组件、同一张表）：调度台也是一条任务，「这一轮为什么这么派」
    // 一样要有地方记。两个入口也一样齐：头带上手写，以及团队会话里选中一段（浮条挂在
    // TeamView 的 TeamFeed 外面）。
    id: "memos",
    title: "备忘",
    icon: <NotePencil size={14} />,
    defaultOpen: true,
    shortcut: "b",
    render: (context) => <TaskMemoInspector taskId={context.task.id} notify={context.notify} />,
  },
  {
    id: "timeline",
    title: "时间轴",
    icon: <Clock size={14} />,
    defaultOpen: true,
    shortcut: "t",
    render: (context) => (
      <TeamTimeline
        lead={context.task}
        leadTurns={context.leadTurns}
        workers={context.workers}
        groups={context.groups}
        onOpenWorker={context.onSelectWorker}
        defaultOpen
      />
    ),
  },
  {
    id: "review",
    title: "审查",
    icon: <MagnifyingGlass size={14} />,
    shortcut: "r",
    render: (context) => (
      <TeamReviewInspector
        lead={context.task}
        workers={context.workers}
        onOpenReview={context.onOpenReview}
        onOpenTask={context.onOpenTask}
      />
    ),
  },
  {
    id: "files",
    title: "文件",
    icon: <FolderOpen size={14} />,
    shortcut: "f",
    // 团队共享调度台的工作目录，所以这棵树就是整队人正在改的那份文件。
    render: (context) => (
      <FileTreeInspector
        taskId={context.task.id}
        activePath={context.activeFilePath}
        onOpenFile={context.onOpenFile}
        onOpenFolder={context.onOpenFolder}
        onOpenDiff={context.onOpenDiff}
        notify={context.notify}
      />
    ),
  },
  {
    // 团队共享调度台的工作目录，所以这一格收的是整队人做出来的东西。
    id: "artifacts",
    title: "生成物",
    icon: <Images size={14} />,
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
    // 和单飞任务同一条「用过才浮现」：调度台自己派过子智能体才上图标条（useSubagents 决定），
    // 没派过就留在「+」菜单和 I S 里。
    id: "subagents",
    title: "子智能体",
    shortcut: "s",
    icon: <Robot size={14} />,
    render: (context) => <NativeWorkInspector {...context.nativeWork} />,
  },
  {
    // 盯的是调度台自己挂的哨兵。和单飞任务同样「用过才浮现」：开合由 useMonitorInspector 翻，
    // 所以这里不写 defaultOpen。
    id: "monitors",
    title: "哨兵",
    icon: <Pulse size={14} />,
    shortcut: "m",
    render: (context) => (
      <MonitorInspector monitors={context.monitors} blockedReason={monitorBlockedReason(context.task)} />
    ),
  },
];
