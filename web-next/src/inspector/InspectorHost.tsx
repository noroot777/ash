import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Plus, Sidebar, SidebarSimple, X } from "@phosphor-icons/react";
import { Menu, MenuItem } from "../components/ui.tsx";
import type { InspectorDescriptor, InspectorHostControls } from "./types.ts";

export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 720;
export const INSPECTOR_DEFAULT_WIDTH = 340;

interface InspectorState {
  openTabs: string[];
  activeTab: string | null;
  width: number;
  visible: boolean;
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
  };
}

function readState<Context>(
  storageKey: string,
  descriptors: readonly InspectorDescriptor<Context>[],
  defaultVisible: boolean,
) {
  const fallback = defaultState(descriptors, defaultVisible);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<InspectorState>;
    const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
    const storedTabs = Array.isArray(parsed.openTabs)
      ? parsed.openTabs.filter((id): id is string => typeof id === "string")
      : null;
    const validTabs = storedTabs
      ? [...new Set(storedTabs.filter((id) => descriptorIds.has(id)))]
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
    return { openTabs, activeTab, width, visible };
  } catch {
    return fallback;
  }
}

function storageKeyFor(contextKey: string) {
  return `harness-next:inspector:${contextKey}`;
}

function safeDomId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function InspectorHost<Context>({
  contextKey,
  descriptors,
  context,
  defaultVisible = true,
  children,
}: {
  contextKey: string;
  descriptors: readonly InspectorDescriptor<Context>[];
  context: Context;
  defaultVisible?: boolean;
  children: (controls: InspectorHostControls) => ReactNode;
}) {
  return (
    <InspectorHostState
      key={contextKey}
      contextKey={contextKey}
      descriptors={descriptors}
      context={context}
      defaultVisible={defaultVisible}
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
  children,
}: {
  contextKey: string;
  descriptors: readonly InspectorDescriptor<Context>[];
  context: Context;
  defaultVisible: boolean;
  children: (controls: InspectorHostControls) => ReactNode;
}) {
  const storageKey = storageKeyFor(contextKey);
  const [state, setState] = useState(() => readState(storageKey, descriptors, defaultVisible));
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
  const openIds = new Set(openedDescriptors.map((descriptor) => descriptor.id));
  const availableDescriptors = descriptors.filter((descriptor) => !openIds.has(descriptor.id));
  const panelVisible = state.visible && activeDescriptor !== null;
  const menuRoot = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const previousBodyStyle = useRef<{ cursor: string; userSelect: string } | null>(null);
  const instanceId = useId();
  const panelId = `${safeDomId(instanceId)}-inspector`;

  useEffect(() => {
    setState((current) => {
      const openTabs = current.openTabs.filter((id) => descriptorById.has(id));
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
  }, [descriptorById]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // localStorage can be unavailable in privacy-restricted contexts.
    }
  }, [state, storageKey]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

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
      const openTabs = current.openTabs.length > 0
        ? current.openTabs
        : firstId ? [firstId] : [];
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

  const openTab = (id: string) => {
    setState((current) => ({
      ...current,
      openTabs: current.openTabs.includes(id) ? current.openTabs : [...current.openTabs, id],
      activeTab: id,
      visible: true,
    }));
    setMenuOpen(false);
  };

  const toggleButton = (
    <button
      type="button"
      className={`inspector-toggle${panelVisible ? " is-active" : ""}`}
      aria-label={panelVisible ? "隐藏侧边栏" : "显示侧边栏"}
      aria-controls={panelId}
      aria-expanded={panelVisible}
      title={panelVisible ? "隐藏侧边栏" : "显示侧边栏"}
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
        {children({ visible: panelVisible, toggle, toggleButton })}
      </div>
      {panelVisible && activeDescriptor && (
        <aside
          id={panelId}
          className={`inspector-host${resizing ? " inspector-host--resizing" : ""}`}
          style={{ width: state.width, minWidth: state.width }}
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
                type="button"
                className="inspector-host__add"
                aria-label="打开 Inspector 面板"
                aria-expanded={menuOpen}
                disabled={availableDescriptors.length === 0}
                title={availableDescriptors.length > 0 ? "打开面板" : "所有面板均已打开"}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Plus size={14} weight="bold" aria-hidden="true" />
              </button>
              {menuOpen && (
                <Menu className="inspector-host__menu">
                  {availableDescriptors.map((descriptor) => (
                    <MenuItem key={descriptor.id} onClick={() => openTab(descriptor.id)}>
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
