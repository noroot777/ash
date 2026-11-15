import type { TaskListItem } from "@ash/shared";
import { byCreated, dispatchNeedsYou, dispatchSubtree } from "../lib/dispatchTree.ts";

// 侧栏里「派出去的任务收在派它的那条下面」这一层怎么排。
//
// **只在画出来的那批行之间收纳**：一条派出去的任务，只有派它的那条此刻也在这份列表里（同一个
// 作用域、同一个筛选、没归档），才收到它下面；派它的那条不在（归档了、被筛掉、在别的项目），
// 它就照常平铺 —— 不能跟着一起消失。所以森林总是在「已经筛好的行」上建，不在全量上建。
//
// 置顶的行不收：置顶是用户手动摁下去的「我要一直盯着这条」，收进别人底下就违背了它。
//
// 收进去之后，派它的那条在列表里的先后、过不过 24 小时年龄闸，都按**整棵**算：名下有一条刚动过、
// 刚摔了的，这一行就该在上面、看得见，而不是因为它自己旧就被折进「展开」里、连带名下一起藏起来。

export type DispatchForest<T extends TaskListItem = TaskListItem> = {
  /** 画在某一行下面的那几条（只含这份列表里在的）。 */
  children: Map<string, T[]>;
  /** 收进别人下面、不再单独成行的。 */
  nested: Set<string>;
  /** 收在谁下面（往上一层）。 */
  host: Map<string, string>;
};

export function buildDispatchForest<T extends TaskListItem>(rows: readonly T[]): DispatchForest<T> {
  const ids = new Set(rows.map((row) => row.id));
  const children = new Map<string, T[]>();
  const host = new Map<string, string>();
  for (const row of rows) {
    const by = row.dispatchedBy;
    if (!by || by === row.id || !ids.has(by) || row.pinnedAt != null || row.parentId) continue;
    host.set(row.id, by);
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

/** 名下整棵有没有要你处理的（在等答复、失败）。侧栏那个数据此变色。 */
export function forestNeedsYou(forest: Pick<DispatchForest, "children">, taskId: string): boolean {
  return dispatchSubtree(forest.children, taskId).some(dispatchNeedsYou);
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
