import type { Group, ProjectView, Task } from "@harness/shared";
import {
  Archive,
  ArrowLeft,
  CirclesThreePlus,
  FolderSimple,
  GearSix,
  PlugsConnected,
  FlowArrow,
  Robot,
  SlidersHorizontal,
  Stack,
} from "@phosphor-icons/react";
import { ArchiveSettings } from "./ArchiveSettings.tsx";
import { DefaultsSettings } from "./DefaultsSettings.tsx";
import { ExecutorsSettings } from "./ExecutorsSettings.tsx";
import { GroupsSettings } from "./GroupsSettings.tsx";
import { ModesSettings } from "./ModesSettings.tsx";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel.tsx";
import { ProvidersSettings } from "./ProvidersSettings.tsx";
import { WorkflowsSettings } from "./WorkflowsSettings.tsx";
import "./agents-settings.css";
import "./executors-settings.css";

export type SettingsSection =
  | "project"
  | "groups"
  | "archive"
  | "providers"
  | "executors"
  | "modes"
  | "workflows"
  | "defaults";

const PROJECT_NAV = [
  { id: "project", label: "项目设置", icon: FolderSimple },
  { id: "groups", label: "分组", icon: Stack },
  { id: "archive", label: "已归档", icon: Archive },
] as const;

const SYSTEM_NAV = [
  { id: "providers", label: "供应商", icon: PlugsConnected },
  { id: "executors", label: "执行器", icon: Robot },
  { id: "modes", label: "执行模式", icon: CirclesThreePlus },
  { id: "workflows", label: "起手式", icon: FlowArrow },
  { id: "defaults", label: "默认规则", icon: SlidersHorizontal },
] as const;

const PROJECT_SECTIONS: SettingsSection[] = ["project", "groups", "archive"];
// 从 SYSTEM_NAV 推出来而不是再抄一遍字面量：新加一节只改一处，不会出现「导航里
// 有、刷新一次就掉回默认」的半接通状态。
const SYSTEM_SECTIONS: SettingsSection[] = SYSTEM_NAV.map((item) => item.id);

export function parseSettingsSection(value: string | null): SettingsSection | null {
  if (value === "agents") return "executors";
  const section = value as SettingsSection;
  return PROJECT_SECTIONS.includes(section) || SYSTEM_SECTIONS.includes(section) ? section : null;
}

function SettingsNavItems({
  items,
  section,
  onSection,
}: {
  items: readonly { id: SettingsSection; label: string; icon: typeof GearSix }[];
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
}) {
  return items.map((item) => {
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
  });
}

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
        <nav aria-label="设置导航">
          <div className="settings-nav-group">
            <span className="settings-nav-label" title={project?.name}>{project?.name ?? "当前项目"}</span>
            <SettingsNavItems items={PROJECT_NAV} section={section} onSection={onSection} />
          </div>
          <div className="settings-nav-group">
            <span className="settings-nav-label">系统设置</span>
            <SettingsNavItems items={SYSTEM_NAV} section={section} onSection={onSection} />
          </div>
        </nav>
      </aside>

      <main className="settings-main">
        <div className="settings-content">
          {section === "providers" && <ProvidersSettings notify={notify} />}
          {section === "executors" && <ExecutorsSettings notify={notify} />}
          {section === "modes" && <ModesSettings notify={notify} />}
          {section === "workflows" && <WorkflowsSettings notify={notify} />}
          {section === "defaults" && <DefaultsSettings notify={notify} />}
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
          {PROJECT_SECTIONS.includes(section) && !project && (
            <div className="settings-empty">先在应用中选择一个项目。</div>
          )}
        </div>
      </main>
    </div>
  );
}
