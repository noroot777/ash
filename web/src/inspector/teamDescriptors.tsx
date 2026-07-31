import type { Group, Session, Task } from "@harness/shared";
import { Clock, Info, UsersThree } from "@phosphor-icons/react";
import type { ConvItem, LogLine } from "../Conversation";
import { TeamInfoPanel } from "../team/TeamInfoPanel";
import { TeamTimeline } from "../team/TeamTimeline";
import type { LeadTurn } from "../team/teamData";
import { WorkerRail } from "../team/WorkerRail";
import type { InspectorDescriptor } from "./types";

export interface TeamInspectorContext {
  task: Task;
  workers: Task[];
  groups: Group[];
  logs: Record<string, LogLine[]>;
  selectedWorkerId: string | null;
  onSelectWorker: (id: string) => void;
  sessions: Session[];
  items: ConvItem[];
  leadTurns: LeadTurn[];
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onDelete: () => void;
  canIterateDebate: boolean;
  iterateBusy: boolean;
  onIterateDebate: () => void;
}

export const teamInspectorDescriptors: InspectorDescriptor<TeamInspectorContext>[] = [
  {
    id: "workers",
    title: "执行者",
    icon: <UsersThree size={14} />,
    description: "执行者状态、快捷键与实时日志",
    render: ({ workers, groups, logs, selectedWorkerId, onSelectWorker }) => (
      <WorkerRail
        workers={workers}
        groups={groups}
        logs={logs}
        selected={selectedWorkerId}
        onSelect={onSelectWorker}
      />
    ),
  },
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    description: "团队配置、工作区、原始需求与任务操作",
    render: (context) => <TeamInfoPanel {...context} />,
  },
  {
    id: "timeline",
    title: "时间轴",
    icon: <Clock size={14} />,
    description: "调度者与执行者的并行瀑布图",
    render: ({ task, workers, groups, leadTurns, onSelectWorker }) => (
      <TeamTimeline
        lead={task}
        workers={workers}
        groups={groups}
        leadTurns={leadTurns}
        onOpen={onSelectWorker}
      />
    ),
  },
];
