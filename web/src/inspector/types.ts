import type { ReactNode } from "react";
import type { InspectorShortcutKey } from "./shortcuts.ts";

/**
 * 竖轨图标右上角那颗点。`has` = 这一格里有东西（灰点），`run` = 有东西在跑（主色点）。
 * 选中只有一种长相（墨色图标 + 右缘竖条），状态一律走这颗点，两件事不再抢同一块底色。
 */
export type InspectorDot = "has" | "run";

export interface InspectorDescriptor<Context> {
  id: string;
  title: string;
  icon: ReactNode;
  dot?: InspectorDot | null;
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
  preserveActiveTabIds?: readonly string[];
}

export interface InspectorHostControls {
  visible: boolean;
  toggle: () => void;
  /** 切到 `id` 那一格（不在条上就加上去、整栏收着就展开）。`request` 是带给那一格的话，见 nav.tsx。 */
  openTab: (id: string, request?: Readonly<Record<string, unknown>>) => void;
  toggleButton: ReactNode;
}
