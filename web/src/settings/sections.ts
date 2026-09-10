// 设置页有哪几节、各自叫什么、URL 里怎么写。
//
// 单独拆出来是因为**认路的人不止设置页自己**：报错文案里那句「设置 → 项目设置 → 预览」
// 要能点着跳过去（SettingsPathText.tsx），而那颗链接只需要一份「名字 → 节」的对照表，
// 不该为此把整页设置面板都拖进自己的模块图。图标仍留在 SettingsPage —— 那是渲染的事。
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
  | "account"
  | "defaults";

// `requires` 决定这一节**在导航里显不显示**,不决定它存不存在 —— 两者分开的原因见
// 下面 parseSettingsSection 的注释。判据只有两种:
//  · "multi"      多人模式才有意义(自用模式下这一节的内容是空话)
//  · "multiAdmin" 还得是实例管理员(藏起来只是省事,真正的闸在后端)
export type NavGate = "multi" | "multiAdmin";
export type NavItem = { id: SettingsSection; label: string; requires?: NavGate };

export const PROJECT_NAV: readonly NavItem[] = [
  { id: "project", label: "项目设置" },
  { id: "members", label: "成员", requires: "multi" },
  { id: "groups", label: "分组" },
  { id: "archive", label: "已归档" },
];

export const SYSTEM_NAV: readonly NavItem[] = [
  { id: "providers", label: "供应商" },
  { id: "executors", label: "执行器" },
  { id: "modes", label: "执行模式" },
  { id: "workflows", label: "起手式" },
  { id: "reviewers", label: "审查者" },
  { id: "cli-env", label: "个人 CLI 环境", requires: "multi" },
  { id: "config", label: "配置搬家" },
  { id: "users", label: "用户", requires: "multiAdmin" },
  { id: "account", label: "我的账号", requires: "multi" },
  { id: "defaults", label: "默认规则" },
];

// 两份清单都从**完整**的 NAV 推,不受 requires 影响:URL 里带着 `?settings=users`
// 的链接在权限不够时该走「渲染时的空态」,而不是被 parse 判成非法后静默弹回默认节
// —— 那样看着就像「链接坏了」。
export const PROJECT_SECTIONS: SettingsSection[] = PROJECT_NAV.map((item) => item.id);
export const SYSTEM_SECTIONS: SettingsSection[] = SYSTEM_NAV.map((item) => item.id);

/** 这一节要不要先有项目？要就返回它在导航里的名字（给拦下它的地方当提示词），不要就返回 null。 */
export function projectSectionLabel(section: SettingsSection): string | null {
  return PROJECT_NAV.find((item) => item.id === section)?.label ?? null;
}

export function parseSettingsSection(value: string | null): SettingsSection | null {
  if (value === "agents") return "executors";
  const section = value as SettingsSection;
  return PROJECT_SECTIONS.includes(section) || SYSTEM_SECTIONS.includes(section) ? section : null;
}

/** 按导航上写着的名字反查是哪一节 —— 文案里的「设置 → X」就是照着它认路的。 */
export function settingsSectionByLabel(label: string): SettingsSection | null {
  const wanted = label.trim();
  return [...PROJECT_NAV, ...SYSTEM_NAV].find((item) => item.label === wanted)?.id ?? null;
}

/**
 * 一节里面还能再往下指的落点：文案写「项目设置 → 预览」时，跳过去要停在预览那张卡上，
 * 而不是把人扔在页首让他自己找。
 *
 * 键是**文案里那个词**，值是页面上 `data-settings-anchor` 的取值；没登记的第三段就只
 * 开到那一节为止（不猜、也不报错）。
 */
export const SECTION_ANCHORS: Partial<Record<SettingsSection, Record<string, string>>> = {
  // 「预览命令」是这张卡的旧名字，存量文案里还有（改成「自定义脚本 / 选择服务」之前的说法）。
  project: { 预览: "preview", 预览命令: "preview" },
};
