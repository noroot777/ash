// 右侧面板记在 localStorage 里的那份状态（`ash:inspector:<contextKey>`）：条上有哪几格、停在哪一格、
// 多宽、开没开，以及用户亲手摘掉过哪几格。读、写、按任务状态补格子的规则都在这里，宿主
// （InspectorHost.tsx）只管交互。
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import type { InspectorDescriptor, InspectorTabPolicy } from "./types.ts";

export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 720;
export const INSPECTOR_DEFAULT_WIDTH = 340;

export interface InspectorState {
  openTabs: string[];
  activeTab: string | null;
  width: number;
  visible: boolean;
  policyKey: string | null;
  /**
   * 用户亲手从竖轨上摘掉的格。任务状态变了（applyTabPolicy）也不把它们补回来，只有从「+」
   * 或快捷键加回才算数。必开的那一格（信息）不受它管：下次打开面板它自己回来。
   */
  dismissed: string[];
}

export function clampWidth(value: number) {
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, value));
}

function defaultState<Context>(
  descriptors: readonly InspectorDescriptor<Context>[],
  defaultVisible: boolean,
): InspectorState {
  const marked = descriptors.filter((descriptor) => descriptor.defaultOpen).map((descriptor) => descriptor.id);
  const openTabs = marked.length > 0 ? marked : descriptors.slice(0, 1).map((descriptor) => descriptor.id);
  return {
    openTabs,
    activeTab: openTabs[0] ?? null,
    width: INSPECTOR_DEFAULT_WIDTH,
    visible: defaultVisible && openTabs.length > 0,
    policyKey: null,
    dismissed: [],
  };
}

export function orderedValidTabs<Context>(
  ids: readonly string[],
  descriptors: readonly InspectorDescriptor<Context>[],
) {
  const requested = new Set(ids);
  return descriptors.filter((descriptor) => requested.has(descriptor.id)).map((descriptor) => descriptor.id);
}

export function applyTabPolicy<Context>(
  state: InspectorState,
  policy: InspectorTabPolicy,
  descriptors: readonly InspectorDescriptor<Context>[],
): InspectorState {
  const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
  const dismissed = new Set(state.dismissed.filter((id) => id !== policy.requiredTabId));
  const suggested = [...policy.defaultOpenTabIds, policy.defaultActiveTabId].filter((id) => !dismissed.has(id));
  const openTabs = orderedValidTabs([
    ...state.openTabs,
    policy.requiredTabId,
    ...suggested,
  ], descriptors);
  const activeTab = state.activeTab && descriptorIds.has(state.activeTab) && policy.preserveActiveTabIds?.includes(state.activeTab)
    ? state.activeTab
    : descriptorIds.has(policy.defaultActiveTabId) && openTabs.includes(policy.defaultActiveTabId)
    ? policy.defaultActiveTabId
    : state.activeTab && openTabs.includes(state.activeTab)
    ? state.activeTab
    : openTabs[0] ?? null;
  return {
    ...state,
    openTabs,
    activeTab,
    visible: state.visible && openTabs.length > 0,
    policyKey: policy.stateKey,
  };
}

export function readState<Context>(
  storageKey: string,
  descriptors: readonly InspectorDescriptor<Context>[],
  defaultVisible: boolean,
  tabPolicy?: InspectorTabPolicy,
) {
  const fallback = defaultState(descriptors, defaultVisible);
  const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
  try {
    const raw = readRenamedStorage(storageKey);
    if (!raw) return tabPolicy ? applyTabPolicy(fallback, tabPolicy, descriptors) : fallback;
    const parsed = JSON.parse(raw) as Partial<InspectorState>;
    const storedTabs = Array.isArray(parsed.openTabs)
      ? parsed.openTabs.filter((id): id is string => typeof id === "string")
      : null;
    const validTabs = storedTabs
      ? orderedValidTabs(storedTabs, descriptors)
      : fallback.openTabs;
    const openTabs = storedTabs && storedTabs.length > 0 && validTabs.length === 0
      ? fallback.openTabs
      : validTabs;
    const activeTab = typeof parsed.activeTab === "string" && openTabs.includes(parsed.activeTab)
      ? parsed.activeTab
      : openTabs[0] ?? null;
    const width = typeof parsed.width === "number" && Number.isFinite(parsed.width)
      ? clampWidth(parsed.width)
      : fallback.width;
    const visible = (typeof parsed.visible === "boolean" ? parsed.visible : fallback.visible)
      && openTabs.length > 0;
    const policyKey = typeof parsed.policyKey === "string" ? parsed.policyKey : null;
    const dismissed = Array.isArray(parsed.dismissed)
      ? parsed.dismissed.filter((id): id is string => typeof id === "string" && descriptorIds.has(id))
      : [];
    let restored: InspectorState = { openTabs, activeTab, width, visible, policyKey, dismissed };
    if (tabPolicy && policyKey !== tabPolicy.stateKey) {
      // A semantic task-state change deliberately wins over restored focus once.
      return applyTabPolicy(restored, tabPolicy, descriptors);
    }
    if (tabPolicy && visible && descriptorIds.has(tabPolicy.requiredTabId)
      && !restored.openTabs.includes(tabPolicy.requiredTabId)) {
      restored = { ...restored, openTabs: [...restored.openTabs, tabPolicy.requiredTabId] };
    }
    return restored;
  } catch {
    return tabPolicy ? applyTabPolicy(fallback, tabPolicy, descriptors) : fallback;
  }
}

export function storageKeyFor(contextKey: string) {
  return `ash:inspector:${contextKey}`;
}

