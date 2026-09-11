const DONE_KEY = "ash:inspector:retired-tabs";

interface StoredState {
  openTabs?: unknown;
  activeTab?: unknown;
  visible?: unknown;
}

function readDone(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DONE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 换默认面板时用一次：把「曾经是默认」的那个面板从已存的 Inspector 状态里摘掉。
 *
 * 光改 `defaultOpen` / `tabPolicy` 治不了存量——`applyTabPolicy` 是并集语义，
 * 老默认会一直躺在 localStorage 里跟着开。这里按 `migrationId` 记账只跑一次，
 * 所以之后用户自己再打开它就一直留着，不会被下一次语义换挡又关掉。
 */
export function retireInspectorTab(migrationId: string, keyPattern: RegExp, tabId: string) {
  if (typeof window === "undefined") return;
  try {
    const done = readDone();
    if (done.includes(migrationId)) return;
    for (const key of Object.keys(window.localStorage)) {
      if (!keyPattern.test(key)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      let state: StoredState;
      try {
        state = JSON.parse(raw) as StoredState;
      } catch {
        continue;
      }
      if (!state || typeof state !== "object" || !Array.isArray(state.openTabs)) continue;
      const openTabs = state.openTabs.filter((id) => id !== tabId);
      if (openTabs.length === state.openTabs.length) continue;
      window.localStorage.setItem(key, JSON.stringify({
        ...state,
        openTabs,
        activeTab: state.activeTab === tabId ? openTabs[0] ?? null : state.activeTab,
        visible: state.visible === true && openTabs.length > 0,
      }));
    }
    window.localStorage.setItem(DONE_KEY, JSON.stringify([...done, migrationId]));
  } catch {
    // localStorage 在隐私模式下可能不可用：迁移失败就保持原样，不影响面板本身。
  }
}
