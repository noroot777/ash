import type { Group, ProjectView, Task, TaskListItem } from "@ash/shared";
import {
  Archive,
  ArrowLeft,
  ArrowsLeftRight,
  CirclesThreePlus,
  FolderSimple,
  GearSix,
  PlugsConnected,
  FlowArrow,
  Robot,
  MagnifyingGlass,
  SlidersHorizontal,
  Stack,
  Terminal,
  UsersThree,
} from "@phosphor-icons/react";
import { ArchiveSettings } from "./ArchiveSettings.tsx";
import { ConfigTransferSettings } from "./ConfigTransferSettings.tsx";
import { DefaultsSettings } from "./DefaultsSettings.tsx";
import { ExecutorsSettings } from "./ExecutorsSettings.tsx";
import { GroupsSettings } from "./GroupsSettings.tsx";
import { ModesSettings } from "./ModesSettings.tsx";
import { PersonalCliSettings } from "./PersonalCliSettings.tsx";
import { ProjectMembersSettings } from "./ProjectMembersSettings.tsx";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel.tsx";
import { ProvidersSettings } from "./ProvidersSettings.tsx";
import { UsersSettings } from "./UsersSettings.tsx";
import { WorkflowsSettings } from "./WorkflowsSettings.tsx";
import { ReviewerProfilesSettings } from "./ReviewerProfilesSettings.tsx";
import { useAuth } from "../auth/authContext.ts";
import "./agents-settings.css";
// 必须排在 agents-settings.css 之后:两边有几组共用的表单基础样式留在那边,
// 顺序换了层叠结果就变了(见 providers-settings.css 顶部)。
import "./providers-settings.css";
import "./executors-settings.css";
import "./reviewer-settings.css";

export type SettingsSection =
  | "project"
  | "members"
  | "groups"
  | "archive"
  | "providers"
  | "executors"
  | "modes"
  | "workflows"
  | "reviewers"
  | "cli-env"
  | "config"
  | "users"
  | "defaults";

// `requires` 决定这一节**在导航里显不显示**,不决定它存不存在 —— 两者分开的原因见
// 下面 SECTIONS 的注释。判据只有两种:
//  · "multi"      多人模式才有意义(自用模式下这一节的内容是空话)
//  · "multiAdmin" 还得是实例管理员(藏起来只是省事,真正的闸在后端)
type NavGate = "multi" | "multiAdmin";
type NavItem = { id: SettingsSection; label: string; icon: typeof GearSix; requires?: NavGate };

const PROJECT_NAV: readonly NavItem[] = [
  { id: "project", label: "项目设置", icon: FolderSimple },
  { id: "members", label: "成员", icon: UsersThree, requires: "multi" },
  { id: "groups", label: "分组", icon: Stack },
  { id: "archive", label: "已归档", icon: Archive },
];

const SYSTEM_NAV: readonly NavItem[] = [
  { id: "providers", label: "供应商", icon: PlugsConnected },
  { id: "executors", label: "执行器", icon: Robot },
  { id: "modes", label: "执行模式", icon: CirclesThreePlus },
  { id: "workflows", label: "起手式", icon: FlowArrow },
  { id: "reviewers", label: "审查者", icon: MagnifyingGlass },
  { id: "cli-env", label: "个人 CLI 环境", icon: Terminal, requires: "multi" },
  { id: "config", label: "配置搬家", icon: ArrowsLeftRight },
  { id: "users", label: "用户", icon: UsersThree, requires: "multiAdmin" },
  { id: "defaults", label: "默认规则", icon: SlidersHorizontal },
];

// 两份清单都从**完整**的 NAV 推,不受 requires 影响:URL 里带着 `?settings=users`
// 的链接在权限不够时该走「渲染时的空态」,而不是被 parse 判成非法后静默弹回默认节
// —— 那样看着就像「链接坏了」。
const PROJECT_SECTIONS: SettingsSection[] = PROJECT_NAV.map((item) => item.id);
// 从 SYSTEM_NAV 推出来而不是再抄一遍字面量：新加一节只改一处，不会出现「导航里
// 有、刷新一次就掉回默认」的半接通状态。
const SYSTEM_SECTIONS: SettingsSection[] = SYSTEM_NAV.map((item) => item.id);

// 内容**横着长**的那几节要更宽的栏。880px 那档是为「一行一个设置项」的竖排表单定的，
// 起手式却是一条横版线路图：站数一多，880px 里必然出横向滚动条，而滚动条一出，用户
// 就看不见这条线到底有几站——那正是这个页面唯一要传达的信息。
const WIDE_SECTIONS: SettingsSection[] = ["workflows"];

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
  items: readonly NavItem[];
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
  tasks: TaskListItem[];
  groups: Group[];
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  onProjectUpdated: (project: ProjectView) => void;
  onProjectDeleted: (projectId: string) => void;
  onTaskUpdated: (task: Task) => void;
  onGroupsChanged: () => void;
  notify: (message: string) => void;
}) {
  const { state } = useAuth();
  const isMulti = state.mode === "multi";
  const isInstanceAdmin = state.user?.role === "admin";
  const visible = (items: readonly NavItem[]) =>
    items.filter((item) =>
      item.requires === "multiAdmin" ? isMulti && isInstanceAdmin : item.requires === "multi" ? isMulti : true,
    );

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
            <SettingsNavItems items={visible(PROJECT_NAV)} section={section} onSection={onSection} />
          </div>
          <div className="settings-nav-group">
            <span className="settings-nav-label">系统设置</span>
            <SettingsNavItems items={visible(SYSTEM_NAV)} section={section} onSection={onSection} />
          </div>
        </nav>
      </aside>

      <main className="settings-main">
        <div className="settings-content" data-wide={WIDE_SECTIONS.includes(section) ? "yes" : "no"}>
          {section === "providers" && <ProvidersSettings notify={notify} />}
          {section === "executors" && <ExecutorsSettings notify={notify} />}
          {section === "modes" && <ModesSettings notify={notify} />}
          {section === "workflows" && <WorkflowsSettings notify={notify} />}
          {section === "reviewers" && <ReviewerProfilesSettings notify={notify} />}
          {section === "cli-env" && <PersonalCliSettings notify={notify} />}
          {section === "config" && <ConfigTransferSettings notify={notify} />}
          {section === "users" && <UsersSettings notify={notify} />}
          {section === "defaults" && <DefaultsSettings notify={notify} />}
          {section === "project" && project && (
            <ProjectSettingsPanel
              project={project}
              onUpdated={onProjectUpdated}
              onDeleted={() => onProjectDeleted(project.id)}
              notify={notify}
            />
          )}
          {section === "members" && project && (
            <ProjectMembersSettings project={project} notify={notify} />
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
