import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { removeTmpStage } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-archived-source-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, queueItems } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountTaskArchiveRoutes } = await import("../src/task-archive-routes.js");
const { createTasks } = await import("../src/task-store.js");
const { beginFreezing, isAdmitting } = await import("../src/acceptance-lock.js");
const { TeamAcceptingError } = await import("../src/team-admission.js");
const { withRepoLock } = await import("../src/repo-lock.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
mountTaskArchiveRoutes(api);
const at = new Date().toISOString();
const row = (id: string, originTaskId: string | null = null) => ({
  id, originTaskId, projectId: "project", title: id, body: "", mode: "single" as const,
  status: "backlog" as const, useWorktree: false, dispatchedBy: null, createdAt: at, updatedAt: at,
});
const request = (body: Record<string, unknown>) => api.request("/tasks", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ projectId: "project", mode: "single", useWorktree: false, title: "落实结论", ...body }),
});
const counts = async () => ({
  tasks: (await db.select().from(tasks)).length,
  sessions: (await db.select().from(sessions)).length,
  queue: (await db.select().from(queueItems)).length,
});
try {
  await db.insert(projects).values({ id: "project", name: "归档来源隔离验证", repoPath: root, createdAt: at });
  await db.insert(tasks).values({ ...row("source"), mode: "duet", status: "awaiting_review", archived: true });
  const before = await counts();
  for (const mode of ["single", "duet", "team"] as const) {
    for (const status of ["backlog", "paused", "awaiting_review", "idle", "done", "failed", "canceled"] as const) {
      await db.update(tasks).set({ mode, status }).where(eq(tasks.id, "source"));
      for (const dispatchedBy of [undefined, null, ""]) {
        const response = await request({ originTaskId: "source", dispatchedBy });
        assert.equal(response.status, 409, `${mode}/${status}: archived sources cannot create work`);
        assert.match((await response.json() as { error: string }).error, /归档/);
        assert.deepEqual(await counts(), before, "rejected handoff leaves no task, session or queue entry");
      }
    }
  }
  await assert.rejects(createTasks([row("batch-first"), row("batch-derived", "source")]), TeamAcceptingError);
  assert.deepEqual(await counts(), before, "a mixed batch is rejected atomically");
  await db.update(tasks).set({ archived: false, mode: "duet", status: "awaiting_review" }).where(eq(tasks.id, "source"));
  const frozen = beginFreezing(["source"]);
  assert.ok(frozen);
  try {
    assert.equal((await request({ originTaskId: "source" })).status, 409, "in-flight archive blocks creation");
  } finally { frozen(); }
  assert.equal(isAdmitting("source"), false, "failed admission releases its locks");
  const [created] = await createTasks([row("while-joining", "source")], undefined, async () => {
    assert.equal(beginFreezing(["source"]), null, "archive cannot interleave with insertion");
    const response = await api.request("/tasks/source/archive", { method: "POST" });
    assert.equal(response.status, 409, "archive route observes source admission");
  });
  assert.equal(created.originTaskId, "source");
  assert.equal(isAdmitting("source"), false, "successful creation releases source admission");
  const reacquired = beginFreezing(["source"]);
  assert.ok(reacquired, "archive can acquire the source after insertion");
  reacquired();
  let raced: Promise<void> | undefined;
  await withRepoLock(root, async () => {
    raced = assert.rejects(createTasks([row("archive-won", "source")]), TeamAcceptingError);
    await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "source"));
  });
  await raced;
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "archive-won"))).length, 0);
  await db.update(tasks).set({ archived: false }).where(eq(tasks.id, "source"));
  const restored = await request({ originTaskId: "source" });
  assert.equal(restored.status, 201, "unarchive restores handoff creation");
  assert.equal((await restored.json() as { originTaskId: string }).originTaskId, "source");
  assert.equal((await request({ title: "独立任务" })).status, 201, "ordinary creation is unaffected");
  console.log("archived source admission: API, all source modes, atomic batches, both archive races and restore passed");
} finally {
  await removeTmpStage(root);
}
