import type { Group, ProjectView, Task, TaskListItem } from "@ash/shared";
import { useEffect } from "react";
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
  UserCircle,
  UsersThree,
} from "@phosphor-icons/react";
import { AccountSettings } from "./AccountSettings.tsx";
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
import {
  PROJECT_NAV,
  PROJECT_SECTIONS,
  SYSTEM_NAV,
  type NavItem,
  type SettingsSection,
} from "./sections.ts";
import "./agents-settings.css";
// 必须排在 agents-settings.css 之后:两边有几组共用的表单基础样式留在那边,
// 顺序换了层叠结果就变了(见 providers-settings.css 顶部)。
import "./providers-settings.css";
import "./executors-settings.css";
import "./reviewer-settings.css";

// 这一节到底属于哪个导航组、叫什么名字、URL 里怎么写，全在 sections.ts（认路的不止这一页：
// 报错文案里的「设置 → …」也照着那份对照表跳）。这里只补图标 —— 那是渲染的事。
export type { SettingsSection } from "./sections.ts";
export { parseSettingsSection, projectSectionLabel } from "./sections.ts";

const NAV_ICONS: Record<SettingsSection, typeof GearSix> = {
  project: FolderSimple,
  members: UsersThree,
  groups: Stack,
  archive: Archive,
  providers: PlugsConnected,
  executors: Robot,
  modes: CirclesThreePlus,
  workflows: FlowArrow,
  reviewers: MagnifyingGlass,
  "cli-env": Terminal,
  config: ArrowsLeftRight,
  users: UsersThree,
  account: UserCircle,
  defaults: SlidersHorizontal,
};

// 内容**横着长**的那几节要更宽的栏。880px 那档是为「一行一个设置项」的竖排表单定的，
// 起手式却是一条横版线路图：站数一多，880px 里必然出横向滚动条，而滚动条一出，用户
// 就看不见这条线到底有几站——那正是这个页面唯一要传达的信息。
const WIDE_SECTIONS: SettingsSection[] = ["workflows"];

const noop = () => {};

/**
 * 从文案里的「设置 → 项目设置 → 预览」点进来时，停在**那张卡**上，而不是把人扔在页首
 * 自己找 —— 项目设置这一页竖着排了六七张卡，预览在中间偏下，落在页首等于只跳对了一半。
 *
 * 落点由目标卡自己声明（`data-settings-anchor`，取值登记在 sections.ts 的 SECTION_ANCHORS）：
 * 这一页不认识任何一张卡的内部结构，加一处落点只用改被指的那张卡。找不到就什么都不做 ——
 * 人已经到了正确的一节，无缘无故滚一下更让人摸不着头脑。
 */
function useSettingsAnchor(anchor: string | null | undefined, section: SettingsSection, onSettled: () => void) {
  useEffect(() => {
    if (!anchor) return;
    // 面板自己还要再渲染一帧（项目设置那几张卡都等 project 到位），所以下一帧再找。
    const frame = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-settings-anchor="${anchor}"]`);
      // 落点用过就摘（否则之后每次切回这一节都再滚一遍）。摘的动作会让这个 effect 重跑，
      // 所以**闪那一下不能挂在 effect 的清理上** —— 交给 flashAnchor 自己收尾。
      onSettled();
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      flashAnchor(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor, section, onSettled]);
}

/** 滚过去还得说清楚「就是这张」：设置页上同款卡片长得都一样。动画自己放完自己收。 */
function flashAnchor(target: HTMLElement) {
  target.classList.add("is-anchor-flash");
  target.addEventListener("animationend", () => target.classList.remove("is-anchor-flash"), { once: true });
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
    const Icon = NAV_ICONS[item.id];
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
  anchor,
  onAnchorSettled,
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
  /** 这一次是冲着某张卡来的（文案里的「设置 → 项目设置 → 预览」），到了就滚过去并点一下它。 */
  anchor?: string | null;
  /** 落点处理完了：调用方摘掉它，免得之后每次切回这一节都再滚一次。 */
  onAnchorSettled?: () => void;
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
  useSettingsAnchor(anchor, section, onAnchorSettled ?? noop);

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
          {section === "users" && <UsersSettings notify={notify} onAccount={() => onSection("account")} />}
          {section === "account" && <AccountSettings notify={notify} />}
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
