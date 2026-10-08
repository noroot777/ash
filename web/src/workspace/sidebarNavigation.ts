import { useCallback, useEffect } from "react";
import type { TaskListItem } from "@ash/shared";

// J/K（以及 ↑/↓）遍历的那份顺序**只认屏幕**：侧栏任务列表的 DOM 文档顺序。
//
// 从前它走的是另一条路 —— 把 spreadVisibleTasks 重算一遍（顶层活任务、更新时间倒序、
// 过一遍筛选）。那份数组跟屏幕上那份列表之间隔着一摞只活在组件里的状态，模型这一层
// 一条都看不见：
//   · 任务模式下「任务」那一节还要按项目再分一层（TaskTree 的 groupTasksByProject），
//     顺序整个变了 —— 这是「按一下 J 跳过好几行」最主要的来源；
//   · 24 小时年龄闸把旧行折进「展开(20/N)」，分页展开再决定放出几条；
//   · 团队行展开后底下多出来的那些执行者行；
//   · 项目分组、「其他机器」那一节的折叠；
//   · 下方「其他项目」那一叠的展开。
// 于是按一下 J 跳过三行，或者落到一个屏幕上根本没有的任务上 —— 看着就像选中丢了。
//
// 判据改成「按列表人眼可见的内容和顺序」（用户 2026-10-08 指定）之后，唯一不会漂的
// 来源就是 DOM 本身：折叠和年龄闸都是条件渲染，不在 DOM 里就是人眼看不见。以后新增
// 一类行，只要挂上 data-task-id 就自动进序列，不必再去模型那边补一份判据。

/** 侧栏任务列表的根（TaskTree 那个 nav）。主区、详情面里的东西一律不算。 */
const TREE_SELECTOR = ".workspace-task-tree";
/** 一行的身份。TaskRow 和「其他机器」那一节的远端行都挂着它。 */
const ROW_ATTR = "data-task-id";

function onScreen(row: HTMLElement): boolean {
  // 折叠和年龄闸都是条件渲染（压根不在 DOM 里），这里兜的是 CSS 隐藏那一档：
  // offsetParent 为 null = 它自己或某个祖先 display:none（侧栏的行都不是 position:fixed）。
  return row.offsetParent !== null;
}

/** 此刻屏幕上那份列表，按人眼从上往下的顺序。侧栏收起时是空的 —— 那时没有列表可言。 */
export function visibleSidebarTaskIds(root: ParentNode = document): string[] {
  const tree = root.querySelector(TREE_SELECTOR);
  if (!tree) return [];
  // 同一条任务在侧栏里只该出现一次（单项目态的主列表摘掉接力出去的行，任务模式不画
  // 「其他机器」那一节）；真撞上了只认头一处 —— 一个 id 占两个位置会让 J/K 原地打转。
  const ids = new Set<string>();
  for (const row of tree.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)) {
    const id = row.getAttribute(ROW_ATTR);
    if (id && onScreen(row)) ids.add(id);
  }
  return [...ids];
}

/**
 * 在一份顺序里挪一格。两端**夹紧**（到底了就停住，不绕回去）；当前这条不在这份顺序里
 * 时从头一条开始 —— 屏幕上看不见「我在哪」，就只能从头算。
 */
export function stepTaskId(ids: string[], currentId: string | null, step: 1 | -1): string | null {
  if (!ids.length) return null;
  const at = currentId ? ids.indexOf(currentId) : -1;
  if (at < 0) return ids[0] ?? null;
  return ids[Math.min(Math.max(at + step, 0), ids.length - 1)] ?? null;
}

export type SidebarNavigationOptions = {
  /** 全量任务：从屏幕上拿到的是 id，得还原成任务对象才交得给 onTask。 */
  tasks: TaskListItem[];
  /**
   * 侧栏**收起**时的退路顺序（通常是 spreadVisibleTasks）。那时屏幕上根本没有这份列表，
   * 「人眼可见的顺序」无从谈起，而把 J/K 一起关掉是功能退化 —— 所以退回模型顺序。
   */
  fallbackOrder: TaskListItem[];
  selectedTaskId: string | null;
  /**
   * 选中的是别的机器上那条时 selectedTaskId 为 null、身份落在这里。
   * 对这份列表来说两者是同一件事：「亮着的那一行」。
   */
  selectedRemoteTaskId: string | null;
  onTask: (task: TaskListItem) => void;
};

export function useSidebarTaskNavigation({
  tasks,
  fallbackOrder,
  selectedTaskId,
  selectedRemoteTaskId,
  onTask,
}: SidebarNavigationOptions): (step: 1 | -1) => void {
  const currentId = selectedTaskId ?? selectedRemoteTaskId;
  const navigate = useCallback((step: 1 | -1) => {
    const onScreenIds = visibleSidebarTaskIds();
    const nextId = onScreenIds.length
      ? stepTaskId(onScreenIds, currentId, step)
      : stepTaskId(fallbackOrder.map((task) => task.id), currentId, step);
    const next = nextId ? tasks.find((task) => task.id === nextId) : undefined;
    if (next) onTask(next);
  }, [currentId, fallbackOrder, onTask, tasks]);

  // 选中换到哪一行就把那一行带进视野。远端行也挂着 data-task-id，所以两类选中共用这条 ——
  // 从前它只认本机 taskId，于是在「其他机器」那一节里挪选中时列表自己不跟着滚。
  useEffect(() => {
    if (!currentId) return;
    document.querySelector(`${TREE_SELECTOR} [${ROW_ATTR}="${CSS.escape(currentId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  return navigate;
}
