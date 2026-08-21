import type { Task } from "@ash/shared";
import { readRenamedStorage } from "../lib/renamedStorage.ts";

// 侧栏任务列表的**作用域**：只看当前项目一家，还是把所有项目的任务混着看（「全部项目」）。
// 判据只有 inScope 这一处 —— 计数、筛选、J/K 遍历、铺开取数全从它来，分头写迟早对不上。
//
// 注意作用域只管**列表看哪些行**。「当前项目」这个概念不因此消失：新建任务、终端、
// git 胶囊仍旧绑在它身上，而它会跟着你选中的任务走（选了别的项目的任务，上下文项目
// 就换成那个），所以在全部项目态里点开一行再新建任务，落点不会跑偏。

export type TaskScope =
  | { kind: "project"; projectId: string | null }
  | { kind: "all" };

export type TaskScopeKind = TaskScope["kind"];

export const SCOPE_STORAGE_KEY = "ash:task-scope";
export const ALL_PROJECTS_LABEL = "全部项目";

export function inScope(task: Pick<Task, "projectId">, scope: TaskScope): boolean {
  return scope.kind === "all" || task.projectId === scope.projectId;
}

// 筛选控件画不画。「全部项目」永远画（它天生有可筛的东西）；单项目态下只有一个项目都
// 没选中时才收起来 —— 选了项目就一直画着，哪怕它一个任务都没有：筛选是**生效中的状态**，
// 把入口藏起来会出现「列表被筛空了，却没地方取消」。
export function scopeHasTarget(scope: TaskScope): boolean {
  return scope.kind === "all" || scope.projectId !== null;
}

function isScopeKind(value: unknown): value is TaskScopeKind {
  return value === "all" || value === "project";
}

// URL 是权威：带了 `scope=all` 就是全部项目态，带了 project/task 这类定位参数（分享出去
// 的深链）就是单项目态。两样都没有 —— 也就是干净地打开 `/` —— 才回落到上次用的那档。
// 作用域跟筛选不同，它是「看得更多」而不是「藏起一批」，落盘不会造成「任务怎么没了」。
export function resolveScopeKind(search: string, stored: TaskScopeKind | null): TaskScopeKind {
  const params = new URLSearchParams(search);
  const explicit = params.get("scope");
  if (isScopeKind(explicit)) return explicit;
  if (params.get("project") || params.get("task")) return "project";
  return stored ?? "project";
}

export function readStoredScopeKind(): TaskScopeKind | null {
  try {
    const raw = readRenamedStorage(SCOPE_STORAGE_KEY);
    return isScopeKind(raw) ? raw : null;
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
