import { useCallback, useEffect, useRef } from "react";
import type { TaskListItem } from "@ash/shared";
import { inputCount } from "../lib/latestInteraction.ts";

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

/**
 * 此刻屏幕上那份列表。
 *
 * **「一行都没有」和「整栏不在屏幕上」必须分开说**（审查第 1 轮抓到把两者混成一个
 * 空数组的后果）：侧栏还开着、只是所有项目分组都被收起时，可导航的行就是零行 ——
 * 那时 J/K 该什么都不做；把它当成「没有列表可言」退回模型顺序，就会打开一个在列表里
 * 根本找不到的任务。
 */
export type SidebarRowOrder =
  | { kind: "screen"; ids: string[] }
  | { kind: "offscreen" };

export function sidebarRowOrder(root: ParentNode = document): SidebarRowOrder {
  const tree = root.querySelector(TREE_SELECTOR);
  if (!tree) return { kind: "offscreen" };
  // 同一条任务在侧栏里只该出现一次（单项目态的主列表摘掉接力出去的行，任务模式不画
  // 「其他机器」那一节）；真撞上了只认头一处 —— 一个 id 占两个位置会让 J/K 原地打转。
  const ids = new Set<string>();
  for (const row of tree.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)) {
    const id = row.getAttribute(ROW_ATTR);
    if (id && onScreen(row)) ids.add(id);
  }
  return { kind: "screen", ids: [...ids] };
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
   * 侧栏**整栏收起**时的退路顺序（通常是 spreadVisibleTasks）。那时屏幕上根本没有这份
   * 列表，「人眼可见的顺序」无从谈起，而把 J/K 一起关掉是功能退化 —— 所以退回模型顺序。
   *
   * 注意这条退路**只管整栏不在屏幕上**那一种。侧栏还开着、只是一行可见的都没有（所有
   * 项目分组都收起了）时一律不动选中，见 sidebarRowOrder。
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
  // 连着按 J/K 时「我按到哪儿了」。
  //
  // **导航的位置和详情的打开是两件事**：别的机器上那种行要先问一次持有机才打得开（异步），
  // 这段时间里选中还停在原处 —— 只认选中的话，第二下 J/K 会从同一个起点再算一遍，于是
  // 连按两下只挪一行（审查第 2 轮抓到：两下 K 只到紧挨着的那条，到不了再上面那条）。
  // 所以位置当场就挪，打开照旧异步，迟到应答那道闸仍在 openOutboundTask 那边。
  //
  // 光标只在**连着按**时算数：上一次导航之后用户的下一次输入就是这一下，它才续得上。
  // 中间点了一下别的、按了别的键，它就作废、退回选中那一行 —— 那时他已经不是在接着
  // 刚才那串 J/K 往下走了。（判据见 lib/latestInteraction：数的是用户的输入。）
  const cursor = useRef<{ id: string; input: number } | null>(null);
  const navigate = useCallback((step: 1 | -1) => {
    const input = inputCount();
    const order = sidebarRowOrder();
    // 侧栏在屏幕上时**只认它**，哪怕它此刻一行都没有 —— 那时 stepTaskId 返回 null，
    // 选中原样不动（全部折叠起来却打开一个找不到的任务，就是审查第 1 轮那条）。
    const ids = order.kind === "screen" ? order.ids : fallbackOrder.map((task) => task.id);
    const chained = cursor.current?.input === input - 1 ? cursor.current.id : null;
    // 光标指的那一行要是已经不在屏幕上了（列表刷新、它所在的组被折叠），就退回选中那行重算。
    const from = chained && ids.includes(chained) ? chained : currentId;
    const nextId = stepTaskId(ids, from, step);
    if (!nextId) { cursor.current = null; return; }
    cursor.current = { id: nextId, input };
    const next = tasks.find((task) => task.id === nextId);
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
