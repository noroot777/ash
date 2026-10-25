import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "ash-task-background-"));
process.env.ASH_DB = join(root, "test.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, monitors, acceptGateRuns, taskBackgroundRevisions } = await import("../src/db/schema.js");
const { createClient } = await import("../src/db/node-sqlite-client.js");
const { ensureTaskBackgroundSchema } = await import("../src/db/schema-task-background.js");
const { enrichTasks } = await import("../src/task-store.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
const { bus } = await import("../src/bus.js");
const announced: string[] = [];
const unsubscribe = bus.subscribe(event => {
  if (event.type === "task.acceptGate") announced.push(event.taskId);
});

try {
  await ensureSchema();
  const timestamp = new Date().toISOString();
  await db.insert(projects).values([
    { id: "project", name: "project", repoPath: root, createdAt: timestamp },
    { id: "other", name: "other", repoPath: root, createdAt: timestamp },
  ]);
  await db.insert(tasks).values(["single", "lead", "worker", "other-task"].map(taskId => ({
    id: taskId, projectId: taskId === "other-task" ? "other" : "project", title: taskId,
    mode: taskId === "lead" ? "team" : "single", parentId: taskId === "worker" ? "lead" : null,
    status: "paused", createdAt: timestamp, updatedAt: timestamp,
  })));
  const snapshot = async () => enrichTasks(await db.select().from(tasks));
  const row = async (taskId: string) => (await snapshot()).find(task => task.id === taskId)!;
  assert.ok((await snapshot()).every(task => task.monitorRunning === false));
  assert.ok((await snapshot()).every(task => task.backgroundRevision === 0));
  await db.insert(monitors).values(["single", "worker"].map(taskId => ({
    id: `monitor-${taskId}`, taskId, command: "fixture", cwd: root, logPath: join(root, taskId),
    startedAt: timestamp, expiresAt: timestamp, status: "running",
  })));
  for (const task of await snapshot()) {
    assert.equal(task.monitorRunning, task.id === "single" || task.id === "worker");
    assert.equal(task.backgroundRevision, task.monitorRunning ? 1 : 0);
  }
  await db.update(monitors).set({ status: "exited" }).where(eq(monitors.taskId, "single"));
  assert.equal((await snapshot()).find(task => task.id === "single")!.monitorRunning, false);
  assert.equal((await row("single")).backgroundRevision, 2);
  await db.update(monitors).set({ command: "fixture-next" }).where(eq(monitors.taskId, "single"));
  assert.equal((await row("single")).backgroundRevision, 2);
  await db.update(monitors).set({ taskId: "lead" }).where(eq(monitors.taskId, "worker"));
  assert.equal((await row("worker")).backgroundRevision, 2);
  assert.equal((await row("worker")).monitorRunning, false);
  assert.equal((await row("lead")).backgroundRevision, 1);
  assert.equal((await row("lead")).monitorRunning, true);
  await db.delete(monitors).where(eq(monitors.taskId, "lead"));
  assert.equal((await row("lead")).backgroundRevision, 2);
  assert.equal((await row("lead")).monitorRunning, false);
  const staleRows = await db.select().from(tasks);
  await db.insert(acceptGateRuns).values({
    id: "gate", taskId: "single", projectId: "project", command: "fixture", cwd: root,
    logPath: join(root, "gate.log"), status: "running", startedAt: timestamp,
  });
  const projected = (await enrichTasks(staleRows)).find(task => task.id === "single")!;
  assert.equal(projected.backgroundRevision, 3);
  assert.equal(projected.acceptGateRunning, true);
  await db.update(acceptGateRuns).set({ status: "passed", processPending: true }).where(eq(acceptGateRuns.id, "gate"));
  assert.equal((await row("single")).backgroundRevision, 4);
  assert.equal((await row("single")).acceptGateRunning, true);
  await db.update(acceptGateRuns).set({ processPending: false }).where(eq(acceptGateRuns.id, "gate"));
  assert.equal((await row("single")).backgroundRevision, 5);
  assert.equal((await row("single")).acceptGateRunning, false);
  await db.update(acceptGateRuns).set({ status: "passed" }).where(eq(acceptGateRuns.id, "gate"));
  assert.equal((await row("single")).backgroundRevision, 5);
  const transaction = await dbClient.transaction();
  await transaction.execute("UPDATE accept_gate_runs SET status = 'running' WHERE id = 'gate'");
  await transaction.rollback();
  assert.equal((await row("single")).backgroundRevision, 5);
  assert.equal((await row("single")).acceptGateRunning, false);
  await db.delete(acceptGateRuns).where(eq(acceptGateRuns.id, "gate"));
  assert.equal((await row("single")).backgroundRevision, 6);
  await ensureSchema();
  assert.equal((await row("single")).backgroundRevision, 6);
  const reopened = createClient({ url: process.env.ASH_DB! });
  try {
    await ensureTaskBackgroundSchema(reopened);
    const persisted = await reopened.execute("SELECT revision FROM task_background_revisions WHERE task_id = 'single'");
    assert.equal(persisted.rows[0].revision, 6);
  } finally { reopened.close(); }
  assert.ok((await snapshot()).every(task => task.updatedAt === timestamp));
  await db.delete(tasks).where(eq(tasks.id, "worker"));
  assert.equal((await db.select().from(taskBackgroundRevisions).where(eq(taskBackgroundRevisions.taskId, "worker"))).length, 0);
  await db.insert(tasks).values({ id: "worker", projectId: "project", title: "worker", status: "paused", createdAt: timestamp, updatedAt: timestamp });

  const api = new Hono();
  mountProjectRoutes(api);
  const patch = (body: unknown) => api.request("/projects/project", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const expected = ["lead", "single", "worker"];
  assert.equal((await patch({ acceptGateCommand: "npm test" })).status, 200);
  assert.deepEqual(announced.splice(0).sort(), expected);
  assert.equal((await patch({ acceptGateCommand: " npm test " })).status, 200);
  assert.deepEqual(announced.splice(0), []);
  assert.equal((await patch({ name: "renamed" })).status, 200);
  assert.deepEqual(announced.splice(0), []);
  assert.equal((await patch({ acceptGateCommand: "npm run full" })).status, 200);
  assert.deepEqual(announced.splice(0).sort(), expected);
  assert.equal((await patch({ acceptGateCommand: null })).status, 200);
  assert.deepEqual(announced.splice(0).sort(), expected);
  assert.equal((await patch({ acceptGateCommand: 123 })).status, 400);
  assert.deepEqual(announced, []);
  console.log("task background state: atomic revision, rollback, persistence, monitor facts and command invalidation passed");
} finally {
  unsubscribe();
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
