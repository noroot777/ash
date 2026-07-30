import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { GearSix, Robot, Warning } from "@phosphor-icons/react";
import { api } from "./api";
import { Menu, type MenuOption } from "./Menu";

export type ExecutorSelection = { agentType: AgentType; executorId: string | null };

const TYPE_DEFAULT_PREFIX = "__executor_type_default__:";
export const MANAGE_EXECUTORS = "__manage_executors__";

export function typeDefaultExecutorValue(type: AgentType): string {
  return `${TYPE_DEFAULT_PREFIX}${type}`;
}

export function executorValue(sel: ExecutorSelection): string {
  return sel.executorId ?? typeDefaultExecutorValue(sel.agentType);
}

export function parseExecutorValue(
  value: string,
  profiles: AgentExecutorProfile[],
  fallback: ExecutorSelection,
): ExecutorSelection | null {
  if (value === MANAGE_EXECUTORS) return null;
  if (value.startsWith(TYPE_DEFAULT_PREFIX)) {
    return { agentType: value.slice(TYPE_DEFAULT_PREFIX.length) as AgentType, executorId: null };
  }
  const profile = profiles.find((a) => a.id === value);
  return profile ? { agentType: profile.type, executorId: profile.id } : fallback;
}

export function executorDetail(profile: AgentExecutorProfile, providers: LlmProvider[] = []): string {
  const provider = profile.providerId
    ? providers.find((p) => p.id === profile.providerId)?.name ?? `供应商 ${profile.providerId}`
    : "CLI 官方";
  return [profile.type, profile.model || "默认模型", provider].join(" · ");
}

export function useExecutorProfiles() {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  useEffect(() => {
    let alive = true;
    api.agents().then((list) => alive && setProfiles(list)).catch(() => alive && setProfiles([]));
    api.llmProviders().then((list) => alive && setProviders(list)).catch(() => alive && setProviders([]));
    return () => {
      alive = false;
    };
  }, []);
  return { profiles, providers };
}

// 下拉里的选项分两路生成,别把它们混成一路(2026-07-30 审查拦下过一次):
//
// 1. **「按 X 类型默认」只从 available 类型生成** —— 这是「按类型新选」,本机没探到的 CLI
//    选出来就是一单必然起不来的任务,所以 types 只该装 `availableTypes(detected)`。
// 2. **已注册的 profile 恒列出**,哪怕它的类型此刻没探到(ssh 远端执行器本机自然探不到,
//    用户显式登记过的东西不能被检测结果吞掉)。但列出 profile ≠ 把它的类型也变成第 1 类
//    候选,所以这些「孤儿 profile」单独成组、不带类型默认项。
// 3. 当前生效的选择如果两路都不在(老任务用的 CLI 刚被卸掉),补一条**只标注状态**的条目:
//    它让下拉能打上勾、也让用户看见「为什么这单跑不起来」。它永远等于当前值,所以不构成
//    一个新的可选项。
export function executorOptions({
  profiles,
  providers = [],
  types,
  includeTypeDefaults,
  includeManage = false,
  selection,
}: {
  profiles: AgentExecutorProfile[];
  providers?: LlmProvider[];
  types: AgentType[];
  includeTypeDefaults: boolean;
  includeManage?: boolean;
  /** 当前生效的选择;传了才会补第 3 类条目。 */
  selection?: ExecutorSelection;
}): MenuOption[] {
  const options: MenuOption[] = [];
  const pushGroup = (group: MenuOption[]) => {
    if (group.length === 0) return;
    const groupStart = options.length;
    options.push(...group);
    if (groupStart > 0) options[groupStart]!.separatorBefore = true;
  };
  const profileOption = (profile: AgentExecutorProfile, suffix = ""): MenuOption => ({
    value: profile.id,
    label: profile.name,
    detail: executorDetail(profile, providers) + suffix,
    icon: <Robot size={14} />,
  });

  for (const type of types) {
    const group: MenuOption[] = [];
    if (includeTypeDefaults) {
      const def = profiles.find((a) => a.type === type && a.isDefault);
      group.push({
        value: typeDefaultExecutorValue(type),
        label: `按 ${type} 类型默认`,
        detail: def ? `默认 · 当前会用 ${def.name}` : "默认 · 跟随该类型当前默认执行器",
        icon: <Robot size={14} />,
      });
    }
    group.push(...profiles.filter((a) => a.type === type).map((profile) => profileOption(profile)));
    pushGroup(group);
  }

  pushGroup(
    profiles
      .filter((profile) => !types.includes(profile.type))
      .map((profile) => profileOption(profile, " · 本机未检测到该 CLI")),
  );

  if (selection && !selection.executorId && !types.includes(selection.agentType)) {
    pushGroup([
      {
        value: typeDefaultExecutorValue(selection.agentType),
        label: `按 ${selection.agentType} 类型默认`,
        detail: "当前设置 · 本机未检测到该 CLI，很可能起不来",
        icon: <Warning size={14} />,
      },
    ]);
  }

  if (includeManage) {
    options.push({ value: MANAGE_EXECUTORS, label: "管理执行器…", detail: "注册执行器 / 配置供应商", icon: <GearSix size={14} /> });
  }
  return options;
}

export function ExecutorPicker({
  selection,
  onSelect,
  profiles,
  providers,
  types,
  label,
  icon,
  includeTypeDefaults = true,
  includeManage = false,
  onOpenAgents,
  onSetDefault,
  defaultSelection,
  menuWidth = 300,
  triggerClassName,
}: {
  selection: ExecutorSelection;
  onSelect: (sel: ExecutorSelection) => void;
  profiles: AgentExecutorProfile[];
  providers?: LlmProvider[];
  types: AgentType[];
  label?: ReactNode;
  icon?: ReactNode;
  includeTypeDefaults?: boolean;
  includeManage?: boolean;
  onOpenAgents?: () => void;
  onSetDefault?: (sel: ExecutorSelection) => void;
  defaultSelection?: ExecutorSelection;
  menuWidth?: number;
  triggerClassName?: string;
}) {
  const options = useMemo(
    () => executorOptions({ profiles, providers, types, includeTypeDefaults, includeManage, selection }),
    [profiles, providers, types, includeTypeDefaults, includeManage, selection],
  );
  const value = executorValue(selection);
  const selectedProfile = selection.executorId ? profiles.find((a) => a.id === selection.executorId) : null;
  const triggerLabel = label ?? (selectedProfile?.name ?? `默认 ${selection.agentType}`);
  return (
    <Menu
      value={value}
      onChange={(v) => {
        if (v === MANAGE_EXECUTORS) {
          onOpenAgents?.();
          return;
        }
        const next = parseExecutorValue(v, profiles, selection);
        if (next) onSelect(next);
      }}
      options={options}
      menuWidth={menuWidth}
      onSetDefault={onSetDefault ? (v) => {
        const next = parseExecutorValue(v, profiles, selection);
        if (next) onSetDefault(next);
      } : undefined}
      defaultValue={defaultSelection ? executorValue(defaultSelection) : undefined}
      triggerClassName={
        triggerClassName ??
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised focus:border-accent focus:outline-none"
      }
    >
      {icon ?? <Robot size={14} />}
      <span className="max-w-[220px] truncate whitespace-nowrap">{triggerLabel}</span>
    </Menu>
  );
}
