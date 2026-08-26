import type { TaskListItem } from "@ash/shared";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import { inTaskMode } from "../lib/taskAttention.ts";

// 侧栏任务列表的**作用域**：只看当前项目一家，还是进「任务模式」。
//
// 任务模式不是「把所有项目摊开」—— 那样只是把同一堆行变多，看的人还得自己挑。它回答的
// 是另一个问题：**此刻全公司还没落地的活有哪些**，所以只留两类行 —— 机器在动的（在跑）
// 和干完了等我盖章的（待验收）。判据在 lib/taskAttention 的 inTaskMode。
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
export const TASK_MODE_SUMMARY = "所有项目里在跑和待验收的任务";

// 作用域筛过的那一份列表。任务模式下**执行者跟着自己的调度台走**：团队行要靠执行者
// 算摘要、展开子行，按顶层判据把它们一起筛掉的话，展开箭头会变成灰的、摘要空一片。
export function scopeTasks<T extends TaskListItem>(tasks: T[], scope: TaskScope): T[] {
  if (scope.kind === "project") return tasks.filter((task) => task.projectId === scope.projectId);
  const workersByLead = new Map<string, T[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const workers = workersByLead.get(task.parentId);
    if (workers) workers.push(task);
    else workersByLead.set(task.parentId, [task]);
  }
  const leads = new Set<string>();
  for (const task of tasks) {
    if (task.parentId) continue;
    if (inTaskMode(task, workersByLead.get(task.id) ?? [])) leads.add(task.id);
  }
  return tasks.filter((task) => leads.has(task.parentId ?? task.id));
}

// 筛选控件画不画。任务模式永远画（它天生有可筛的东西）；单项目态下只有一个项目都
// 没选中时才收起来 —— 选了项目就一直画着，哪怕它一个任务都没有：筛选是**生效中的状态**，
// 把入口藏起来会出现「列表被筛空了，却没地方取消」。
export function scopeHasTarget(scope: TaskScope): boolean {
  return scope.kind === "tasks" || scope.projectId !== null;
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
// 「任务模式」的按钮**，顶栏也写着「N 项在跑或待验收」——生效中的状态自己说得出口，
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
