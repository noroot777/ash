import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Sidebar, SidebarSimple, X } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useNarrowScreen } from "../lib/useNarrowScreen.ts";
import { InspectorHeadSlotProvider } from "./headActions.tsx";
import { InspectorRail } from "./InspectorRail.tsx";
import { InspectorNavProvider, type InspectorNav, type InspectorRequest } from "./nav.tsx";
import { registerInspectorShortcutTarget } from "./shortcuts.ts";
import {
  applyTabPolicy,
  clampWidth,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  orderedValidTabs,
  readState,
  storageKeyFor,
  type InspectorState,
} from "./inspectorState.ts";
import type { InspectorDescriptor, InspectorHostControls, InspectorTabPolicy } from "./types.ts";

export { INSPECTOR_DEFAULT_WIDTH, INSPECTOR_MAX_WIDTH, INSPECTOR_MIN_WIDTH } from "./inspectorState.ts";

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
  const [resizing, setResizing] = useState(false);
  /** 头带中段那块动作位的真实节点，交给当前面板 portal 用（见 headActions.tsx）。 */
  const [headSlot, setHeadSlot] = useState<HTMLDivElement | null>(null);
  const descriptorById = useMemo(
    () => new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])),
    [descriptors],
  );
  const openedDescriptors = state.openTabs
    .map((id) => descriptorById.get(id))
    .filter((descriptor): descriptor is InspectorDescriptor<Context> => descriptor !== undefined);
  const activeDescriptor = descriptorById.get(state.activeTab ?? "") ?? openedDescriptors[0] ?? null;
  // 窄屏上 Inspector 是盖在内容上的一层（inspector.css）：在手机上打开页面时不开，开关只算这一回，不改桌面上
  // 记着的开 / 关。开着的时候窗口被拉窄，就照样开着（变成盖在上面的一层），不让正看着的东西凭空消失。
  const narrow = useNarrowScreen();
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [narrowSeen, setNarrowSeen] = useState(narrow);
  if (narrow !== narrowSeen) {
    setNarrowSeen(narrow);
    if (narrow) setNarrowOpen(state.visible);
  }
  const panelVisible = (narrow ? narrowOpen : state.visible) && activeDescriptor !== null;
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const previousBodyStyle = useRef<{ cursor: string; userSelect: string } | null>(null);
  const instanceId = useId();
  const panelId = `${safeDomId(instanceId)}-inspector`;
  const tabIdFor = useCallback((id: string) => `${panelId}-tab-${safeDomId(id)}`, [panelId]);
  const contentIdFor = useCallback((id: string) => `${panelId}-panel-${safeDomId(id)}`, [panelId]);

  // 面板集合是会变的（子智能体那一格要等真派出子智能体才存在），`defaultOpen` 也可以是
  // 会变的。这里同时做两件事：把已经不在的页签摘掉，以及让**刚刚才变成默认开**的面板自己
  // 冒到图标条上。记的是「哪些格曾经默认开过」而不是「哪些格存在过」，于是这两种出现方式
  // 都认得；记过之后就不再认，所以用户手动关掉的面板不会被反复拽回来。出现时不抢当前
  // 焦点——面板多冒出来一个可以不看，正读着的东西被换走则一定是打扰。
  const knownTabIds = useRef(new Set(
    descriptors.filter((descriptor) => descriptor.defaultOpen).map((descriptor) => descriptor.id),
  ));
  useEffect(() => {
    const appeared = descriptors
      .filter((descriptor) => descriptor.defaultOpen && !knownTabIds.current.has(descriptor.id))
      .map((descriptor) => descriptor.id);
    for (const descriptor of descriptors) {
      if (descriptor.defaultOpen) knownTabIds.current.add(descriptor.id);
    }
    setState((current) => {
      const openTabs = orderedValidTabs([...current.openTabs, ...appeared], descriptors);
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

  /** 打开前把页签备好：一个都没开就开第一个，必开的那一格补上。 */
  const withTabs = (current: InspectorState): InspectorState => {
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
    };
  };

  const toggle = () => {
    if (narrow) {
      if (panelVisible) {
        setNarrowOpen(false);
        return;
      }
      setState(withTabs);
      setNarrowOpen(true);
      return;
    }
    setState((current) => {
      if (current.visible && current.openTabs.length > 0) return { ...current, visible: false };
      const next = withTabs(current);
      return { ...next, visible: next.openTabs.length > 0 };
    });
  };

  // 关闭键 = 把这一格移出竖轨，切到它后面那一格（它是最后一格就切到前面那格）；条上只剩
  // 它一格时整栏收起。摘完以后关闭键还在原地、指的已经是下一格：0.4 秒内紧跟着的那一下
  // 不算，连点两下不会连摘两格。中间换过格、加过格就不再拦（那已经不是连点了）。
  const removedAt = useRef(0);
  const closeTab = (id: string) => {
    if (performance.now() - removedAt.current < 400) return;
    removedAt.current = performance.now();
    setState((current) => {
      const closingIndex = current.openTabs.indexOf(id);
      const openTabs = current.openTabs.filter((tabId) => tabId !== id);
      const activeTab = current.activeTab === id
        ? openTabs[Math.min(closingIndex, openTabs.length - 1)] ?? null
        : current.activeTab;
      const dismissed = current.dismissed.includes(id) ? current.dismissed : [...current.dismissed, id];
      return { ...current, openTabs, activeTab, dismissed, visible: current.visible && openTabs.length > 0 };
    });
  };

  // 再点已选中的那一格 = 收起整栏。只认鼠标（回车、空格触发的 click，detail 是 0）；刚切过来
  // 350ms 内的那一下不算，否则双击一格会「先选中再收起」。
  const switchedAt = useRef(0);
  const selectTab = (id: string, clicks = 0) => {
    if (id === activeDescriptor?.id) {
      if (clicks > 0 && performance.now() - switchedAt.current > 350) {
        if (narrow) setNarrowOpen(false);
        else setState((current) => ({ ...current, visible: false }));
      }
      return;
    }
    switchedAt.current = performance.now();
    removedAt.current = 0;
    setState((current) => ({ ...current, activeTab: id }));
  };

  // 带着话的打开（见 nav.tsx）：那一格收下就清掉，只说一次。
  const [request, setRequest] = useState<InspectorNav["request"]>(null);
  const requestSeq = useRef(0);
  const consumeRequest = useCallback((seq: number) => {
    setRequest((current) => (current?.seq === seq ? null : current));
  }, []);

  const openTab = useCallback((id: string, params?: InspectorRequest) => {
    if (params) {
      requestSeq.current += 1;
      setRequest({ id, params, seq: requestSeq.current });
    }
    switchedAt.current = performance.now();
    removedAt.current = 0;
    setState((current) => ({
      ...current,
      openTabs: orderedValidTabs([...current.openTabs, id], descriptors),
      activeTab: id,
      dismissed: current.dismissed.filter((tabId) => tabId !== id),
      ...(narrow ? {} : { visible: true }),
    }));
    if (narrow) setNarrowOpen(true);
  }, [descriptors, narrow]);

  // Registration order preserves drawer priority; changing icons/titles only refresh the callback data.
  const shortcutContext = useRef({ descriptors, openTab });
  useLayoutEffect(() => {
    shortcutContext.current = { descriptors, openTab };
  }, [descriptors, openTab]);

  useEffect(() => registerInspectorShortcutTarget((shortcut) => {
    const current = shortcutContext.current;
    const descriptor = current.descriptors.find((candidate) => candidate.shortcut === shortcut);
    if (!descriptor) return false;
    current.openTab(descriptor.id);
    return true;
  }), []);

  const toggleTip = useHoverTip();
  const closeTip = useHoverTip();
  const nav = useMemo<InspectorNav>(() => ({ openTab, request, consume: consumeRequest }), [consumeRequest, openTab, request]);

  const toggleButton = (
    <>
      <button
        type="button"
        className={`inspector-toggle${panelVisible ? " is-active" : ""}`}
        aria-label={panelVisible ? "隐藏 Inspector" : "显示 Inspector"}
        aria-controls={panelId}
        aria-expanded={panelVisible}
        {...toggleTip.anchorProps}
        onClick={() => { toggleTip.hide(); toggle(); }}
      >
        {panelVisible
          ? <SidebarSimple size={16} aria-hidden="true" />
          : <Sidebar size={16} aria-hidden="true" />}
      </button>
      <HoverTip at={toggleTip.at}>{panelVisible ? "收起右侧面板" : "展开右侧面板"}</HoverTip>
    </>
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
          <InspectorRail
            items={openedDescriptors}
            allItems={descriptors}
            activeId={activeDescriptor.id}
            tabIdFor={tabIdFor}
            contentIdFor={contentIdFor}
            onSelect={selectTab}
            onOpen={openTab}
          />
          <div className="inspector-host__panel">
            <div className="inspector-host__panel-head">
              <span className="inspector-host__panel-title">{activeDescriptor.title}</span>
              {/* 当前面板自己的入口挂这里（InspectorHeadActions），省掉面板内部那条常驻工具栏。 */}
              <div className="inspector-host__panel-actions" ref={setHeadSlot} />
              {/* 窄屏上它盖着内容：这个叉是「收起、回到内容」，不是关掉这一格。 */}
              <button
                type="button"
                className="inspector-host__panel-close"
                aria-label={narrow ? "收起 Inspector" : `关闭${activeDescriptor.title}`}
                {...closeTip.anchorProps}
                onClick={() => narrow ? setNarrowOpen(false) : closeTab(activeDescriptor.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
              <HoverTip at={closeTip.at}>{narrow ? "收起，回到内容" : "移出竖轨，可从 + 加回"}</HoverTip>
            </div>
            <div
              id={contentIdFor(activeDescriptor.id)}
              className="inspector-host__content"
              role="tabpanel"
              aria-labelledby={tabIdFor(activeDescriptor.id)}
            >
              <InspectorHeadSlotProvider value={headSlot}>
                <InspectorNavProvider value={nav}>
                  {activeDescriptor.render(context)}
                </InspectorNavProvider>
              </InspectorHeadSlotProvider>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
