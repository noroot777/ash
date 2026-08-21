import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task, TaskFollowUp } from "@ash/shared";
import { api } from "../lib/api.ts";
import { orderedTopLevelTasks } from "./taskTreeModel.ts";

// 收起动画的时长，必须和 sidebar-spread.css 里 .workspace-sidebar 的 width 过渡对齐：
// 动画期间仍按铺开态排版，否则列会先「啪」地塌回去、侧边栏再慢慢滑窄，看着像闪了一下。
export const SPREAD_ANIM_MS = 260;

export type SpreadBucket = "todo" | "run" | "wait" | "done" | "accepted";
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

// 分堆的判据只问一句：这一行现在轮到谁动。轮到我 = todo（等答复 / 待验收 / 失败），
// 机器在动 = run，谁也没轮到 = wait，收了尾 = done，走完验收 = accepted。
//
// accepted 是唯一一档看 stage 而不看 status 的 —— stage 与 status 正交（见 shared 的
// TaskStage 注释），所以它只能**从 done 里切一刀**、不能跟别的桶并排，否则五个桶不再互斥，
// 计数加起来会超过「全部」。位置也是判据的一部分：
//   · 排在 run 之后 —— 「验收完成 + awaiting_review」（盖了章又派了审查）机器确实在动，
//     事实高于记号，这种得留在「在跑」，不能被 stage 抢走。
//   · 排在 done/wait 之前 —— team 没有 done 终态（收工只回到 idle，归档才结束），
//     验收完的调度台以前只能兜进 wait，让「排着 / 暂停」里堆着几十个其实早就干完的团队。
export function spreadBucket(task: Task): SpreadBucket {
  if (task.question) return "todo";
  if (task.status === "failed" || task.stage === "awaiting_acceptance" || task.stage === "verify_failed") return "todo";
  if (task.status === "running" || task.status === "queued" || task.status === "awaiting_review") return "run";
  if (task.stage === "accepted" || task.stage === "merged") return "accepted";
  if (task.status === "done" || task.status === "canceled") return "done";
  return "wait";
}

// 星标不是第六个桶：它是用户手动的软记号，与自动状态正交（同一个任务既可以
// 「在跑」也可以带星标）。所以筛选判据单独一条，不进 spreadBucket。
export function matchesSpreadFilter(task: Task, filter: SpreadFilter): boolean {
  if (filter === "all") return true;
  if (filter === "starred") return task.starredAt != null;
  return spreadBucket(task) === filter;
}

// 筛选按钮（铺开态的胶囊、窄态的点）共用同一份计数：口径分两处写，早晚会对不上。
// 口径 = 当前项目的顶层活任务，跟任务树里被筛的那批行是同一批。
export function spreadCounts(tasks: Task[], projectId: string | null): SpreadCounts {
  const counts: SpreadCounts = { all: 0, starred: 0, todo: 0, run: 0, wait: 0, done: 0, accepted: 0 };
  for (const task of tasks) {
    if (task.projectId !== projectId || task.archived || task.parentId) continue;
    counts.all += 1;
    if (task.starredAt != null) counts.starred += 1;
    counts[spreadBucket(task)] += 1;
  }
  return counts;
}

// J/K 快捷键遍历的「屏幕上可见的那份顶层列表」。筛选判据必须走 matchesSpreadFilter,
// 别在调用点自己拼 `spreadBucket(task) === filter` —— starred 不是桶,那样星标筛选下
// 快捷键会拿到空数组,按键被吞但选中不动。
export function spreadVisibleTasks(tasks: Task[], projectId: string | null, filter: SpreadFilter): Task[] {
  return orderedTopLevelTasks(
    tasks.filter((task) => task.projectId === projectId && !task.archived),
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
  // 已经问过后端的任务 —— 「问过但我没追问过」和「还没问后端」得分开说，
  // 否则别的项目那些没问过的行会被写成「还没追问过」，是在编。
  loaded: Set<string>;
  toggle: () => void;
  close: () => void;
};

// 铺开是**每次从收起开始**的临时视角，不写 localStorage：它是「让我扫一眼」的动作，
// 不是一种常驻布局；下次打开页面还停在铺开态的话，反而挡住了主区。
// 筛选同理不落盘 —— 它会把列表藏掉大半，刷新后还留着的话，下次打开只会当成「任务没了」。
export function useSidebarSpread(tasks: Task[], projectId: string | null, revision: number): SidebarSpread {
  const [open, setOpen] = useState(false);
  const [laidOut, setLaidOut] = useState(false);
  const [filter, setFilter] = useState<SpreadFilter>("all");
  const [followUps, setFollowUps] = useState<Map<string, TaskFollowUp>>(new Map());
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

  // 只问当前项目的活任务 —— 其他项目默认是折叠的，铺开时也看不到那些行。
  const idsKey = useMemo(
    () => tasks.filter((task) => task.projectId === projectId && !task.archived).map((task) => task.id).sort().join(","),
    [projectId, tasks],
  );

  useEffect(() => {
    if (!open || !idsKey) return;
    let alive = true;
    const ids = idsKey.split(",");
    api.followUps(ids)
      .then((rows) => {
        if (!alive) return;
        setFollowUps(new Map(rows.map((row) => [row.taskId, row])));
        setLoaded(new Set(ids));
      })
      // 读不到就让那一列留白。铺开是个扫一眼的动作，为它弹一条错误提示更吵。
      .catch(() => {});
    return () => { alive = false; };
  }, [idsKey, open, revision]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, laidOut: open || laidOut, filter, setFilter, followUps, loaded, toggle, close };
}
