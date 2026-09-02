import type { TaskListItem } from "@ash/shared";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import { indexWorkers, inTaskMode, workersFrom } from "../lib/taskAttention.ts";
import { visibleOnThisMachine } from "./taskTreeModel.ts";

// 侧栏任务列表的**作用域**：只看当前项目一家，还是进「任务模式」。
//
// 任务模式不是「把所有项目摊开」—— 那样只是把同一堆行变多，看的人还得自己挑。它回答的
// 是另一个问题：**此刻全公司还没落地的活有哪些**，所以只留四类行 —— 机器在动的（在跑）、
// 摔了的（跑挂 / 验证没过）、等我说句话的（提问 / 停在检查点）和停在验收关口上的（待验收）。
// 判据在 lib/taskAttention 的 inTaskMode。
//
// 判据只有 scopeTasks 这一处 —— 计数、筛选、J/K 遍历、铺开取数全从它来，分头写迟早对不上。
//
// 注意作用域只管**列表看哪些行**。「当前项目」这个概念不因此消失：新建任务、终端、
// git 胶囊仍旧绑在它身上，而它会跟着你选中的任务走（选了别的项目的任务，上下文项目
// 就换成那个），所以在任务模式里点开一行再新建任务，落点不会跑偏。

export type TaskScope =
  | { kind: "project"; projectId: string | null }
  | { kind: "tasks" };

export type TaskScopeKind = TaskScope["kind"];

export const SCOPE_STORAGE_KEY = "ash:task-scope";
// 注意别跟 Task["mode"]（单飞 / 团队 / 讨论）搞混：那个字段内部也叫 mode，但从不对用户
// 露出「模式」两个字（它显示成「任务 / 团队 / 讨论」）。这里的「任务模式」说的是侧栏作用域。
export const TASK_MODE_LABEL = "任务模式";
export const TASK_MODE_SUMMARY = "所有项目里在跑、失败、等你答复和待验收的任务";

// G T 在「任务模式」和「当前项目」之间来回切（go → tasks）。用两键连打而不是单键，是因为
// 这一档要在**任何界面**上都按得到（Inspector 的 `I …` 已经占了单键 i 的那种代价），
// 而单键预算得留给列表里高频的 j/k/f/c/r。
//
// 前缀 g 是 Inspector `I G` 的第二键，两条序列因此必须互相让路，判据写在
// useWorkspaceShortcuts 里（谁先跑、谁清谁的半截状态）。
export const TASK_MODE_CHORD_PREFIX = "g";
export const TASK_MODE_CHORD_KEY = "t";
export const TASK_MODE_SHORTCUT_LABEL = "G T";

export function isTaskModeChordKey(key: string): key is typeof TASK_MODE_CHORD_KEY {
  return key === TASK_MODE_CHORD_KEY;
}

// 作用域筛过的那一份列表。任务模式下**执行者跟着自己的调度台走**：团队行要靠执行者
// 算摘要、展开子行，按顶层判据把它们一起筛掉的话，展开箭头会变成灰的、摘要空一片。
export function scopeTasks<T extends TaskListItem>(tasks: T[], scope: TaskScope): T[] {
  if (scope.kind === "project") return tasks.filter((task) => task.projectId === scope.projectId);
  const workers = indexWorkers(tasks);
  const leads = new Set<string>();
  for (const task of tasks) {
    if (task.parentId) continue;
    if (inTaskMode(task, workersFrom(workers, task.id))) leads.add(task.id);
  }
  return tasks.filter((task) => leads.has(task.parentId ?? task.id));
}

// 「这一行本机看得见吗」。单项目态里接力出去的任务不进主列表 —— 它们在下方「其他机器」
// 那一节里按持有机分开列。任务模式反过来：它问的是「此刻还没落地的活」，活在哪台机器上
// 不是它关心的维度，所以出站行照收，状态由 useOutboundState 从持有机实时问回来。
export function visibleInScope(task: TaskListItem, scope: TaskScope): boolean {
  return scope.kind === "tasks" || visibleOnThisMachine(task);
}

// 这一档有没有状态筛选。
//
// **任务模式没有**（用户 2026-08-28 拍板）：它自己就是一次筛选 —— 收进来的行必定落在
// 在跑 / 需要你处理 / 排着·暂停 三档里（不变式由 test-spread-filter 钉着），所以那排点
// 里「已收尾」「验收完成」两颗永远是 0，剩下三颗是在一份本来就只剩二三十行的列表上
// 再切一刀。收窄它要付的代价（几颗认不出颜色的小点、以及「筛空了却看不出为什么」）
// 比省下的翻找多。
//
// 单项目态照旧画，只有一个项目都没选中时才收起来 —— 选了项目就一直画着，哪怕它一个
// 任务都没有：筛选是**生效中的状态**，把入口藏起来会出现「列表被筛空了，却没地方取消」。
//
// 反过来这也是硬约束：**画不出控件的作用域，筛选一律不生效**（useSidebarSpread 按这条
// 归一），否则在单项目态挑了「在跑」再切进任务模式，就是一份被悄悄筛过、还没有开关的列表。
export function scopeHasFilters(scope: TaskScope): boolean {
  return scope.kind === "project" && scope.projectId !== null;
}

// `all` 是这一档的旧名（那会儿它真的叫「全部项目」）。旧链接和旧落盘都还带着它，
// 读的时候一律归到 tasks；写出去的只有新名字。
function normalizeScopeKind(value: unknown): TaskScopeKind | null {
  if (value === "tasks" || value === "project") return value;
  return value === "all" ? "tasks" : null;
}

// URL 是权威：带了 `scope=tasks` 就是任务模式，带了 project/task 这类定位参数（分享出去
// 的深链）就是单项目态。两样都没有 —— 也就是干净地打开 `/` —— 才回落到上次用的那档。
//
// 作用域跟筛选不同，它落盘。筛选不落盘是因为它藏起一批行、入口又只是几颗小点，刷新后
// 留着就成了「任务怎么没了」；任务模式同样藏行，但它的开关是侧栏顶上那颗**一直写着
// 「任务模式」的按钮**，顶栏也写着「N 项还没落地」——生效中的状态自己说得出口，
// 就不构成那种失踪感。收起侧栏时那颗按钮换成清单图标，同一句话照样在。
export function resolveScopeKind(search: string, stored: TaskScopeKind | null): TaskScopeKind {
  const params = new URLSearchParams(search);
  const explicit = normalizeScopeKind(params.get("scope"));
  if (explicit) return explicit;
  if (params.get("project") || params.get("task")) return "project";
  // stored 也过一遍归一：落盘里可能还躺着旧名 `all`，不认它就等于「上次停在任务模式，
  // 这次打开却缩回单项目」。
  return normalizeScopeKind(stored) ?? "project";
}

export function readStoredScopeKind(): TaskScopeKind | null {
  try {
    return normalizeScopeKind(readRenamedStorage(SCOPE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredScopeKind(kind: TaskScopeKind): void {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, kind);
  } catch {
    // 存不下就只影响下次打开停在哪一档，本次仍然照常工作。
  }
}
