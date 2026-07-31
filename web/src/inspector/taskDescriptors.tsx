import type { ReactNode } from "react";
import type { Group, Session, Task } from "@harness/shared";
import { ArrowSquareOut, Info, MagnifyingGlass } from "@phosphor-icons/react";
import type { ConvItem } from "../Conversation";
import { TaskReviewPanel } from "../TaskReviewPanel";
import { TaskInfoPanel } from "../task/TaskInfoPanel";
import type { InspectorDescriptor } from "./types";

export interface TaskInspectorContext {
  task: Task;
  managedWorker: boolean;
  groups: Group[];
  allTasks: Task[];
  sessions: Session[];
  items: ConvItem[];
  queueSize: number | null;
  refreshing: boolean;
  runConfigControls: ReactNode;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onCreateGroup: () => void;
  onOpenQueue: () => void;
  onOpenDiff: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  onOpenTask: (taskId: string) => void;
  onReviewTaskCreated: (task: Task) => void;
}

export const taskInspectorDescriptors: InspectorDescriptor<TaskInspectorContext>[] = [
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    description: "任务属性、运行配置、工作区、提交与原始需求",
    render: (context) => <TaskInfoPanel {...context} />,
  },
  {
    id: "review",
    title: "审查",
    icon: <MagnifyingGlass size={14} />,
    description: "审查轮次、派审查配置与证据截图",
    render: ({ task, allTasks, onOpenTask, onReviewTaskCreated }) => {
      if (task.reviewOf) {
        const source = allTasks.find((candidate) => candidate.id === task.reviewOf);
        return (
          <div className="min-h-full bg-canvas p-4">
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.035] p-4">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-500/10 text-violet-700">
                <MagnifyingGlass size={16} weight="bold" />
              </span>
              <h2 className="mt-3 text-[13px] font-semibold text-ink">当前任务是一轮审查</h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                审查记录、报告和证据归档在原任务中；当前页保留顶部紫色上下文条和本轮审查会话。
              </p>
              <button
                type="button"
                onClick={() => onOpenTask(task.reviewOf!)}
                className="mt-3 flex w-full items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-left text-[11.5px] font-medium text-white transition-colors hover:bg-violet-500"
              >
                <span className="min-w-0 flex-1 truncate">打开原任务「{source?.title ?? task.reviewOf}」</span>
                <ArrowSquareOut size={12} className="shrink-0" />
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="min-h-full bg-canvas px-4 pb-4 pt-1">
          <TaskReviewPanel
            task={task}
            allTasks={allTasks}
            onOpenTask={onOpenTask}
            onReviewTaskCreated={onReviewTaskCreated}
            defaultExpanded={false}
            compact
          />
        </div>
      );
    },
  },
];
