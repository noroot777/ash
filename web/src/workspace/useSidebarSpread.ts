import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskFollowUp, TaskListItem } from "@ash/shared";
import { TASK_BATCH_LIMIT } from "@ash/shared";
import { api } from "../lib/api.ts";
import { spreadBucket, type SpreadBucket } from "../lib/taskAttention.ts";
import { inScope, type TaskScope } from "./taskScope.ts";
import { orderedTopLevelTasks, visibleOnThisMachine } from "./taskTreeModel.ts";

// 桶的判据搬到了 lib/taskAttention.ts（任务树排序和状态点也要读它，留在这里会成环）。
// 这里继续对外露出同一个名字，免得每个调用点都改 import。
export { spreadBucket };
export type { SpreadBucket };

// 收起动画的时长，必须和 sidebar-spread.css 里 .workspace-sidebar 的 width 过渡对齐：
// 动画期间仍按铺开态排版，否则列会先「啪」地塌回去、侧边栏再慢慢滑窄，看着像闪了一下。
export const SPREAD_ANIM_MS = 260;

export type SpreadFilter = "all" | "starred" | SpreadBucket;

export const SPREAD_FILTERS: { key: SpreadFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "starred", label: "星标" },
  { key: "todo", label: "需要你处理" },
  { key: "run", label: "在跑" },
  { key: "wait", label: "排着 / 暂停" },
  { key: "done", label: "已收尾" },
  { key: "accepted", label: "验收完成" },
];

// 窄态那排点：「全部」在点上表现为「一个都没选中」，不占一个点位；
// 星标不是状态桶（见 matchesSpreadFilter），画成星形而不是圆点。
export const SPREAD_DOT_FILTERS = SPREAD_FILTERS.filter(
  (item): item is { key: Exclude<SpreadFilter, "all">; label: string } => item.key !== "all",
);

export type SpreadCounts = Record<SpreadFilter, number>;

// 分堆的判据见 lib/taskAttention.ts 的 spreadBucket。

// 星标不是第六个桶：它是用户手动的软记号，与自动状态正交（同一个任务既可以
// 「在跑」也可以带星标）。所以筛选判据单独一条，不进 spreadBucket。
export function matchesSpreadFilter(task: TaskListItem, filter: SpreadFilter): boolean {
  if (filter === "all") return true;
  if (filter === "starred") return task.starredAt != null;
  return spreadBucket(task) === filter;
}

// 筛选按钮（铺开态的胶囊、窄态的点）共用同一份计数：口径分两处写，早晚会对不上。
// 口径 = **当前作用域**里的顶层活任务，跟任务树里被筛的那批行是同一批 —— 全部项目态
// 下这个口径自然扩到所有项目，不必另开一套计数。
export function spreadCounts(tasks: TaskListItem[], scope: TaskScope): SpreadCounts {
  const counts: SpreadCounts = { all: 0, starred: 0, todo: 0, run: 0, wait: 0, done: 0, accepted: 0 };
  for (const task of tasks) {
    if (!inScope(task, scope) || task.archived || task.parentId || !visibleOnThisMachine(task)) continue;
    counts.all += 1;
    if (task.starredAt != null) counts.starred += 1;
    counts[spreadBucket(task)] += 1;
  }
  return counts;
}

// J/K 快捷键遍历的「屏幕上可见的那份顶层列表」。筛选判据必须走 matchesSpreadFilter,
// 别在调用点自己拼 `spreadBucket(task) === filter` —— starred 不是桶,那样星标筛选下
// 快捷键会拿到空数组,按键被吞但选中不动。
export function spreadVisibleTasks(tasks: TaskListItem[], scope: TaskScope, filter: SpreadFilter): TaskListItem[] {
  return orderedTopLevelTasks(
    tasks.filter((task) => inScope(task, scope) && !task.archived),
    { unifiedPinned: true },
  ).filter((task) => matchesSpreadFilter(task, filter));
}

export type SidebarSpread = {
  open: boolean;
  // 铺开态的排版是否生效（open，或者收起动画还没跑完）。
  laidOut: boolean;
  // 筛选是**跨两态共享的一份状态**：铺开态那排胶囊和窄态那排点读写的是同一个值，
  // 所以在哪边选的，切到另一边还是它 —— 铺开里挑了「在跑」，收起后窄态那颗点也亮着。
  filter: SpreadFilter;
  setFilter: (filter: SpreadFilter) => void;
  followUps: Map<string, TaskFollowUp>;
  // 「原始需求」列的正文。列表接口不带正文，铺开时才按需批量取（见 api.taskBodies）。
  bodies: Map<string, string>;
  // 已经问过后端的任务 —— 「问过但我没追问过」和「还没问后端」得分开说，
  // 否则别的项目那些没问过的行会被写成「还没追问过」，是在编。
  loaded: Set<string>;
  toggle: () => void;
  close: () => void;
};

// 铺开是**每次从收起开始**的临时视角，不写 localStorage：它是「让我扫一眼」的动作，
// 不是一种常驻布局；下次打开页面还停在铺开态的话，反而挡住了主区。
// 筛选同理不落盘 —— 它会把列表藏掉大半，刷新后还留着的话，下次打开只会当成「任务没了」。
export function useSidebarSpread(tasks: TaskListItem[], scope: TaskScope, revision: number): SidebarSpread {
  const [open, setOpen] = useState(false);
  const [laidOut, setLaidOut] = useState(false);
  const [filter, setFilter] = useState<SpreadFilter>("all");
  const [followUps, setFollowUps] = useState<Map<string, TaskFollowUp>>(new Map());
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
      setLaidOut(true);
      return;
    }
    if (!laidOut) return;
    closeTimer.current = window.setTimeout(() => setLaidOut(false), SPREAD_ANIM_MS);
    return () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); };
  }, [laidOut, open]);

  // 只问作用域里的活任务 —— 单项目态下别的项目默认是折叠的，铺开时也看不到那些行；
  // 全部项目态下它们就在屏幕上，那三格得跟着有内容。
  //
  // **按最近更新排在前**：下面是分批取的，谁在前谁先填上，而任务树也是这个顺序 ——
  // 用户先看到的那几屏最先有内容。按 id 排（曾经的写法）等于随机决定谁先亮。
  const orderedIds = useMemo(
    () => tasks
      .filter((task) => inScope(task, scope) && !task.archived && visibleOnThisMachine(task))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((task) => task.id),
    [scope, tasks],
  );
  // effect 的身份看的是**这批 id 是哪些**，不是它们的顺序 —— 否则任何一个任务的
  // updatedAt 一动（跑起来的任务每秒都在动）就重排、重取一遍。
  const idsKey = useMemo(() => [...orderedIds].sort().join(","), [orderedIds]);
  const orderedRef = useRef(orderedIds);
  orderedRef.current = orderedIds;

  useEffect(() => {
    if (!open || !idsKey) return;
    let alive = true;
    const ids = orderedRef.current;
    // 追问那一列**只问头一批**：每条都要摸一次盘，一千多个任务全问一遍就是把铺开
    // 这个「扫一眼」的动作变成一次全盘扫描。`loaded` 只记真问过的那批，剩下的行显示
    // 「还没读到」而不是「还没追问过」—— 后者是在编。
    const asked = ids.slice(0, TASK_BATCH_LIMIT);
    setLoaded(new Set());
    api.followUps(asked)
      .then((rows) => {
        if (!alive) return;
        setFollowUps(new Map(rows.map((row) => [row.taskId, row])));
        setLoaded(new Set(asked));
      })
      // 读不到就让那一列留白。铺开是个扫一眼的动作，为它弹一条错误提示更吵。
      .catch(() => {});
    // 正文与追问各走各的（一个查库、一个摸盘），谁先回来谁先填上，互不拖累。
    //
    // 正文**分批取完整批**：它只是一次按主键的查询，不摸盘，所以没有理由让第
    // TASK_BATCH_LIMIT 行之后的任务永远显示「还没读到」。一批填一次，边到边显示。
    setBodies(new Map());
    void (async () => {
      for (let at = 0; at < ids.length; at += TASK_BATCH_LIMIT) {
        const rows = await api.taskBodies(ids.slice(at, at + TASK_BATCH_LIMIT)).catch(() => []);
        if (!alive) return;
        if (!rows.length) continue;
        setBodies((current) => {
          const next = new Map(current);
          for (const row of rows) next.set(row.taskId, row.body);
          return next;
        });
      }
    })();
    return () => { alive = false; };
  }, [idsKey, open, revision]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, laidOut: open || laidOut, filter, setFilter, followUps, bodies, loaded, toggle, close };
}
