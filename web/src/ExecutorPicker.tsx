import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { GearSix, Robot } from "@phosphor-icons/react";
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

export function executorOptions({
  profiles,
  providers = [],
  types,
  includeTypeDefaults,
  includeManage = false,
}: {
  profiles: AgentExecutorProfile[];
  providers?: LlmProvider[];
  types: AgentType[];
  includeTypeDefaults: boolean;
  includeManage?: boolean;
}): MenuOption[] {
  const options: MenuOption[] = [];
  for (const type of types) {
    if (includeTypeDefaults) {
      const def = profiles.find((a) => a.type === type && a.isDefault);
      options.push({
        value: typeDefaultExecutorValue(type),
        label: `按 ${type} 类型默认`,
        detail: def ? `默认 · 当前会用 ${def.name}` : "默认 · 跟随该类型当前默认执行器",
        icon: <Robot size={14} />,
      });
    }
    for (const profile of profiles.filter((a) => a.type === type)) {
      options.push({
        value: profile.id,
        label: profile.name,
        detail: executorDetail(profile, providers),
        icon: <Robot size={14} />,
      });
    }
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
  menuWidth?: number;
  triggerClassName?: string;
}) {
  const options = useMemo(
    () => executorOptions({ profiles, providers, types, includeTypeDefaults, includeManage }),
    [profiles, providers, types, includeTypeDefaults, includeManage],
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
