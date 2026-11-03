import type { ReactNode } from "react";
import type { InspectorSection } from "./sections.ts";
import type { InspectorShortcutKey } from "./shortcuts.ts";

export interface InspectorDescriptor<Context> {
  id: string;
  title: string;
  icon: ReactNode;
  render: (context: Context) => ReactNode;
  defaultOpen?: boolean;
  shortcut?: InspectorShortcutKey;
  /** 面板里能直达的那几节：按键先切到这一格，再由面板自己展开那一节（见 sections.ts）。 */
  sections?: readonly InspectorSection<InspectorShortcutKey>[];
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
  preserveActiveTabIds?: readonly string[];
}

export interface InspectorHostControls {
  visible: boolean;
  toggle: () => void;
  openTab: (id: string) => void;
  toggleButton: ReactNode;
}
