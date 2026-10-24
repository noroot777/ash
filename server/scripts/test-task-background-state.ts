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
const { projects, tasks, monitors } = await import("../src/db/schema.js");
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
  assert.ok((await snapshot()).every(task => task.monitorRunning === false));
  await db.insert(monitors).values(["single", "worker"].map(taskId => ({
    id: `monitor-${taskId}`, taskId, command: "fixture", cwd: root, logPath: join(root, taskId),
    startedAt: timestamp, expiresAt: timestamp, status: "running",
  })));
  for (const task of await snapshot()) {
    assert.equal(task.monitorRunning, task.id === "single" || task.id === "worker");
  }
  await db.update(monitors).set({ status: "exited" }).where(eq(monitors.taskId, "single"));
  assert.equal((await snapshot()).find(task => task.id === "single")!.monitorRunning, false);

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
  console.log("task background state: monitor facts and project command invalidation passed");
} finally {
  unsubscribe();
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
