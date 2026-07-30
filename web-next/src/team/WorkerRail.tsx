import { useEffect, useMemo } from "react";
import type { Group, Task } from "@harness/shared";
import { formatDuration } from "../task-detail/utils.ts";
import { executorLabel, statusTone, workerStatusText } from "./teamModel.ts";

function elapsed(task: Task): string | null {
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
}: {
  workers: Task[];
  groups: Group[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index > 8 || !workers[index]) return;
      event.preventDefault();
      onSelect(workers[index].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelect, workers]);

  return (
    <aside className="team-worker-rail" aria-label="执行者列表">
      <header><span>执行者（{workers.length}）</span>{workers.length > 0 && <small>按 1–9</small>}</header>
      {!workers.length && <p>调度者还没派活。派出的真实任务会在这里持续显示状态。</p>}
      {workers.map((worker, index) => {
        const paused = !!(worker.groupId && groupById.get(worker.groupId)?.paused);
        const duration = elapsed(worker);
        return (
          <button
            type="button"
            key={worker.id}
            className={selectedId === worker.id ? "is-selected" : worker.question ? "is-asking" : ""}
            onClick={() => onSelect(worker.id)}
          >
            <div>
              <i className={`team-status-dot team-status-dot--${statusTone(worker)}`} />
              <b>{worker.title}</b>
              <code title={executorLabel(worker)}>{executorLabel(worker)}</code>
              <kbd>{index < 9 ? index + 1 : ""}</kbd>
            </div>
            <small>{workerStatusText(worker, paused)}{duration ? ` · ${duration}` : ""}</small>
            {worker.question && <p>{worker.question}</p>}
          </button>
        );
      })}
      {workers.length > 0 && <footer>点执行者打开完整任务详情；运行、答复和重试仍走单任务原流程。</footer>}
    </aside>
  );
}
