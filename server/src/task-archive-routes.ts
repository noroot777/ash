// 归档/取消归档（从 task-run-routes.ts 拆出，纯行数拆分）。归档 = 冻结（archived 位，
// 不动 status），门禁与团队连带见各路由内注释。
import type { TaskStatus } from "@harness/shared";
import { canArchive } from "@harness/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { isRunning, isTurnClaimed } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { enrichTasks } from "./task-store.js";
import { haltTeam } from "./team/session.js";
import { now } from "./util.js";

export function mountTaskArchiveRoutes(api: Hono): void {
  // Archiving is orthogonal to status (a separate `archived` flag, not an 8th
  // status): a settled terminal task (done/failed/canceled) is frozen and tucked
  // away into the archive view. It does NOT go through setTaskStatus — the status
  // is preserved so unarchiving restores it. Both endpoints are idempotent (already
  // in the target state → just return the task) so a double-click never errors.
  api.post("/tasks/:id/archive", async (c) => {
    const r = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!r) return c.json({ error: "not found" }, 404);
    if (r.archived) return c.json((await enrichTasks([r]))[0]); // idempotent
    if (!canArchive(r.status as TaskStatus)) {
      return c.json({ error: "只有已完成/失败/已取消的任务可以归档", status: r.status }, 409);
    }
    // 归档 = 冻结。回合被占（status 尚未落 running）、自由审查正在进行、或验收正在执行时
    // 归档，会让一个「冻结」任务上继续跑回合/审查/合并写入——先等它结束或停掉再归档。
    if (isTurnClaimed(r.id)) {
      return c.json({ error: "任务回合正在进行（状态尚未落库），结束后再归档", status: r.status }, 409);
    }
    if (isAcceptingTask(r.id)) {
      return c.json({ error: "任务正在验收中，结束后再归档" }, 409);
    }
    if (r.workflowMode === "free" && await hasActiveFreeReview(r.id)) {
      return c.json({ error: "自由审查正在进行，结束后再归档" }, 409);
    }
    // 团队归档会连 children 一起冻结：任一执行者还在验收(含发布尾段)/回合中时归档，
    // 冻结的任务会继续产生外部副作用(审查实测:child beginAccepting 后归档 lead 200)。
    if (r.mode === "team") {
      const children = await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.parentId, r.id));
      const busy = children.find((child) => isAcceptingTask(child.id) || isTurnClaimed(child.id));
      if (busy) {
        return c.json({ error: `执行者「${busy.title}」正在验收或回合中，结束后再归档`, childId: busy.id }, 409);
      }
    }
    const ts = now();
    // 团队(§Team):归档才是「这件事结束了」—— 先停掉调度台进程和所有在跑的执行者,
    // 再把执行者一并归档(不管它们各自停在什么状态:团队没了,散在列表里的执行者只是
    // 噪音;取消归档时整支队伍一起回来)。
    if (r.mode === "team") {
      await haltTeam(r.id);
      const workers = await db.select().from(tasks).where(eq(tasks.parentId, r.id));
      for (const w of workers) {
        // 显示 running/queued 却没有活 handle/turn 的执行者(重启残留):没有进程可停,
        // stopTask 也不会替它落状态——直接归档会得到「archived=true + status=running」的
        // 失真组合(审查实测)。按 reconcileInterrupted 同一口径先落格再归档。
        if ((w.status === "running" || w.status === "queued") && !isRunning(w.id) && !isTurnClaimed(w.id)) {
          await setTaskStatus(w.id, (w.followUpFrom as TaskStatus | null) ?? "failed");
        }
        await db.update(tasks).set({ archived: true, archivedAt: ts, updatedAt: ts }).where(eq(tasks.id, w.id));
      }
    }
    await db.update(tasks).set({ archived: true, archivedAt: ts, updatedAt: ts }).where(eq(tasks.id, r.id));
    return c.json((await enrichTasks([(await db.select().from(tasks).where(eq(tasks.id, r.id))).at(0)!]))[0]);
  });

  api.post("/tasks/:id/unarchive", async (c) => {
    const r = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!r) return c.json({ error: "not found" }, 404);
    if (!r.archived) return c.json((await enrichTasks([r]))[0]); // idempotent
    const ts = now();
    await db.update(tasks).set({ archived: false, archivedAt: null, updatedAt: ts }).where(eq(tasks.id, r.id));
    // 对称:团队回来了,它的执行者也一起回来(归档时是整支队伍一起走的)
    if (r.mode === "team") {
      await db.update(tasks).set({ archived: false, archivedAt: null, updatedAt: ts }).where(eq(tasks.parentId, r.id));
    }
    return c.json((await enrichTasks([(await db.select().from(tasks).where(eq(tasks.id, r.id))).at(0)!]))[0]);
  });
}
