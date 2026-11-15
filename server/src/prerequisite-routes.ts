// 前置的加减接口：`POST /tasks/:id/prerequisites` 加（一条或几条），`DELETE /tasks/:id/prerequisites/:prerequisiteId` 去。
// 校验住在 prerequisite-store.ts，这里只做可见性、落库之后的通知。
//
// 去掉一条前置之后剩下的都站稳了、而它又挂着「等齐就起」的，当场就起（「不能出现永远在等、又没有任何
// 地方能放开」的任务：用户随时能去掉卡住它的那一条）。
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf } from "./auth/context.js";
import { visibleTaskIds } from "./auth/visibility.js";
import {
  assertPrerequisiteEdges, insertPrerequisiteEdges, PrerequisiteError, removePrerequisiteEdge, withPrerequisiteGraph, type PrerequisiteEdge,
} from "./prerequisite-store.js";
import { notePrerequisiteProgress } from "./prerequisite-launch.js";
import { withPrerequisiteLock } from "./prerequisite-gate.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { publishTaskUpdated } from "./task-store.js";

/**
 * 批量建任务时逐条写的前置换成边：先按同一批里的 `key` 认，认不出的当已有任务的 id；`stack` 再给每一条
 * 加上「建在上一条上」。返回字符串 = 写错了（key 重复）。已有任务的可见性由调用方核。
 */
export function batchPrerequisiteEdges(
  specs: { key?: string; prerequisites?: string[] }[], ids: string[], stack = false,
): { edges: PrerequisiteEdge[]; existing: string[] } | string {
  const byKey = new Map<string, string>();
  for (const [index, spec] of specs.entries()) {
    if (spec.prerequisites !== undefined && !stringList(spec.prerequisites)) return `tasks[${index}].prerequisites 要是字符串数组`;
    if (!spec.key) continue;
    if (byKey.has(spec.key)) return `tasks[${index}].key「${spec.key}」跟前面的重复了`;
    byKey.set(spec.key, ids[index]!);
  }
  const edges: PrerequisiteEdge[] = [];
  const existing = new Set<string>();
  for (const [index, spec] of specs.entries()) {
    const refs = [...(spec.prerequisites ?? []), ...(stack && index > 0 ? [ids[index - 1]!] : [])];
    for (const ref of new Set(refs)) {
      const prerequisiteId = byKey.get(ref) ?? ref;
      if (!ids.includes(prerequisiteId)) existing.add(prerequisiteId);
      if (!edges.some((edge) => edge.taskId === ids[index] && edge.prerequisiteId === prerequisiteId)) {
        edges.push({ taskId: ids[index]!, prerequisiteId });
      }
    }
  }
  return { edges, existing: [...existing] };
}

/** 请求体里的前置清单：字符串数组才收，别的形状回 null（调用方回 400）。 */
export function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

export const prerequisiteRefusal = (error: unknown) => error instanceof PrerequisiteError
  ? { body: { error: error.message }, status: error.status }
  : null;
const failed = prerequisiteRefusal;

export function mountPrerequisiteRoutes(api: Hono): void {
  api.post("/tasks/:id/prerequisites", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<{ prerequisiteId?: unknown; prerequisiteIds?: unknown }>().catch(() => ({} as never));
    const list = body.prerequisiteIds === undefined ? [] : stringList(body.prerequisiteIds);
    if (!list || (body.prerequisiteId !== undefined && typeof body.prerequisiteId !== "string")) {
      return c.json({ error: "prerequisiteId 要是字符串，prerequisiteIds 要是字符串数组" }, 400);
    }
    const ids = [...new Set([...list, ...(body.prerequisiteId ? [body.prerequisiteId as string] : [])])].filter(Boolean);
    if (!ids.length) return c.json({ error: "要给出 prerequisiteId 或 prerequisiteIds" }, 400);
    const visible = new Set(await visibleTaskIds(actorOf(c), ids));
    const hidden = ids.find((id) => !visible.has(id));
    if (hidden) return c.json({ error: `前置任务 ${hidden} 不存在` }, 404);
    try {
      // 跟开工判定同一把锁：判定读完边、还没落定起点时加进来的边，会落到那次起点之外（prerequisite-gate.ts）。
      // 判环与落边在整张图上排队（prerequisite-store.ts `withPrerequisiteGraph`）。
      await withPrerequisiteLock(taskId, () => withPrerequisiteGraph(async () => {
        const edges = ids.map((prerequisiteId) => ({ taskId, prerequisiteId }));
        await assertPrerequisiteEdges(edges);
        await insertPrerequisiteEdges(edges);
      }));
    } catch (error) {
      const refused = failed(error);
      if (refused) return c.json(refused.body, refused.status);
      throw error;
    }
    await republishPrerequisiteView([taskId, ...ids]);
    return c.json(await publishTaskUpdated(taskId));
  });

  api.delete("/tasks/:id/prerequisites/:prerequisiteId", async (c) => {
    const taskId = c.req.param("id");
    const prerequisiteId = c.req.param("prerequisiteId");
    if (!(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length) return c.json({ error: "not found" }, 404);
    try {
      await withPrerequisiteLock(taskId, () => removePrerequisiteEdge(taskId, prerequisiteId));
    } catch (error) {
      const refused = failed(error);
      if (refused) return c.json(refused.body, refused.status);
      throw error;
    }
    await republishPrerequisiteView([taskId, prerequisiteId]);
    notePrerequisiteProgress(prerequisiteId, [taskId]);
    return c.json(await publishTaskUpdated(taskId));
  });
}
