import { useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { api } from "./api.ts";

export type DetectedAgent = Awaited<ReturnType<typeof api.detectAgents>>[number];

export type AgentDetection =
  | { status: "loading"; agents: [] }
  | { status: "ready"; agents: DetectedAgent[] }
  | { status: "failed"; agents: [] };

export type ExecutorSelection = {
  agentType: AgentType;
  executorId: string | null;
};

export type ExecutorOption = {
  value: string;
  label: string;
  disabled: boolean;
};

const TYPE_PREFIX = "__type:";
// 检测拿不到结果时的保守兜底:这两个类型的执行器实现了 openResident
// (claude 进程级常驻、codex 会话级常驻),权威判断仍来自 detect 的 `resident`。
const RESIDENT_CAPABLE: readonly AgentType[] = ["claude", "codex"];
const LOADING: AgentDetection = { status: "loading", agents: [] };

let cachedDetection: Promise<AgentDetection> | null = null;
const detectionSubscribers = new Set<(detection: AgentDetection) => void>();

function loadDetection(): Promise<AgentDetection> {
  cachedDetection ??= api.detectAgents().then(
    (agents) => ({ status: "ready", agents }),
    () => ({ status: "failed", agents: [] }),
  );
  return cachedDetection;
}

function publishDetection(detection: AgentDetection) {
  for (const subscriber of detectionSubscribers) subscriber(detection);
}

/** Re-run local detection after the settings page installs or discovers a CLI. */
export function refreshAgentAvailability() {
  cachedDetection = null;
  publishDetection(LOADING);
  void loadDetection().then(publishDetection);
}

/** One cached local detection request shared by every executor picker on the page. */
export function useAgentAvailability(): AgentDetection {
  const [detection, setDetection] = useState<AgentDetection>(LOADING);
  useEffect(() => {
    let alive = true;
    const update = (next: AgentDetection) => { if (alive) setDetection(next); };
    detectionSubscribers.add(update);
    void loadDetection().then(update);
    return () => {
      alive = false;
      detectionSubscribers.delete(update);
    };
  }, []);
  return detection;
}

/** Types that the server positively detected as runnable on this machine. */
export function availableAgentTypes(agents: DetectedAgent[]): AgentType[] {
  const available = new Set(agents.filter((agent) => agent.available).map((agent) => agent.type));
  return AGENT_TYPES.filter((type) => available.has(type));
}

/**
 * 普通选择器只展示已经进入 agents 注册表的类型。类型默认项最终也会解析到该类型的
 * 默认 Profile，所以“本机装了但尚未注册”不应偷偷多出一个候选；要先去执行器设置注册。
 *
 * SSH 新增弹窗是刻意的例外：它需要从完整 AGENT_TYPES 目录里挑一个尚未注册的类型。
 */
export function registeredAgentTypes(profiles: AgentExecutorProfile[]): AgentType[] {
  const registered = new Set(profiles.map((profile) => profile.type));
  return AGENT_TYPES.filter((type) => registered.has(type));
}

/** Types whose executor implementation can own a resident team session. */
export function residentAgentTypes(agents: DetectedAgent[]): AgentType[] {
  const resident = new Set<AgentType>(RESIDENT_CAPABLE);
  for (const agent of agents) if (agent.resident) resident.add(agent.type);
  return AGENT_TYPES.filter((type) => resident.has(type));
}

/** Worker/reviewer choices plus the resident-only subset for team leads. */
export function teamExecutorCandidates(
  detection: AgentDetection,
  profiles: AgentExecutorProfile[],
) {
  const workerTypes = registeredAgentTypes(profiles);
  const residentTypes = residentAgentTypes(detection.agents);
  return {
    workerTypes,
    leadTypes: workerTypes.filter((type) => residentTypes.includes(type)),
    leadProfiles: profiles.filter((profile) => residentTypes.includes(profile.type)),
  };
}

export function isExecutorPickable(
  selection: ExecutorSelection,
  types: AgentType[],
  profiles: AgentExecutorProfile[],
): boolean {
  return selection.executorId
    ? profiles.some((profile) => profile.id === selection.executorId && profile.type === selection.agentType)
    : types.includes(selection.agentType);
}

/** 普通执行表面没有注册 Profile 就没有任何可选执行器。 */
export function nothingRunnable(profiles: AgentExecutorProfile[]): boolean {
  return profiles.length === 0;
}

export function preferredExecutor(
  types: AgentType[],
  profiles: AgentExecutorProfile[],
  preferred: AgentType,
  avoid?: AgentType,
): ExecutorSelection | null {
  const type = types.find((candidate) => candidate === preferred && candidate !== avoid)
    ?? types.find((candidate) => candidate !== avoid)
    ?? types[0];
  if (type) return { agentType: type, executorId: null };
  const profile = profiles.find((candidate) => candidate.type === preferred && candidate.type !== avoid && candidate.isDefault)
    ?? profiles.find((candidate) => candidate.type !== avoid && candidate.isDefault)
    ?? profiles.find((candidate) => candidate.type !== avoid)
    ?? profiles.find((candidate) => candidate.isDefault)
    ?? profiles[0];
  return profile ? { agentType: profile.type, executorId: profile.id } : null;
}

/**
 * 该选择**实际会跑**的模型与智能水平。
 *
 * Profile 名字里常常写着一个模型（`codex@cpa·gpt-5.6-sol`），但预设/任务级覆盖可以
 * 把它换成别的（存进 `*Model` / `*ReasoningEffort`）。只显示 Profile 名 + Profile
 * 自带模型，用户读到的就是被覆盖前的那个——所以生效值必须由这里统一算，界面照抄。
 */
export function executorRunSummary(
  selection: ExecutorSelection,
  profiles: AgentExecutorProfile[],
  override?: { model?: string | null; effort?: string | null },
): { model: string | null; effort: string | null; overridden: boolean } {
  const profile = selection.executorId
    ? profiles.find((candidate) => candidate.id === selection.executorId)
    : undefined;
  const overrideModel = override?.model?.trim() || null;
  const overrideEffort = override?.effort?.trim() || null;
  const model = overrideModel ?? profile?.model ?? null;
  const effort = overrideEffort ?? profile?.reasoningEffort ?? null;
  return {
    model,
    effort,
    overridden: (!!overrideModel && overrideModel !== (profile?.model ?? null))
      || (!!overrideEffort && overrideEffort !== (profile?.reasoningEffort ?? null)),
  };
}

export function executorValue(selection: ExecutorSelection): string {
  return selection.executorId ?? `${TYPE_PREFIX}${selection.agentType}`;
}

export function parseExecutorValue(
  value: string,
  profiles: AgentExecutorProfile[],
  fallback: ExecutorSelection,
): ExecutorSelection {
  if (value.startsWith(TYPE_PREFIX)) {
    const type = value.slice(TYPE_PREFIX.length) as AgentType;
    return AGENT_TYPES.includes(type) ? { agentType: type, executorId: null } : fallback;
  }
  const profile = profiles.find((candidate) => candidate.id === value);
  return profile ? { agentType: profile.type, executorId: profile.id } : fallback;
}

/**
 * Generate native-select options in one place. `types` 已经由 registeredAgentTypes
 * 收窄；显式 Profile 与类型默认项都只来自注册表。失效的当前值仅作为禁用诊断项保留，
 * 不会重新变成可选候选。
 */
export function executorOptions({
  types,
  profiles,
  selection,
  knownProfiles = profiles,
}: {
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  selection?: ExecutorSelection;
  knownProfiles?: AgentExecutorProfile[];
}): ExecutorOption[] {
  const options: ExecutorOption[] = types.map((type) => ({
    value: executorValue({ agentType: type, executorId: null }),
    label: `${type} · 类型默认`,
    disabled: false,
  }));
  options.push(...profiles.map((profile) => ({
    value: executorValue({ agentType: profile.type, executorId: profile.id }),
    label: `${profile.name}${profile.model ? ` · ${profile.model}` : ""}${profile.isDefault ? "（默认）" : ""}`,
    disabled: false,
  })));
  if (selection && !isExecutorPickable(selection, types, profiles)) {
    const profile = selection.executorId
      ? knownProfiles.find((candidate) => candidate.id === selection.executorId)
      : null;
    options.push({
      value: executorValue(selection),
      label: profile
        ? `${profile.name}（当前设置 · 不可用）`
        : `${selection.agentType} · 类型默认（当前设置 · 未注册）`,
      disabled: true,
    });
  }
  return options;
}
