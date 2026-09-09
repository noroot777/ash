import { useCallback, useState } from "react";
import { revealMore, revealMoreLabel, revealToIndex } from "./taskTreeModel.ts";

// 侧栏三处「展开(20/N)」共用的**分页展开**：主列表的年龄闸、团队行底下的执行者、
// 「其他项目」那一叠。三处从前各写一版「点一下全展开」，改一处就漏两处 —— 状态、
// 按钮和文案都收在这里，算法本体在 taskTreeModel（那儿有测试钉着）。
//
// 展开到一半时「收起」必须一直在：分页之后「全部展开」不再是必经的一站，
// 要是等展完最后一页才给收起的入口，中途想退回去就没有路。

export function useReveal(total: number) {
  const [revealed, setRevealed] = useState(0);
  const more = useCallback(() => setRevealed((current) => revealMore(current, total)), [total]);
  const collapse = useCallback(() => setRevealed(0), []);
  // 自动揭示（选中的行正好藏在隐藏区里）：只往多了放，不把用户已经翻开的收回去。
  const revealIndex = useCallback(
    (index: number) => setRevealed((current) => Math.max(current, revealToIndex(index, total))),
    [total],
  );
  return { revealed: Math.min(revealed, total), more, collapse, revealIndex };
}

// 同一个组件里有好几块列表各自展开（主列表按分节 / 项目分组切块）时的多份计数。
export function useKeyedReveal() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const revealedIn = useCallback((key: string) => counts[key] ?? 0, [counts]);
  const more = useCallback(
    (key: string, total: number) => setCounts((current) => ({ ...current, [key]: revealMore(current[key] ?? 0, total) })),
    [],
  );
  const collapse = useCallback(
    (key: string) => setCounts((current) => (current[key] ? { ...current, [key]: 0 } : current)),
    [],
  );
  const revealAtLeast = useCallback(
    (key: string, count: number) => setCounts((current) => ((current[key] ?? 0) >= count ? current : { ...current, [key]: count })),
    [],
  );
  return { revealedIn, more, collapse, revealAtLeast };
}

export function RevealMore({
  revealed,
  total,
  onMore,
  onCollapse,
}: {
  // 隐藏区里已经放出来的条数（0 = 一条没展开）。
  revealed: number;
  // 隐藏区一共多少条。
  total: number;
  onMore: () => void;
  onCollapse: () => void;
}) {
  if (total <= 0) return null;
  const shown = Math.min(Math.max(revealed, 0), total);
  const remaining = total - shown;
  return (
    <div className="workspace-task-more-row">
      {remaining > 0 && (
        <button className="workspace-task-more" type="button" onClick={onMore}>
          {revealMoreLabel(remaining)}
        </button>
      )}
      {shown > 0 && (
        <button className="workspace-task-more workspace-task-more--collapse" type="button" onClick={onCollapse}>
          收起
        </button>
      )}
    </div>
  );
}
