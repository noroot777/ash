import type { Group, ProjectView, Task } from "@harness/shared";
import {
  Archive,
  ArrowLeft,
  FolderSimple,
  Robot,
  Stack,
} from "@phosphor-icons/react";
import { LegacyLink } from "../components/LegacyLink.tsx";
import { ProjectAvatar } from "../workspace/ProjectAvatar.tsx";
import { AgentsSettings } from "./AgentsSettings.tsx";
import { ArchiveSettings } from "./ArchiveSettings.tsx";
import { GroupsSettings } from "./GroupsSettings.tsx";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel.tsx";

export type SettingsSection = "agents" | "project" | "groups" | "archive";

const NAV = [
  { id: "agents", label: "智能体", icon: Robot },
  { id: "project", label: "项目设置", icon: FolderSimple },
  { id: "groups", label: "分组", icon: Stack },
  { id: "archive", label: "已归档", icon: Archive },
] as const;

export function SettingsPage({
  section,
  project,
  tasks,
  groups,
  onSection,
  onBack,
  onProjectUpdated,
  onProjectDeleted,
  onTaskUpdated,
  onGroupsChanged,
  notify,
}: {
  section: SettingsSection;
  project: ProjectView | null;
  tasks: Task[];
  groups: Group[];
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  onProjectUpdated: (project: ProjectView) => void;
  onProjectDeleted: (projectId: string) => void;
  onTaskUpdated: (task: Task) => void;
  onGroupsChanged: () => void;
  notify: (message: string) => void;
}) {
  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <button className="settings-back" type="button" onClick={onBack}>
          <ArrowLeft size={14} weight="bold" aria-hidden="true" />
          返回应用
        </button>
        <div className="settings-project-mark">
          {project ? <ProjectAvatar project={project} size="large" /> : <span className="workspace-project-avatar" />}
          <span>
            <b>{project?.name ?? "Harness"}</b>
            <small>设置</small>
          </span>
        </div>
        <nav aria-label="设置导航">
          <span className="settings-nav-label">工作区</span>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className="ui-selectable"
                type="button"
                aria-selected={section === item.id}
                onClick={() => onSection(item.id)}
              >
                <Icon size={15} aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="settings-sidebar-foot">
          <LegacyLink projectId={project?.id ?? null} taskId={null} view="settings" settings={section} />
        </div>
      </aside>

      <main className="settings-main">
        <div className="settings-content">
          {section === "agents" && <AgentsSettings notify={notify} />}
          {section === "project" && project && (
            <ProjectSettingsPanel
              project={project}
              onUpdated={onProjectUpdated}
              onDeleted={() => onProjectDeleted(project.id)}
              notify={notify}
            />
          )}
          {section === "groups" && project && (
            <GroupsSettings
              project={project}
              groups={groups}
              tasks={tasks}
              onChanged={onGroupsChanged}
              notify={notify}
            />
          )}
          {section === "archive" && project && (
            <ArchiveSettings
              project={project}
              tasks={tasks}
              onTaskUpdated={onTaskUpdated}
              notify={notify}
            />
          )}
          {section !== "agents" && !project && (
            <div className="settings-empty">先在应用中选择一个项目。</div>
          )}
        </div>
      </main>
    </div>
  );
}
