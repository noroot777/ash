import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { tasks, queueItems, groups } from "./schema.js";
import { id as makeId, now } from "../util.js";

// 把 legacy 的 depends_on / resume_depends_on 数据迁到 queue_items 表。
// 由 ensureSchema 完成后调一次。详见 DESIGN-scheduling.md §8。
//
// 幂等：如果所有 task 的 legacy 字段都已经清空（[]），直接返回。
// 自检：DAG (depends_on 长度 > 1) / 跨 group / fresh-vs-resume 指向不同
//      任务 —— 全部 throw，让人工修复后再启动，绝不静默丢数据。
export async function migrateQueues(): Promise<void> {
  const allTasks = await db.select().from(tasks);

  // 1. 幂等：没 legacy 数据就直接 return
  const hasLegacy = allTasks.some(
    (t) =>
      (JSON.parse(t.dependsOn) as string[]).length > 0 ||
      (JSON.parse(t.resumeDependsOn) as string[]).length > 0,
  );
  if (!hasLegacy) return;

  console.log(`[queue migration] 检测到 legacy 依赖数据,开始迁移…`);

  // 2. 自检：先把所有错误收集起来一次性 throw，方便人工修
  const errors: string[] = [];
  const taskById = new Map(allTasks.map((t) => [t.id, t] as const));

  for (const t of allTasks) {
    const d = JSON.parse(t.dependsOn) as string[];
    const r = JSON.parse(t.resumeDependsOn) as string[];

    if (d.length > 1) {
      errors.push(`[DAG] task ${t.id} '${t.title}' depends_on=${JSON.stringify(d)} (本版本不支持多父依赖)`);
    }
    if (r.length > 1) {
      errors.push(`[DAG] task ${t.id} '${t.title}' resume_depends_on=${JSON.stringify(r)} (本版本不支持多父依赖)`);
    }
    if (d.length === 1 && r.length === 1 && d[0] !== r[0]) {
      errors.push(
        `[ambiguous] task ${t.id} '${t.title}' depends_on=${d[0]} ≠ resume_depends_on=${r[0]} (新模型一个任务只能有一个"前置")`,
      );
    }

    const deps = [...new Set([...d, ...r])];
    for (const depId of deps) {
      const dep = taskById.get(depId);
      if (!dep) continue; // dangling: 现状也容忍,跳过
      const tGid = t.groupId ?? "<no-group>";
      const dGid = dep.groupId ?? "<no-group>";
      if (tGid !== dGid) {
        errors.push(
          `[cross-group] ${t.id} '${t.title}' (group=${tGid}) → ${depId} '${dep.title}' (group=${dGid})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[queue migration] 检测到本版本不支持的依赖数据,请人工修复后重启:\n` +
        errors.map((e) => "  " + e).join("\n"),
    );
  }

  // 3. 加载 groups 用于决定哪些走 queue（serial）哪些跳过（parallel）
  const allGroups = await db.select().from(groups);

  // 收集"桶"：每个桶最后变成一个 queue
  // - 每个 serial group → 一个桶（含 group 里所有 task）
  // - null group_id 里的"连通分量"（用 deps 联通的）→ 一个桶
  type Bucket = { label: string; tasks: typeof allTasks };
  const buckets: Bucket[] = [];

  for (const g of allGroups) {
    if (g.mode !== "serial") continue; // parallel 跳过
    const tasksInGroup = allTasks.filter((t) => t.groupId === g.id);
    if (tasksInGroup.length === 0) continue;
    buckets.push({ label: `group ${g.id} (${g.name})`, tasks: tasksInGroup });
  }

  // null group_id 的连通分量
  const nullGroupTasks = allTasks.filter((t) => t.groupId === null);
  const nullGroupIdSet = new Set(nullGroupTasks.map((t) => t.id));
  const visited = new Set<string>();

  for (const seed of nullGroupTasks) {
    if (visited.has(seed.id)) continue;
    const component: typeof allTasks = [];
    const stack = [seed.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const t = taskById.get(id)!;
      component.push(t);
      // 前驱
      for (const did of [
        ...(JSON.parse(t.dependsOn) as string[]),
        ...(JSON.parse(t.resumeDependsOn) as string[]),
      ]) {
        if (nullGroupIdSet.has(did) && !visited.has(did)) stack.push(did);
      }
      // 后继：扫一遍找谁依赖我
      for (const other of nullGroupTasks) {
        const od = JSON.parse(other.dependsOn) as string[];
        const or = JSON.parse(other.resumeDependsOn) as string[];
        if (([...od, ...or]).includes(id) && !visited.has(other.id)) {
          stack.push(other.id);
        }
      }
    }
    // 只有真正有依赖关系的分量才需要 queue
    const componentHasDeps = component.some(
      (t) =>
        (JSON.parse(t.dependsOn) as string[]).length > 0 ||
        (JSON.parse(t.resumeDependsOn) as string[]).length > 0,
    );
    if (component.length >= 2 && componentHasDeps) {
      buckets.push({ label: `null-group component (seed=${seed.id})`, tasks: component });
    }
  }

  // 4. 每个桶里做 topo 排序（带 createdAt tiebreaker）并落 queue_items
  const ts = now();
  let totalQueues = 0;

  for (const bucket of buckets) {
    const bucketIdSet = new Set(bucket.tasks.map((t) => t.id));

    // 每个 task 最多一个 blocker（自检保证了非 DAG）
    const blockedBy = new Map<string, string | null>();
    for (const t of bucket.tasks) {
      const d = JSON.parse(t.dependsOn) as string[];
      const r = JSON.parse(t.resumeDependsOn) as string[];
      const prev = d[0] ?? r[0] ?? null;
      blockedBy.set(t.id, prev && bucketIdSet.has(prev) ? prev : null);
    }

    // children 邻接表 + 初始 in-degree
    const children = new Map<string, string[]>();
    for (const t of bucket.tasks) children.set(t.id, []);
    for (const [childId, parentId] of blockedBy) {
      if (parentId) children.get(parentId)!.push(childId);
    }
    const inDegree = new Map<string, number>();
    for (const t of bucket.tasks) {
      inDegree.set(t.id, blockedBy.get(t.id) ? 1 : 0);
    }

    const cmpCreated = (a: string, b: string) =>
      taskById.get(a)!.createdAt.localeCompare(taskById.get(b)!.createdAt);

    const ready: string[] = bucket.tasks
      .filter((t) => inDegree.get(t.id) === 0)
      .map((t) => t.id)
      .sort(cmpCreated);

    const sortedIds: string[] = [];
    while (ready.length) {
      const id = ready.shift()!;
      sortedIds.push(id);
      for (const childId of children.get(id) ?? []) {
        const nd = (inDegree.get(childId) ?? 0) - 1;
        inDegree.set(childId, nd);
        if (nd === 0) {
          ready.push(childId);
          ready.sort(cmpCreated);
        }
      }
    }

    if (sortedIds.length !== bucket.tasks.length) {
      throw new Error(
        `[queue migration] cycle detected in ${bucket.label}: 只排序出 ${sortedIds.length}/${bucket.tasks.length} 个 task`,
      );
    }

    const queueId = makeId();
    for (let i = 0; i < sortedIds.length; i++) {
      await db.insert(queueItems).values({
        taskId: sortedIds[i],
        queueId,
        position: i,
        createdAt: ts,
      });
    }
    totalQueues++;
    console.log(`[queue migration]   queue ${queueId} ← ${bucket.label}: ${sortedIds.length} 个 task`);
  }

  // 5. 清空所有 task 的 legacy 字段（schema 字段保留,只清值,SQLite 删列代价大）
  let cleared = 0;
  for (const t of allTasks) {
    const d = JSON.parse(t.dependsOn) as string[];
    const r = JSON.parse(t.resumeDependsOn) as string[];
    if (d.length > 0 || r.length > 0) {
      await db
        .update(tasks)
        .set({ dependsOn: "[]", resumeDependsOn: "[]" })
        .where(eq(tasks.id, t.id));
      cleared++;
    }
  }

  console.log(
    `[queue migration] 完成: ${totalQueues} 个 queue 创建, ${cleared} 个 task 的 legacy 字段已清空`,
  );
}
