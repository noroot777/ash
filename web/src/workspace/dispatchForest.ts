import type { TaskListItem } from "@ash/shared";
import { byCreated, dispatchSubtree } from "../lib/dispatchTree.ts";

export type DispatchForest<T extends TaskListItem = TaskListItem> = {
  children: Map<string, T[]>;
  /** 收进别人下面、不再单独成行的。 */
  nested: Set<string>;
  /** 收在谁下面（往上一层）。 */
  host: Map<string, string>;
};

export function buildDispatchForest<T extends TaskListItem>(rows: readonly T[], allTasks: readonly TaskListItem[] = rows): DispatchForest<T> {
  const ids = new Set(rows.map((row) => row.id));
  const byId = new Map(allTasks.map((row) => [row.id, row]));
  const children = new Map<string, T[]>();
  const host = new Map<string, string>();
  for (const row of rows) {
    if (row.parentId) continue;
    let by = row.dispatchedBy;
    const seen = new Set([row.id]);
    while (by && !seen.has(by)) {
      seen.add(by);
      if (ids.has(by)) { host.set(row.id, by); break; }
      const parent = byId.get(by);
      by = parent && !parent.parentId ? parent.dispatchedBy : null;
    }
  }
  const below = new Map<string, string[]>();
  for (const [child, parent] of host) {
    const bucket = below.get(parent);
    if (bucket) bucket.push(child);
    else below.set(parent, [child]);
  }
  // 脏数据成环（互相把对方记成派活人）时，环上每一条都够不着任何一行顶层 —— 收进去就一起
  // 看不见了。挑一条拆回顶层，环就解开了。
  const reached = new Set<string>();
  const visit = (id: string) => {
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      if (reached.has(next)) continue;
      reached.add(next);
      stack.push(...(below.get(next) ?? []));
    }
  };
  for (const row of rows) if (!host.has(row.id)) visit(row.id);
  for (const row of rows) {
    if (reached.has(row.id)) continue;
    host.delete(row.id);
    visit(row.id);
  }
  for (const row of rows) {
    const parent = host.get(row.id);
    if (!parent) continue;
    const bucket = children.get(parent);
    if (bucket) bucket.push(row);
    else children.set(parent, [row]);
  }
  for (const bucket of children.values()) bucket.sort(byCreated);
  return { children, nested: new Set(host.keys()), host };
}

/** 收在最顶上的那一条（自己就是顶层就是自己）。 */
export function forestRoot(forest: Pick<DispatchForest, "host">, taskId: string): string {
  let current = taskId;
  const seen = new Set<string>();
  while (forest.host.has(current) && !seen.has(current)) {
    seen.add(current);
    current = forest.host.get(current)!;
  }
  return current;
}

/** 整棵最近一次动静（ISO 串，同格式直接比大小）。 */
export function forestLatest(forest: Pick<DispatchForest, "children">, task: TaskListItem): string {
  return dispatchSubtree(forest.children, task.id).reduce(
    (latest, row) => (row.updatedAt > latest ? row.updatedAt : latest),
    task.updatedAt,
  );
}

/** 顶层那几行按整棵的最近动静排（置顶区另有先后，不经过这里）。 */
export function sortRootsByLatest<T extends TaskListItem>(forest: DispatchForest<T>, roots: readonly T[]): T[] {
  const latest = new Map(roots.map((row) => [row.id, forestLatest(forest, row)] as const));
  return [...roots].sort((a, b) => latest.get(b.id)!.localeCompare(latest.get(a.id)!));
}

/** 年龄闸的豁免扩到整棵：名下任何一条够新、或者自己该一直看得见，这一行就留着。 */
export function keepForestVisible(
  forest: Pick<DispatchForest, "children">,
  keepVisible: (task: TaskListItem) => boolean,
  maxAgeMs: number,
  nowMs: () => number = Date.now,
): (task: TaskListItem) => boolean {
  return (task) => {
    if (keepVisible(task)) return true;
    const cutoff = nowMs() - maxAgeMs;
    return dispatchSubtree(forest.children, task.id).some((row) => keepVisible(row) || Date.parse(row.updatedAt) >= cutoff);
  };
}
