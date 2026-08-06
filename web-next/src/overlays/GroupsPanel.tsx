import { useEffect, useState } from "react";
import type { Group, ProjectView, Task } from "@harness/shared";
import { Stack, X } from "@phosphor-icons/react";
import { GroupManager } from "../settings/GroupsSettings.tsx";

export function GroupsPanel({ project, groups, tasks, onClose, onChanged, notify }: {
  project: ProjectView;
  groups: Group[];
  tasks: Task[];
  onClose: () => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) {
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);
  const visibleCount = groups.filter((group) => !group.ownerTaskId).length;

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || nestedDialogOpen) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [nestedDialogOpen, onClose]);

  return (
    <div className="overlay-scrim groups-panel-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !nestedDialogOpen) onClose();
    }}>
      <section className="groups-panel" role="dialog" aria-modal="true" aria-labelledby="groups-panel-title">
        <header>
          <div>
            <span className="groups-panel-icon" aria-hidden="true"><Stack size={16} weight="duotone" /></span>
            <span className="groups-panel-heading">
              <b id="groups-panel-title">分组管理</b>
              <small>{project.name} · {visibleCount} 个分组</small>
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭分组管理"><X size={17} /></button>
        </header>
        <div className="groups-panel-body">
          <GroupManager
            project={project}
            groups={groups}
            tasks={tasks}
            onChanged={onChanged}
            notify={notify}
            onNestedDialogChange={setNestedDialogOpen}
          />
        </div>
      </section>
    </div>
  );
}
