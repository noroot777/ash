import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { InspectorDescriptor, InspectorPersistedState } from "./types";
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
} from "./types";

interface RegisteredInspector {
  id: string;
  title: string;
  icon: ReactNode;
  description?: string;
  render: () => ReactNode;
}

interface InspectorContextValue {
  descriptors: RegisteredInspector[];
  openDescriptors: RegisteredInspector[];
  unopenedDescriptors: RegisteredInspector[];
  activeDescriptor: RegisteredInspector | null;
  state: InspectorPersistedState;
  shown: boolean;
  activate: (id: string) => void;
  open: (id: string) => void;
  close: (id: string) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
}

const InspectorContext = createContext<InspectorContextValue | null>(null);

function clampWidth(width: number) {
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, width));
}

function uniqueKnownIds(ids: unknown, known: Set<string>) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  return ids.filter((id): id is string => {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function defaultState(descriptors: { id: string }[], defaultOpenIds?: string[]): InspectorPersistedState {
  const known = new Set(descriptors.map((descriptor) => descriptor.id));
  const requested = defaultOpenIds ?? descriptors.slice(0, 1).map((descriptor) => descriptor.id);
  const openIds = uniqueKnownIds(requested, known);
  return {
    openIds,
    activeId: openIds[0] ?? null,
    width: INSPECTOR_DEFAULT_WIDTH,
    visible: openIds.length > 0,
  };
}

function readState(
  storageKey: string,
  descriptors: { id: string }[],
  defaultOpenIds?: string[],
): InspectorPersistedState {
  const fallback = defaultState(descriptors, defaultOpenIds);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<InspectorPersistedState>;
    const known = new Set(descriptors.map((descriptor) => descriptor.id));
    const openIds = uniqueKnownIds(parsed.openIds, known);
    const activeId = typeof parsed.activeId === "string" && openIds.includes(parsed.activeId)
      ? parsed.activeId
      : openIds[0] ?? null;
    const storedWidth = typeof parsed.width === "number" && Number.isFinite(parsed.width)
      ? parsed.width
      : INSPECTOR_DEFAULT_WIDTH;
    return {
      openIds,
      activeId,
      width: clampWidth(storedWidth),
      visible: parsed.visible === true && openIds.length > 0,
    };
  } catch {
    return fallback;
  }
}

export function InspectorProvider<Context>({
  contextKey,
  descriptors,
  context,
  defaultOpenIds,
  children,
}: {
  contextKey: string;
  descriptors: InspectorDescriptor<Context>[];
  context: Context;
  defaultOpenIds?: string[];
  children: ReactNode;
}) {
  const storageKey = `harness.inspector.${contextKey}`;
  const registered = useMemo<RegisteredInspector[]>(
    () => descriptors.map((descriptor) => ({
      ...descriptor,
      render: () => descriptor.render(context),
    })),
    [context, descriptors],
  );
  const descriptorIds = useMemo(() => registered.map((descriptor) => descriptor.id), [registered]);
  const descriptorIdKey = descriptorIds.join("\u0000");
  const [state, setState] = useState(() => readState(storageKey, registered, defaultOpenIds));

  useEffect(() => {
    const known = new Set(descriptorIds);
    setState((current) => {
      const openIds = uniqueKnownIds(current.openIds, known);
      const activeId = current.activeId && openIds.includes(current.activeId)
        ? current.activeId
        : openIds[0] ?? null;
      if (
        openIds.length === current.openIds.length
        && openIds.every((id, index) => id === current.openIds[index])
        && activeId === current.activeId
        && (openIds.length > 0 || !current.visible)
      ) return current;
      return { ...current, openIds, activeId, visible: current.visible && openIds.length > 0 };
    });
  }, [descriptorIdKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Inspector state is a convenience; a storage failure must not break the page.
    }
  }, [state, storageKey]);

  const activate = useCallback((id: string) => {
    setState((current) => current.openIds.includes(id)
      ? { ...current, activeId: id, visible: true }
      : current);
  }, []);

  const open = useCallback((id: string) => {
    if (!descriptorIds.includes(id)) return;
    setState((current) => ({
      ...current,
      openIds: current.openIds.includes(id) ? current.openIds : [...current.openIds, id],
      activeId: id,
      visible: true,
    }));
  }, [descriptorIdKey]);

  const close = useCallback((id: string) => {
    setState((current) => {
      const index = current.openIds.indexOf(id);
      if (index < 0) return current;
      const openIds = current.openIds.filter((openId) => openId !== id);
      const activeId = current.activeId === id
        ? openIds[Math.min(index, openIds.length - 1)] ?? null
        : current.activeId;
      return { ...current, openIds, activeId, visible: current.visible && openIds.length > 0 };
    });
  }, []);

  const toggle = useCallback(() => {
    setState((current) => {
      if (current.visible && current.openIds.length > 0) return { ...current, visible: false };
      if (current.openIds.length > 0) return { ...current, visible: true };
      const firstId = descriptorIds[0];
      if (!firstId) return current;
      return { ...current, openIds: [firstId], activeId: firstId, visible: true };
    });
  }, [descriptorIdKey]);

  const setWidth = useCallback((width: number) => {
    setState((current) => ({ ...current, width: clampWidth(width) }));
  }, []);

  const byId = useMemo(() => new Map(registered.map((descriptor) => [descriptor.id, descriptor])), [registered]);
  const openDescriptors = state.openIds.flatMap((id) => {
    const descriptor = byId.get(id);
    return descriptor ? [descriptor] : [];
  });
  const opened = new Set(state.openIds);
  const unopenedDescriptors = registered.filter((descriptor) => !opened.has(descriptor.id));
  const activeDescriptor = state.activeId ? byId.get(state.activeId) ?? null : null;
  const shown = state.visible && openDescriptors.length > 0;
  const value = useMemo<InspectorContextValue>(() => ({
    descriptors: registered,
    openDescriptors,
    unopenedDescriptors,
    activeDescriptor,
    state,
    shown,
    activate,
    open,
    close,
    toggle,
    setWidth,
  }), [
    registered,
    openDescriptors,
    unopenedDescriptors,
    activeDescriptor,
    state,
    shown,
    activate,
    open,
    close,
    toggle,
    setWidth,
  ]);

  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export function useInspector() {
  const value = useContext(InspectorContext);
  if (!value) throw new Error("Inspector components must be rendered inside InspectorProvider");
  return value;
}
