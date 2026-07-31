import type { Task } from "@harness/shared";
import { Info } from "@phosphor-icons/react";
import type { InspectorDescriptor } from "./types";

export interface TaskInspectorContext {
  task: Task;
  allTasks: Task[];
}

export const taskInspectorDescriptors: InspectorDescriptor<TaskInspectorContext>[] = [
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    description: "单飞任务的 Inspector 挂载点",
    render: ({ task }) => (
      <InspectorPlaceholder
        eyebrow="单飞任务"
        title={task.title}
        copy="任务信息面板待迁移。Inspector 框架已可承载后续的文件树、详情与审查工具。"
      />
    ),
  },
];

function InspectorPlaceholder({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return (
    <div className="flex min-h-full flex-col p-5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{eyebrow}</span>
      <h2 className="mt-1.5 truncate text-[14px] font-semibold text-ink">{title}</h2>
      <div className="mt-5 rounded-lg border border-dashed border-line2 bg-canvas/70 px-4 py-5">
        <Info size={18} className="text-faint" />
        <p className="mt-3 text-[12px] leading-relaxed text-muted">{copy}</p>
      </div>
    </div>
  );
}
