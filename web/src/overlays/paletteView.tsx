// ⌘K 面板的两件视图层小事：选中项跟着键盘走进视线，以及排序档的记忆与开关。
// 都跟面板的业务逻辑无关，拆出来是为了让 CommandPalette.tsx 只讲「列表里有什么」。
import { useCallback, useEffect, useState, type RefObject } from "react";
import { ArrowsDownUp } from "@phosphor-icons/react";
import { isSearchSort, type SearchSort } from "@ash/shared/search";

const SORT_STORAGE_KEY = "ash:palette:sort";

export const SEARCH_SORT_LABEL: Record<SearchSort, string> = {
  relevance: "相关度",
  recent: "最近更新",
};

/**
 * 键盘上下移动时，把选中那行拖回视线里。
 *
 * 列表能有 50 条命中加一整片命令，选中态只是行背景变个色 —— 一旦它滚出视口，用户按着
 * ↓ 就完全不知道现在选中的是谁，回车更是在开盲盒。
 *
 * `block: "nearest"` 是关键：已经看得见的行一动不动，只有越出上下边界时才挪最小的距离。
 * 换成 `center` 之类，每按一下方向键整个列表都会跳一大截。
 */
export function usePaletteActiveScroll(
  container: RefObject<HTMLElement | null>,
  active: number,
  // 换步骤（搜索 / 选项目 / Git）时列表整个换了一批行，同一个 active 指向的是另一行。
  step: string,
) {
  useEffect(() => {
    const row = container.current?.querySelector(`[data-palette-index="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
    // 只跟 active 和 step 走：流式命中每 60ms 插一批，跟着它滚就会在用户用滚轮往下翻的
    // 时候把他拽回选中行。
  }, [active, container, step]);
}

/**
 * 排序档的记忆。一个人要么按相关度找、要么按时间翻，不该每次开 ⌘K 都重挑一次。
 */
export function useSearchSort(): [SearchSort, (sort: SearchSort) => void] {
  const [sort, setSort] = useState<SearchSort>(() => {
    // 存储被禁时 getItem 本身就会抛（隐私模式 / 站点数据被关）。记不住是小事，
    // 把整个 ⌘K 打不开是大事。
    try {
      const saved = window.localStorage.getItem(SORT_STORAGE_KEY) ?? "";
      return isSearchSort(saved) ? saved : "relevance";
    } catch {
      return "relevance";
    }
  });
  const choose = useCallback((next: SearchSort) => {
    setSort(next);
    try { window.localStorage.setItem(SORT_STORAGE_KEY, next); } catch { /* 存不下就只在本轮生效 */ }
  }, []);
  return [sort, choose];
}

export function SearchSortToggle({ sort, onToggle }: { sort: SearchSort; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="palette-sort"
      // 焦点必须留在输入框里：点完这个按钮还要能继续打字、继续按上下键。
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      <ArrowsDownUp size={11} />
      排序 · {SEARCH_SORT_LABEL[sort]}
    </button>
  );
}
