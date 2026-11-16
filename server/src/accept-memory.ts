// 验收确认层点确认时记下的那一勾：「提交」。
//
// 只有一条写：确认层里点了确认就送一次，送的就是那一刻层里看见的样子。
//
//  · 「提交」那一勾**就是项目设置**（projects.accept_commit），不另存一份默认，不然确认层和
//    设置页会各说各的。所以它要项目管理权限：没有就不写、回执里说 commitSaved:false，这一次的
//    提交与否照样按层里看见的值发给 /accept（那条不读这里）。
//  · 按到达顺序写：后到的确认算数，晚做完的旧确认盖不掉它（accept-order.ts）。
//  · 「运行前置命令」那一勾**不记**：跳过只管当次，下一次打开确认层默认还是跑（用户 2026-11-16 ——
//    记住的那几天里取消过一次就次次默认跳过，门禁等于没设）。所以这里不收它，门禁状态里也不带它。
import type { Hono } from "hono";
import type { AcceptMemoryWriteResult } from "@ash/shared/accept-gate";
import { eq } from "drizzle-orm";
import { arrivalSeq, writeAcceptCommit } from "./accept-order.js";
import { actorOf, authErrorResponse } from "./auth/context.js";
import { projectRoleOf, requireProjectAccess } from "./auth/visibility.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";

export function mountAcceptMemoryRoutes(api: Hono): void {
  api.put("/accept-memory/:projectId", async (c) => {
    // 一到就取号，后到的确认算数（accept-order.ts）。
    const seq = arrivalSeq();
    const pid = c.req.param("projectId");
    const actor = actorOf(c);
    const project = (await db.select().from(projects).where(eq(projects.id, pid))).at(0);
    if (!project) return c.json({ error: "not found" }, 404);
    try {
      await requireProjectAccess(actor, pid);
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
    const raw = await c.req.json<unknown>().catch(() => null);
    const commit = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { commit?: unknown }).commit : undefined;
    // 只认真正的布尔：含糊的真值在这儿就是替人改项目设置。
    if (typeof commit !== "boolean") return c.json({ error: "commit 只能是布尔值" }, 400);
    const commitSaved = (await projectRoleOf(actor, pid)) === "admin";
    // 号和值在同一笔事务里读写（accept-order.ts）。回执报写完之后库里的样子（被更新的那次确认挡住时就是它的选择）。
    const { changed, result } = await db.transaction(async (tx) => {
      const changed = commitSaved ? (await writeAcceptCommit(tx, pid, commit, seq))?.changed === true : false;
      const current = (await tx.select({ acceptCommit: projects.acceptCommit }).from(projects).where(eq(projects.id, pid))).at(0);
      const result: AcceptMemoryWriteResult = { commit: current?.acceptCommit !== false, commitSaved };
      return { changed, result };
    });
    if (changed) bus.publish({ type: "project.updated", projectId: pid });
    return c.json(result);
  });
}
