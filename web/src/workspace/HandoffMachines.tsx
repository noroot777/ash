import { useCallback, useEffect, useMemo, useState } from "react";
import type { HandoffTarget, ProjectView, TaskListItem } from "@ash/shared";
import { DesktopTower, PaperPlaneTilt } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { BulkHandoffDialog } from "./BulkHandoffDialog.tsx";
import { outboundTasksForTarget } from "./bulkHandoff.ts";

export function HandoffMachines({
  project,
  tasks,
  selectedRemoteTaskId,
  onRemoteTask,
  notify,
  onFinished,
}: {
  project: ProjectView | null;
  tasks: TaskListItem[];
  selectedRemoteTaskId: string | null;
  onRemoteTask: (task: TaskListItem, target: HandoffTarget) => void;
  notify: (message: string) => void;
  onFinished: () => Promise<void> | void;
}) {
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const [selected, setSelected] = useState<HandoffTarget | null>(null);

  const reloadTargets = useCallback(() => {
    let alive = true;
    // 走 `/handoff/targets` 而不是 `GET /settings` 里那份:多人模式下目标机按人存,
    // app_settings 那份是自用模式的公共清单(多人实例里通常是空的)。
    api.handoffTargets()
      .then((rows) => { if (alive) setTargets(rows); })
      .catch((reason) => { if (alive) notify(reason instanceof Error ? reason.message : "接力目标读取失败"); });
    return () => { alive = false; };
  }, [notify]);
  useEffect(() => reloadTargets(), [reloadTargets]);

  const outboundByTarget = useMemo(() => new Map(targets.map((target) => [
    target.url,
    project ? outboundTasksForTarget(tasks, project.id, target, targets) : [],
  ])), [project, targets, tasks]);

  if (!targets.length || !project) return null;

  return (
    <section className="workspace-task-section workspace-handoff-machines" aria-labelledby="workspace-handoff-machines-title">
      <header className="workspace-task-section-title" id="workspace-handoff-machines-title">其他机器</header>
      <div className="workspace-handoff-machine-list">
        {targets.map((target) => {
          const outbound = outboundByTarget.get(target.url) ?? [];
          return (
            <div className="workspace-handoff-machine-group" key={target.url}>
              <div className="workspace-handoff-machine">
                <DesktopTower size={14} aria-hidden="true" />
                <span className="workspace-handoff-machine-copy">
                  <b>{target.name}</b>
                </span>
                <button
                  type="button"
                  aria-label={`把本项目正在跑的任务接力到 ${target.name}`}
                  onClick={() => setSelected(target)}
                >
                  <PaperPlaneTilt size={13} weight="bold" aria-hidden="true" />
                </button>
              </div>
              {outbound.length > 0 && (
                <div className="workspace-handoff-task-list" aria-label={`${target.name}上的接力任务`}>
                  {outbound.map((task) => (
                    <button
                      className={`workspace-handoff-task${selectedRemoteTaskId === task.id ? " is-selected" : ""}`}
                      type="button"
                      aria-current={selectedRemoteTaskId === task.id ? "page" : undefined}
                      onClick={() => onRemoteTask(task, target)}
                      key={task.id}
                    >
                      <i aria-hidden="true" />
                      <span>{task.title || "未命名任务"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {selected && (
        <BulkHandoffDialog
          project={project}
          target={selected}
          tasks={tasks}
          notify={notify}
          onClose={() => { setSelected(null); reloadTargets(); }}
          onFinished={onFinished}
        />
      )}
    </section>
  );
}
