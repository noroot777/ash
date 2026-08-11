import type { ReactNode } from "react";
import type { InspectorShortcutKey } from "./shortcuts.ts";

export interface InspectorDescriptor<Context> {
  id: string;
  title: string;
  icon: ReactNode;
  render: (context: Context) => ReactNode;
  defaultOpen?: boolean;
  shortcut?: InspectorShortcutKey;
}

export interface InspectorTabPolicy {
  /** Changes only when the task enters a meaningfully different UI state. */
  stateKey: string;
  /** Re-added whenever a hidden Inspector is shown again. */
  requiredTabId: string;
  /** Added, without closing user-opened tabs, when stateKey changes. */
  defaultOpenTabIds: readonly string[];
  /** Focused once when stateKey changes; manual focus wins until then. */
  defaultActiveTabId: string;
}

export interface InspectorHostControls {
  visible: boolean;
  toggle: () => void;
  toggleButton: ReactNode;
}
