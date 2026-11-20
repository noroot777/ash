import { useRef, useState } from "react";
import type { TaskListItem } from "@navi/shared";
import { FunnelSimple, X } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { SidebarIconButton } from "./SidebarIconButton.tsx";
import { scopeHasFilters, type TaskScope } from "./taskScope.ts";
import {
  SPREAD_FILTERS,
  spreadCounts,
  type SidebarSpread,
  type SpreadCounts,
  type SpreadFilter,
} from "./useSidebarSpread.ts";

// 挑筛选的入口按屏幕分两种，由 WorkspaceSidebar 按 useNarrowScreen 二选一摆在工具行最左那一格：
//   · 宽屏：那一格是 F（铺开），铺开后带字带数的胶囊夹在工具行中间（SpreadFilterControls）；
//   · 手机：铺开没有意义，那一格换成一颗筛选键，点开是同样带字带数的一张菜单（FilterMenuButton）。
// 两种入口都由同一处 JS 判据挑，而不是让 CSS 单独把 F 藏掉 —— 那样会出现「筛选只能从
// 铺开态挑、铺开键却被藏了」的屏幕，项目明明支持筛选却一个入口都摸不到。
// 窄侧栏里不再放一排只靠颜色认的小点：每行行首那颗记号已经说了它在哪一档。
// 列表被筛过时由 FilterScopeLine 把这件事写出来，并给一个退回全部的口子。

// 点已选中的那一项 = 取消筛选。
function filterToggler(spread: SidebarSpread) {
  return (key: SpreadFilter) => spread.setFilter(spread.filter === key ? "all" : key);
}

// 铺开时才出现的一排筛选，夹在工具行左边三颗图标和右端「新建任务」之间 —— 不新起一行，
// 否则下面每一行都会跟着下移，「铺开前后逐像素不动」当场就破了。
function SpreadFilterBar({ spread, counts }: { spread: SidebarSpread; counts: SpreadCounts }) {
  const toggle = filterToggler(spread);
  return (
    <div className="workspace-spread-filters" role="group" aria-label="按状态筛选任务">
      {SPREAD_FILTERS.map((item) => (
        <button
          key={item.key}
          className={`workspace-spread-filter${spread.filter === item.key ? " is-on" : ""}${item.key === "todo" ? " is-todo" : ""}`}
          type="button"
          aria-pressed={spread.filter === item.key}
          onClick={() => toggle(item.key)}
        >
          <b>{item.label}</b>
          <span>{counts[item.key]}</span>
        </button>
      ))}
    </div>
  );
}

export function SpreadFilterControls({ spread, tasks, scope }: { spread: SidebarSpread; tasks: TaskListItem[]; scope: TaskScope }) {
  // 画不画由 scopeHasFilters 一处说了算（任务模式不画，理由在那儿）。useSidebarSpread 读的是
  // 同一条判据把筛选归一到「全部」—— 控件和生效值必须同源，否则会有筛过却没开关的列表。
  if (!spread.open || !scopeHasFilters(scope)) return null;
  return <SpreadFilterBar spread={spread} counts={spreadCounts(tasks, scope)} />;
}

// 手机上的筛选入口：一颗图标键加一张菜单，六档带字带数，当前那档底色加深。
export function FilterMenuButton({ spread, tasks, scope }: { spread: SidebarSpread; tasks: TaskListItem[]; scope: TaskScope }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useDismissable({ enabled: open, containerRef: root, onClose: () => setOpen(false) });
  if (!scopeHasFilters(scope)) return null;
  const counts = spreadCounts(tasks, scope);
  return (
    <span className="workspace-filter-menu-anchor" ref={root}>
      <SidebarIconButton label="按状态筛选" haspopup="menu" expanded={open} onClick={() => setOpen((value) => !value)}>
        <FunnelSimple size={15} weight={spread.filter === "all" ? "regular" : "fill"} aria-hidden="true" />
      </SidebarIconButton>
      {open && (
        <div className="ui-icon-menu workspace-filter-menu" role="menu" aria-label="按状态筛选任务">
          {SPREAD_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitemradio"
              aria-checked={spread.filter === item.key}
              className={item.key === "todo" ? "is-todo" : undefined}
              onClick={() => { setOpen(false); spread.setFilter(item.key); }}
            >
              <b>{item.label}</b>
              <span>{counts[item.key]}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// 「列表现在是筛过的」—— 只在筛选生效时出现，紧贴在任务树上方。它说的是列表的状态，
// 不是一个常驻控件：筛选是跨两态共享的（铺开里挑了一档再收起，窄态照样筛着），
// 窄态少了这一行，看到的就是「任务突然少了一半」而且没地方取消。
// 铺开态也照画：这一行在 F 前后都在原位，下面的行才不会因为铺开 / 收起而上下跳。
export function FilterScopeLine({ spread, tasks, scope }: { spread: SidebarSpread; tasks: TaskListItem[]; scope: TaskScope }) {
  const tip = useHoverTip();
  if (spread.filter === "all") return null;
  const item = SPREAD_FILTERS.find((entry) => entry.key === spread.filter);
  if (!item) return null;
  const count = spreadCounts(tasks, scope)[spread.filter];
  return (
    <div className={`workspace-filter-scope workspace-filter-scope--${item.key}`}>
      <i aria-hidden="true" />
      <span>只看 <b>{item.label}</b> · {count}</span>
      <button type="button" aria-label="取消筛选，看全部任务" {...tip.anchorProps} onClick={() => { tip.hide(); spread.setFilter("all"); }}>
        <X size={12} aria-hidden="true" />
      </button>
      <HoverTip at={tip.at}>看全部</HoverTip>
    </div>
  );
}
