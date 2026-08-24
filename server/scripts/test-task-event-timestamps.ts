import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionOutput, type ServerEvent } from "@ash/shared";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "ash-task-event-timestamps-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

try {
  const { bus } = await import("../src/bus.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { setTaskStatus } = await import("../src/status.js");
  const { appendTaskTimeline } = await import("../src/task-timeline.js");
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
  await db.insert(sessions).values({
    id: "session",
    taskId: "task",
    role: "single",
    agentType: "codex",
    executor: "codex@local",
    startedAt: at,
  });

  const events: ServerEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));
  await setTaskStatus("task", "running");

  const row = (await db.select({ updatedAt: tasks.updatedAt }).from(tasks).where(eq(tasks.id, "task"))).at(0);
  const event = events.find((candidate) => candidate.type === "task.status" && candidate.taskId === "task");
  assert.ok(event, "状态变化应广播 task.status");
  assert.equal(event.updatedAt, row?.updatedAt, "状态 SSE 必须携带数据库实际写入的 updatedAt");
  assert.notEqual(event.updatedAt, at, "状态变化应推进 updatedAt");

  assert.equal(await appendTaskTimeline("task", "已预约完成后审查。"), true);
  const liveNote = events.find((candidate) => (
    candidate.type === "agent.event"
    && candidate.taskId === "task"
    && candidate.event.kind === "system"
  ));
  assert.ok(liveNote && liveNote.type === "agent.event" && liveNote.event.kind === "system");
  const persistedNote = parseSessionOutput(
    readFileSync(join(root, "runs", "task", "session.md"), "utf8"),
  ).find((segment) => segment.kind === "system");
  assert.ok(persistedNote?.at, "系统旁注落盘应带时间");
  assert.equal(liveNote.event.at, persistedNote.at, "系统旁注 SSE 与落盘 sentinel 必须共用同一时间");

  unsubscribe();
  console.log("task event timestamps: 状态水位与系统旁注时间均保持实时/落盘一致");
} finally {
  rmSync(root, { recursive: true, force: true });
}
