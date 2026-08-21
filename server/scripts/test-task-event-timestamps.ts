import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ash/shared";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "ash-task-event-timestamps-"));
process.env.ASH_DB = join(root, "ash.db");

try {
  const { bus } = await import("../src/bus.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { setTaskStatus } = await import("../src/status.js");
  await ensureSchema();

  const at = "2026-08-01T00:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "test", repoPath: root, createdAt: at });
  await db.insert(tasks).values({
    id: "task",
    projectId: "project",
    title: "task",
    body: "",
    mode: "single",
    status: "backlog",
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    createdAt: at,
    updatedAt: at,
  });

  const events: ServerEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));
  await setTaskStatus("task", "running");

  const row = (await db.select({ updatedAt: tasks.updatedAt }).from(tasks).where(eq(tasks.id, "task"))).at(0);
  const event = events.find((candidate) => candidate.type === "task.status" && candidate.taskId === "task");
  assert.ok(event, "状态变化应广播 task.status");
  assert.equal(event.updatedAt, row?.updatedAt, "状态 SSE 必须携带数据库实际写入的 updatedAt");
  assert.notEqual(event.updatedAt, at, "状态变化应推进 updatedAt");

  unsubscribe();
  console.log("task event timestamps: status SSE 与数据库水位一致");
} finally {
  rmSync(root, { recursive: true, force: true });
}
