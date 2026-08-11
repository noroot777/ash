export type InspectorShortcutKey = "i" | "f" | "w" | "r" | "e";

export const INSPECTOR_SHORTCUT_PREFIX = "i";
export const INSPECTOR_SHORTCUT_TIMEOUT_MS = 1_000;

const SHORTCUT_KEYS = new Set<InspectorShortcutKey>(["i", "f", "w", "r", "e"]);

export function inspectorShortcutLabel(key: InspectorShortcutKey): string {
  return `${INSPECTOR_SHORTCUT_PREFIX.toUpperCase()} ${key.toUpperCase()}`;
}

export function isInspectorShortcutKey(key: string): key is InspectorShortcutKey {
  return SHORTCUT_KEYS.has(key as InspectorShortcutKey);
}

export type InspectorShortcutDecision =
  | { kind: "none" }
  | { kind: "prefix" }
  | { kind: "shortcut"; key: InspectorShortcutKey };

export function createInspectorShortcutSequence(timeoutMs = INSPECTOR_SHORTCUT_TIMEOUT_MS) {
  let prefixStartedAt: number | null = null;

  return {
    handle(rawKey: string, now = Date.now()): InspectorShortcutDecision {
      const key = rawKey.toLowerCase();
      if (prefixStartedAt !== null) {
        const withinTimeout = now >= prefixStartedAt && now - prefixStartedAt <= timeoutMs;
        prefixStartedAt = null;
        if (withinTimeout && isInspectorShortcutKey(key)) return { kind: "shortcut", key };
      }
      if (key === INSPECTOR_SHORTCUT_PREFIX) {
        prefixStartedAt = now;
        return { kind: "prefix" };
      }
      return { kind: "none" };
    },
    reset(): void {
      prefixStartedAt = null;
    },
  };
}

type InspectorShortcutTarget = (key: InspectorShortcutKey) => boolean;
const shortcutTargets: InspectorShortcutTarget[] = [];

export function registerInspectorShortcutTarget(target: InspectorShortcutTarget): () => void {
  shortcutTargets.push(target);
  return () => {
    const index = shortcutTargets.lastIndexOf(target);
    if (index >= 0) shortcutTargets.splice(index, 1);
  };
}

export function hasInspectorShortcutTarget(): boolean {
  return shortcutTargets.length > 0;
}

export function activateInspectorShortcut(key: InspectorShortcutKey): boolean {
  return shortcutTargets.at(-1)?.(key) ?? false;
}
