import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task } from "@harness/shared";
import {
  SPREAD_BUCKET_FILTERS,
  SPREAD_FILTERS,
  spreadCounts,
  type SidebarSpread,
  type SpreadCounts,
  type SpreadFilter,
} from "./useSidebarSpread.ts";

// 同一个筛选、两副长相：铺开态宽，摆得下带字带数的胶囊；窄态只剩顶部图标行那点空档，
// 摆一排点。两边读写的是同一个 spread.filter，所以在哪边选的，回到另一边还是它。

// 点已选中的那一项 = 取消筛选。窄态没有「全部」这颗点，不留这条路就只能靠按 F 进铺开态才能退回全集。
function filterToggler(spread: SidebarSpread) {
  return (key: SpreadFilter) => spread.setFilter(spread.filter === key ? "all" : key);
}

// 铺开时才出现的一排筛选。它占的是顶部图标那一行本来就空着的左半边 —— 不新起一行，
// 否则下面每一行都会跟着下移，「铺开前后逐像素不动」当场就破了。
export function SpreadFilterBar({ spread, counts }: { spread: SidebarSpread; counts: SpreadCounts }) {
  const toggle = filterToggler(spread);
  return (
    <div className="workspace-spread-filters">
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

function SpreadFilterDot({
  bucketKey,
  label,
  count,
  on,
  onToggle,
}: {
  bucketKey: string;
  label: string;
  count: number;
  on: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // 点太小，光靠颜色认不出是哪一档：指上去补一句状态名和条数。选中时还要说明再点一下能退回全集，
  // 否则窄态里看着像「列表突然少了一半」。
  const text = on ? `${label} · ${count}（再点看全部）` : `${label} · ${count}`;
  const showTip = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const edge = Math.min(120, window.innerWidth / 2);
    setTip({
      x: Math.min(Math.max(rect.left + rect.width / 2, edge), window.innerWidth - edge),
      y: rect.bottom + 4,
    });
  };
  const hideTip = () => setTip(null);
  return (
    <>
      <button
        ref={ref}
        className={`workspace-spread-dot workspace-spread-dot--${bucketKey}${on ? " is-on" : ""}${count ? "" : " is-empty"}`}
        type="button"
        aria-label={text}
        aria-pressed={on}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
        onClick={onToggle}
      >
        <i aria-hidden="true" />
      </button>
      {tip && createPortal(
        <span className="workspace-spread-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{text}</span>,
        document.body,
      )}
    </>
  );
}

// 窄态的那排点：顶部图标行的左半边，跟铺开态那排胶囊同一个起点；图标组仍在最右边不动。
// 一颗点 = 一档状态，选中即只看这一档。
export function SpreadFilterDots({ spread, counts }: { spread: SidebarSpread; counts: SpreadCounts }) {
  const toggle = filterToggler(spread);
  return (
    <div className="workspace-spread-dots" role="group" aria-label="按状态筛选任务">
      {SPREAD_BUCKET_FILTERS.map((item) => (
        <SpreadFilterDot
          key={item.key}
          bucketKey={item.key}
          label={item.label}
          count={counts[item.key]}
          on={spread.filter === item.key}
          onToggle={() => toggle(item.key)}
        />
      ))}
    </div>
  );
}

export function SpreadFilterControls({ spread, tasks, projectId }: { spread: SidebarSpread; tasks: Task[]; projectId: string | null }) {
  // 没选项目时没有可筛的东西。反过来，只要选了项目就一直画着 —— 哪怕这个项目一个任务都没有：
  // 筛选是**生效中的状态**，把入口藏起来会出现「列表被筛空了，却没地方取消」。
  if (!projectId) return null;
  const counts = spreadCounts(tasks, projectId);
  return spread.open
    ? <SpreadFilterBar spread={spread} counts={counts} />
    : <SpreadFilterDots spread={spread} counts={counts} />;
}
