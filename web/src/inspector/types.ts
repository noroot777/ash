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
  /** 竖轨上的第几簇。相邻两格簇号不同，中间多留一段空（不画线）；不给就不分簇。 */
  cluster?: number;
  /**
   * 宽格：选中它时右栏按整块布局的比例算宽（默认一半，跟内容大约五五开），而不是平常那个像素宽。
   * 给要「看一整页」的格子用（共享浏览器）；比例单独记，拖它不改别的格子的宽度。
   */
  wide?: boolean;
  /**
   * 整块交给面板自己：它自带头带（名字、动作、关闭），自己撑满、自己滚动，宿主不再画那条
   * 「标题 + 叉」，也不替它套滚动。给本身就是一份完整查看器的格子用（文件查看）。
   */
  bare?: boolean;
  /**
   * 切到别的格、整栏收起时只藏起来、不卸载：里面是一份活的现场（预览指正嵌着的页面、标注通道、
   * 页面里没提交的输入），卸掉再挂回来就是重新打开一遍。只有它从竖轨上下去（或描述符不再要求
   * 保活）才真卸。
   */
  keepAlive?: boolean;
}

/** 「每当 key 变了，就切到 tabId 那一格」：格子由外面的状态决定该不该露面时用（见 InspectorHost 的 reveal）。 */
export interface InspectorReveal {
  tabId: string;
  /** 变一次切一次；0 / 空串不算（初始值）。 */
  key: number | string;
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
  focusOnEntry?: string;
  entryReady?: boolean;
  focusRequest?: { key: string; tabId: string };
}

export interface InspectorHostControls {
  visible: boolean;
  toggle: () => void;
  /** 切到 `id` 那一格（不在条上就加上去、整栏收着就展开）。`request` 是带给那一格的话，见 nav.tsx。 */
  openTab: (id: string, request?: Readonly<Record<string, unknown>>) => void;
  toggleButton: ReactNode;
}
