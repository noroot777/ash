import { useMemo } from "react";
import type { Group, TaskListItem } from "@ash/shared";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { InspNone } from "../inspector/parts.tsx";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { formatDuration } from "../task-detail/utils.ts";
import { executorLabel, workerStatusText } from "./teamModel.ts";

function elapsed(task: TaskListItem): string | null {
  if (!task.startedAt) return null;
  const start = Date.parse(task.startedAt);
  const end = task.endedAt ? Date.parse(task.endedAt) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(end - start) : null;
}

export function WorkerRail({
  workers,
  groups,
  selectedId,
  onSelect,
  indicatorForTask,
  liveLines,
}: {
  workers: TaskListItem[];
  groups: Group[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  indicatorForTask: IndicatorForTask;
  liveLines: Record<string, string>;
}) {
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  return (
    <aside className="team-worker-rail" aria-label="执行者列表">
      <header><span>执行者（{workers.length}）</span>{workers.length > 0 && <small>按 1–9</small>}</header>
      {!workers.length && <InspNone>调度者还没派活。</InspNone>}
      {workers.map((worker, index) => {
        const paused = !!(worker.groupId && groupById.get(worker.groupId)?.paused);
        const duration = elapsed(worker);
        const indicator = indicatorForTask(worker);
        const liveLine = liveLines[worker.id];
        return (
          <button
            type="button"
            key={worker.id}
            className={selectedId === worker.id ? "is-selected" : worker.question ? "is-asking" : ""}
            onClick={() => onSelect(worker.id)}
          >
            <div>
              <span className="team-worker-rail__index">{index + 1}</span>
              {indicator && <TaskStatusDot indicator={indicator} surface="team" />}
              <b>{worker.title}</b>
              <code title={executorLabel(worker)}>{executorLabel(worker)}</code>
            </div>
            <small>{workerStatusText(worker, paused)}{duration ? ` · ${duration}` : ""}</small>
            {worker.question && <p className="team-worker-rail__question">{worker.question}</p>}
            {liveLine && <p className="team-worker-rail__live" title={liveLine}>{liveLine}</p>}
          </button>
        );
      })}
    </aside>
  );
}
