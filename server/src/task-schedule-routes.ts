// 定时班次（§9，一个任务至多一条）与 worktree 分支上的提交列表（从 task-run-routes.ts
// 拆出，纯行数拆分）。两块都只读写自己的表，不碰回合所有权。
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { projects, schedules, sessions, tasks } from "./db/schema.js";
import { taskCommits } from "./git.js";
import { id, now } from "./util.js";

export function mountTaskScheduleRoutes(api: Hono): void {
// ── schedules (§9) — one schedule per task ──────────────────────────────────
api.get("/tasks/:id/schedule", async (c) => {
  const row = (await db.select().from(schedules).where(eq(schedules.taskId, c.req.param("id")))).at(0);
  return c.json(row ?? null);
});

api.put("/tasks/:id/schedule", async (c) => {
  const taskId = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (t?.archived) return c.json({ error: "任务已归档，不能设置定时", archived: true }, 409);
  const b = await c.req.json<{ kind: "once" | "cron"; at?: string | null; cron?: string | null; enabled?: boolean }>();
  const existing = (await db.select().from(schedules).where(eq(schedules.taskId, taskId))).at(0);
  const row = {
    id: existing?.id ?? id(),
    taskId,
    kind: b.kind,
    at: b.at ?? null,
    cron: b.cron ?? null,
    enabled: b.enabled ?? true,
    lastRunAt: null,
    createdAt: existing?.createdAt ?? now(),
  };
  if (existing) await db.update(schedules).set(row).where(eq(schedules.id, existing.id));
  else await db.insert(schedules).values(row);
  await db.update(tasks).set({ scheduleId: row.id, updatedAt: now() }).where(eq(tasks.id, taskId));
  return c.json(row);
});

api.delete("/tasks/:id/schedule", async (c) => {
  await db.delete(schedules).where(eq(schedules.taskId, c.req.param("id")));
  await db.update(tasks).set({ scheduleId: null, updatedAt: now() }).where(eq(tasks.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// Commits produced on a task's isolated worktree branch. Empty when the task ran
// in place (no worktree).
api.get("/tasks/:id/commits", async (c) => {
  const tid = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!t) return c.json({ error: "not found" }, 404);
  const project = (await db.select().from(projects).where(eq(projects.id, t.projectId))).at(0);
  const sess = (await db.select().from(sessions).where(eq(sessions.taskId, tid))).find((s) => s.worktreePath);
  if (!sess?.worktreePath || !project) return c.json({ branch: null, commits: [] });
  return c.json(await taskCommits(sess.worktreePath, project.repoPath, t.worktreeBase));
});
}
