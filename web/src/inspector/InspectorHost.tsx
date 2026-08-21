import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Plus, Sidebar, SidebarSimple, X } from "@phosphor-icons/react";
import { Menu, MenuItem } from "../components/ui.tsx";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { inspectorShortcutLabel, registerInspectorShortcutTarget } from "./shortcuts.ts";
import type { InspectorDescriptor, InspectorHostControls, InspectorTabPolicy } from "./types.ts";

export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 720;
export const INSPECTOR_DEFAULT_WIDTH = 340;

interface InspectorState {
  openTabs: string[];
  activeTab: string | null;
  width: number;
  visible: boolean;
  policyKey: string | null;
}

function clampWidth(value: number) {
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
  };
}

function orderedValidTabs<Context>(
  ids: readonly string[],
  descriptors: readonly InspectorDescriptor<Context>[],
) {
  const requested = new Set(ids);
  return descriptors.filter((descriptor) => requested.has(descriptor.id)).map((descriptor) => descriptor.id);
}

function applyTabPolicy<Context>(
  state: InspectorState,
  policy: InspectorTabPolicy,
  descriptors: readonly InspectorDescriptor<Context>[],
): InspectorState {
  const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
  const openTabs = orderedValidTabs([
    ...state.openTabs,
    policy.requiredTabId,
    ...policy.defaultOpenTabIds,
    policy.defaultActiveTabId,
  ], descriptors);
  const activeTab = descriptorIds.has(policy.defaultActiveTabId)
    ? policy.defaultActiveTabId
    : openTabs[0] ?? null;
  return {
    ...state,
    openTabs,
    activeTab,
    visible: state.visible && openTabs.length > 0,
    policyKey: policy.stateKey,
  };
}

function readState<Context>(
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
    let restored = { openTabs, activeTab, width, visible, policyKey };
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

function storageKeyFor(contextKey: string) {
  return `ash:inspector:${contextKey}`;
}

function safeDomId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function InspectorHost<Context>({
  contextKey,
  descriptors,
  context,
  defaultVisible = true,
  tabPolicy,
  children,
}: {
  contextKey: string;
  descriptors: readonly InspectorDescriptor<Context>[];
  context: Context;
  defaultVisible?: boolean;
  tabPolicy?: InspectorTabPolicy;
  children: (controls: InspectorHostControls) => ReactNode;
}) {
  return (
    <InspectorHostState
      key={contextKey}
      contextKey={contextKey}
      descriptors={descriptors}
      context={context}
      defaultVisible={defaultVisible}
      tabPolicy={tabPolicy}
    >
      {children}
    </InspectorHostState>
  );
}

function InspectorHostState<Context>({
  contextKey,
  descriptors,
  context,
  defaultVisible,
  tabPolicy,
  children,
}: {
  contextKey: string;
  descriptors: readonly InspectorDescriptor<Context>[];
  context: Context;
  defaultVisible: boolean;
  tabPolicy?: InspectorTabPolicy;
  children: (controls: InspectorHostControls) => ReactNode;
}) {
  const storageKey = storageKeyFor(contextKey);
  const [state, setState] = useState(() => readState(storageKey, descriptors, defaultVisible, tabPolicy));
  const [menuOpen, setMenuOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const descriptorById = useMemo(
    () => new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])),
    [descriptors],
  );
  const openedDescriptors = state.openTabs
    .map((id) => descriptorById.get(id))
    .filter((descriptor): descriptor is InspectorDescriptor<Context> => descriptor !== undefined);
  const activeDescriptor = descriptorById.get(state.activeTab ?? "") ?? openedDescriptors[0] ?? null;
  const panelVisible = state.visible && activeDescriptor !== null;
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const previousBodyStyle = useRef<{ cursor: string; userSelect: string } | null>(null);
  const instanceId = useId();
  const panelId = `${safeDomId(instanceId)}-inspector`;

  useDismissable({
    enabled: menuOpen,
    containerRef: menuRoot,
    onClose: () => setMenuOpen(false),
    restoreFocusRef: menuButton,
  });

  useEffect(() => {
    setState((current) => {
      const openTabs = orderedValidTabs(current.openTabs, descriptors);
      const activeTab = current.activeTab && openTabs.includes(current.activeTab)
        ? current.activeTab
        : openTabs[0] ?? null;
      const visible = current.visible && openTabs.length > 0;
      if (
        openTabs.length === current.openTabs.length
        && openTabs.every((id, index) => id === current.openTabs[index])
        && activeTab === current.activeTab
        && visible === current.visible
      ) return current;
      return { ...current, openTabs, activeTab, visible };
    });
  }, [descriptorById, descriptors]);

  useEffect(() => {
    if (!tabPolicy) return;
    // localStorage wins while stateKey is unchanged; a new semantic state wins exactly once.
    setState((current) => current.policyKey === tabPolicy.stateKey
      ? current
      : applyTabPolicy(current, tabPolicy, descriptors));
  }, [descriptors, tabPolicy?.stateKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // localStorage can be unavailable in privacy-restricted contexts.
    }
  }, [state, storageKey]);

  useEffect(() => {
    const stopResizing = () => {
      if (!dragStart.current) return;
      dragStart.current = null;
      setResizing(false);
      document.body.style.cursor = previousBodyStyle.current?.cursor ?? "";
      document.body.style.userSelect = previousBodyStyle.current?.userSelect ?? "";
      previousBodyStyle.current = null;
    };
    const resize = (event: MouseEvent) => {
      if (!dragStart.current) return;
      const nextWidth = dragStart.current.width + dragStart.current.x - event.clientX;
      setState((current) => ({ ...current, width: clampWidth(nextWidth) }));
    };
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
      stopResizing();
    };
  }, []);

  const toggle = () => {
    setMenuOpen(false);
    setState((current) => {
      if (current.visible && current.openTabs.length > 0) return { ...current, visible: false };
      const firstId = descriptors[0]?.id ?? null;
      let openTabs = current.openTabs.length > 0
        ? current.openTabs
        : firstId ? [firstId] : [];
      if (tabPolicy && descriptorById.has(tabPolicy.requiredTabId)
        && !openTabs.includes(tabPolicy.requiredTabId)) {
        openTabs = [...openTabs, tabPolicy.requiredTabId];
      }
      openTabs = orderedValidTabs(openTabs, descriptors);
      return {
        ...current,
        openTabs,
        activeTab: openTabs.includes(current.activeTab ?? "") ? current.activeTab : openTabs[0] ?? null,
        visible: openTabs.length > 0,
      };
    });
  };

  const closeTab = (id: string) => {
    setState((current) => {
      const closingIndex = current.openTabs.indexOf(id);
      const openTabs = current.openTabs.filter((tabId) => tabId !== id);
      const activeTab = current.activeTab === id
        ? openTabs[Math.min(closingIndex, openTabs.length - 1)] ?? null
        : current.activeTab;
      return { ...current, openTabs, activeTab, visible: current.visible && openTabs.length > 0 };
    });
  };

  const openTab = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      openTabs: orderedValidTabs([...current.openTabs, id], descriptors),
      activeTab: id,
      visible: true,
    }));
    setMenuOpen(false);
  }, [descriptors]);

  useEffect(() => registerInspectorShortcutTarget((shortcut) => {
    const descriptor = descriptors.find((candidate) => candidate.shortcut === shortcut);
    if (!descriptor) return false;
    openTab(descriptor.id);
    return true;
  }), [descriptors, openTab]);

  const toggleButton = (
    <button
      type="button"
      className={`inspector-toggle${panelVisible ? " is-active" : ""}`}
      aria-label={panelVisible ? "隐藏 Inspector" : "显示 Inspector"}
      aria-controls={panelId}
      aria-expanded={panelVisible}
      title={panelVisible ? "隐藏 Inspector" : "显示 Inspector"}
      onClick={toggle}
    >
      {panelVisible
        ? <SidebarSimple size={16} aria-hidden="true" />
        : <Sidebar size={16} aria-hidden="true" />}
    </button>
  );

  return (
    <div className="inspector-layout">
      <div className="inspector-layout__main">
        {children({ visible: panelVisible, toggle, openTab, toggleButton })}
      </div>
      {panelVisible && activeDescriptor && (
        <aside
          id={panelId}
          className={`inspector-host${resizing ? " inspector-host--resizing" : ""}`}
          style={{ "--inspector-width": `${state.width}px` } as CSSProperties}
          aria-label="Inspector 侧边栏"
        >
          <div
            className="inspector-host__resize-handle"
            role="separator"
            aria-label="调整 Inspector 宽度，双击恢复默认宽度"
            aria-orientation="vertical"
            aria-valuemin={INSPECTOR_MIN_WIDTH}
            aria-valuemax={INSPECTOR_MAX_WIDTH}
            aria-valuenow={state.width}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              dragStart.current = { x: event.clientX, width: state.width };
              previousBodyStyle.current = {
                cursor: document.body.style.cursor,
                userSelect: document.body.style.userSelect,
              };
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
              setResizing(true);
            }}
            onDoubleClick={() => setState((current) => ({ ...current, width: INSPECTOR_DEFAULT_WIDTH }))}
          />
          <div className="inspector-host__tabbar">
            <div className="inspector-host__tabs" role="tablist" aria-label="已打开的 Inspector 面板">
              {openedDescriptors.map((descriptor) => {
                const active = descriptor.id === activeDescriptor.id;
                const tabId = `${panelId}-tab-${safeDomId(descriptor.id)}`;
                const contentId = `${panelId}-panel-${safeDomId(descriptor.id)}`;
                return (
                  <div key={descriptor.id} className={`inspector-tab${active ? " is-active" : ""}`}>
                    <button
                      id={tabId}
                      type="button"
                      className="inspector-tab__trigger"
                      role="tab"
                      aria-selected={active}
                      aria-controls={contentId}
                      aria-label={descriptor.shortcut
                        ? `${descriptor.title}，快捷键 ${inspectorShortcutLabel(descriptor.shortcut)}`
                        : descriptor.title}
                      tabIndex={active ? 0 : -1}
                      title={descriptor.title}
                      onClick={() => setState((current) => ({ ...current, activeTab: descriptor.id }))}
                    >
                      <span className="inspector-tab__icon" aria-hidden="true">{descriptor.icon}</span>
                      <span className="inspector-tab__title">{descriptor.title}</span>
                    </button>
                    <button
                      type="button"
                      className="inspector-tab__close"
                      aria-label={`关闭${descriptor.title}`}
                      title={`关闭${descriptor.title}`}
                      onClick={() => closeTab(descriptor.id)}
                    >
                      <X size={11} weight="bold" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="inspector-host__add-root" ref={menuRoot}>
              <button
                ref={menuButton}
                type="button"
                className="inspector-host__add"
                aria-label="切换 Inspector 面板"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={descriptors.length === 0}
                title={descriptors.length > 0 ? "切换面板" : "没有可用面板"}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Plus size={14} weight="bold" aria-hidden="true" />
              </button>
              {menuOpen && (
                <Menu className="inspector-host__menu">
                  {descriptors.map((descriptor) => (
                    <MenuItem
                      key={descriptor.id}
                      selected={descriptor.id === activeDescriptor?.id}
                      shortcut={descriptor.shortcut ? inspectorShortcutLabel(descriptor.shortcut) : undefined}
                      aria-label={descriptor.shortcut
                        ? `${descriptor.title}，快捷键 ${inspectorShortcutLabel(descriptor.shortcut)}`
                        : descriptor.title}
                      onClick={() => openTab(descriptor.id)}
                    >
                      <span className="inspector-host__menu-label">
                        <span aria-hidden="true">{descriptor.icon}</span>
                        {descriptor.title}
                      </span>
                    </MenuItem>
                  ))}
                </Menu>
              )}
            </div>
          </div>
          <div
            id={`${panelId}-panel-${safeDomId(activeDescriptor.id)}`}
            className="inspector-host__content"
            role="tabpanel"
            aria-labelledby={`${panelId}-tab-${safeDomId(activeDescriptor.id)}`}
          >
            {activeDescriptor.render(context)}
          </div>
        </aside>
      )}
    </div>
  );
}
