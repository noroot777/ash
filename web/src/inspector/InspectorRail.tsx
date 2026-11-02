import { useRef, useState, type ReactNode } from "react";
import { Plus } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { Menu, MenuItem } from "../components/ui.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { useRovingChoice } from "../lib/useRovingChoice.ts";
import { inspectorShortcutLabel } from "./shortcuts.ts";
import type { InspectorShortcutKey } from "./shortcuts.ts";

// Inspector 的竖排图标条（VS Code 活动栏那种）：只画图标，指上去或键盘走到才报名字。
// 横排页签在 340px 宽的侧栏里最多塞得下三四个，再多就横向滚动、标题也被截成两个字；
// 竖着排每个面板都常驻可见，省下的那条 38px 高的横条全归内容。

/** 图标条只需要认领这几个字段；`render` 带着 Context 泛型，收进来会把整条链染上泛型。 */
export interface InspectorRailItem {
  id: string;
  title: string;
  icon: ReactNode;
  shortcut?: InspectorShortcutKey;
}

function tabLabel(item: InspectorRailItem) {
  return item.shortcut ? `${item.title}，快捷键 ${inspectorShortcutLabel(item.shortcut)}` : item.title;
}

function InspectorRailTab({
  item,
  active,
  tabId,
  contentId,
  tabProps,
  onSelect,
}: {
  item: InspectorRailItem;
  active: boolean;
  tabId: string;
  contentId: string;
  /** 方向键漫游那套 props(lib/useRovingChoice.ts),由图标条统一发下来。 */
  tabProps: Record<string, unknown>;
  onSelect: (id: string) => void;
}) {
  const tip = useHoverTip({ placement: "left" });
  return (
    <>
      <button
        id={tabId}
        type="button"
        {...tabProps}
        className={`inspector-rail__tab${active ? " is-active" : ""}`}
        aria-controls={contentId}
        aria-label={tabLabel(item)}
        {...tip.anchorProps}
        onClick={() => onSelect(item.id)}
      >
        <span className="inspector-rail__icon" aria-hidden="true">{item.icon}</span>
      </button>
      <HoverTip at={tip.at}>
        {item.title}
        {item.shortcut ? <kbd>{inspectorShortcutLabel(item.shortcut)}</kbd> : null}
      </HoverTip>
    </>
  );
}

export function InspectorRail({
  items,
  allItems,
  activeId,
  tabIdFor,
  contentIdFor,
  onSelect,
  onOpen,
}: {
  /** 已打开的面板，按描述符顺序。 */
  items: readonly InspectorRailItem[];
  /** 全部可用面板，进「+」菜单。 */
  allItems: readonly InspectorRailItem[];
  activeId: string | null;
  tabIdFor: (id: string) => string;
  contentIdFor: (id: string) => string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const addTip = useHoverTip({ placement: "left" });
  // 上下键漫游走公共那一份(lib/useRovingChoice.ts)。这里原本自带一套一模一样的
  // 实现,是全应用第四份拷贝 —— 契约只该有一个出处,否则补过的那几处好用、没补的
  // 照旧,而差别从代码上看不出来。
  const tabs = useRovingChoice(items.map((item) => item.id), activeId ?? "", onSelect, "tab");

  useDismissable({
    enabled: menuOpen,
    containerRef: menuRoot,
    onClose: () => setMenuOpen(false),
    restoreFocusRef: menuButton,
  });

  return (
    <nav className="inspector-host__rail" aria-label="Inspector 面板">
      <div
        {...tabs.groupProps}
        className="inspector-host__rail-tabs"
        aria-orientation="vertical"
        aria-label="已打开的 Inspector 面板"
      >
        {items.map((item) => (
          <InspectorRailTab
            key={item.id}
            item={item}
            active={item.id === activeId}
            tabId={tabIdFor(item.id)}
            contentId={contentIdFor(item.id)}
            tabProps={tabs.itemProps(item.id)}
            onSelect={onSelect}
          />
        ))}
      </div>
      <div className="inspector-host__add-root" ref={menuRoot}>
        <button
          ref={menuButton}
          type="button"
          className="inspector-host__add"
          aria-label="切换 Inspector 面板"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={allItems.length === 0}
          {...addTip.anchorProps}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus size={15} weight="bold" aria-hidden="true" />
        </button>
        <HoverTip at={menuOpen ? null : addTip.at}>
          {allItems.length > 0 ? "切换面板" : "没有可用面板"}
        </HoverTip>
        {menuOpen && (
          <Menu className="inspector-host__menu">
            {allItems.map((item) => (
              <MenuItem
                key={item.id}
                selected={item.id === activeId}
                shortcut={item.shortcut ? inspectorShortcutLabel(item.shortcut) : undefined}
                aria-label={tabLabel(item)}
                onClick={() => {
                  setMenuOpen(false);
                  onOpen(item.id);
                }}
              >
                <span className="inspector-host__menu-label">
                  <span className="inspector-host__menu-icon" aria-hidden="true">{item.icon}</span>
                  <span className="inspector-host__menu-title">{item.title}</span>
                </span>
              </MenuItem>
            ))}
          </Menu>
        )}
      </div>
    </nav>
  );
}
