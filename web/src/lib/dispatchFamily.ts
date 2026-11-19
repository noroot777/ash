import type { TaskListItem } from "@navi/shared";
import { byCreated, dispatchEdges, dispatchSubtree } from "./dispatchTree.ts";
import { isAcceptedStage, indexWorkers, workersFrom } from "./taskAttention.ts";
import { dispatchedRollUp, dispatchedStateOf, taskLook } from "./taskLook.ts";

export function dispatchPath(task: TaskListItem, tasks: readonly TaskListItem[]): TaskListItem[] {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const path = [task];
  const seen = new Set([task.id]);
  let current = task;
  while (!current.parentId && current.dispatchedBy) {
    const parent = byId.get(current.dispatchedBy);
    if (!parent || seen.has(parent.id)) break;
    path.unshift(parent);
    seen.add(parent.id);
    current = parent;
  }
  return path;
}

export function dispatchBranch(root: TaskListItem, tasks: readonly TaskListItem[]) {
  const edges = dispatchEdges(tasks);
  const children = new Map<string, TaskListItem[]>();
  const visited = new Set([root.id]);
  const walk = (id: string, visibleParent: string) => {
    for (const child of [...(edges.get(id) ?? [])].sort(byCreated)) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (!child.archived) children.set(visibleParent, [...(children.get(visibleParent) ?? []), child]);
      walk(child.id, child.archived ? visibleParent : child.id);
    }
  };
  walk(root.id, root.id);
  return { root, children };
}

export function dispatchBranchAccepted(task: TaskListItem, children: ReadonlyMap<string, readonly TaskListItem[]>): boolean {
  return [task, ...dispatchSubtree(children, task.id)].every((item) => item.status !== "canceled" && isAcceptedStage(item) && taskLook(item).bucket === "accepted");
}

export function dispatchLevel(children: ReadonlyMap<string, readonly TaskListItem[]>, parentId: string, selectedId: string) {
  const rows = children.get(parentId) ?? [];
  const accepted = rows.filter((task) => dispatchBranchAccepted(task, children));
  const rest = rows.filter((task) => !dispatchBranchAccepted(task, children));
  const containsSelected = (task: TaskListItem) => task.id === selectedId || dispatchSubtree(children, task.id).some((child) => child.id === selectedId);
  const selectedInAccepted = accepted.some(containsSelected);
  return { accepted, rest, selectedInAccepted, containsSelection: rows.some(containsSelected), acceptedOpen: !rest.length || selectedInAccepted, branchOpen: rows.some((task) => !dispatchBranchAccepted(task, children) || containsSelected(task)) };
}

export function createDispatchView(tasks: readonly TaskListItem[]) {
  const workers = indexWorkers([...tasks]);
  const edges = dispatchEdges(tasks);
  const cached = new Map<string, TaskListItem[]>();
  const below = (taskId: string) => {
    if (!cached.has(taskId)) cached.set(taskId, dispatchSubtree(edges, taskId).filter((item) => !item.archived));
    return cached.get(taskId)!;
  };
  return {
    look: (task: TaskListItem) => taskLook(task, workersFrom(workers, task.id), false,
      dispatchedRollUp(below(task.id).map((item) => dispatchedStateOf(item, workersFrom(workers, item.id))))),
    matchesFilter: (task: TaskListItem, filter: string) => filter === "all" || [task, ...below(task.id)]
      .some((item) => taskLook(item, workersFrom(workers, item.id)).bucket === filter),
  };
}

export function dispatchLook(task: TaskListItem, tasks: readonly TaskListItem[]) {
  return createDispatchView(tasks).look(task);
}

export function dispatchMatchesFilter(task: TaskListItem, filter: string, tasks: readonly TaskListItem[]): boolean {
  return createDispatchView(tasks).matchesFilter(task, filter);
}
