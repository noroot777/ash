import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@harness/shared";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "harness-reopen-acceptance-"));
process.env.HARNESS_DB = join(root, "harness.db");

try {
  const { bus } = await import("../src/bus.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { reopenAcceptedStage } = await import("../src/task-stage.js");
  await ensureSchema();

  const at = "2026-08-01T00:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "test", repoPath: root, createdAt: at });

  const events: ServerEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));

  for (const mode of ["single", "team", "debate"] as const) {
    const id = `accepted-${mode}`;
    await db.insert(tasks).values({
      id,
      projectId: "project",
      title: mode,
      body: "",
      mode,
      status: "done",
      stage: "accepted",
      priority: "none",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      createdAt: at,
      updatedAt: at,
    });

    assert.equal(await reopenAcceptedStage(id), true, `${mode} 续聊应撤销旧验收结论`);
    const row = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, id))).at(0);
    assert.equal(row?.stage, null);
    assert.ok(
      events.some((event) => event.type === "task.stage" && event.taskId === id && event.stage === null),
      `${mode} 应广播 stage=null`,
    );
  }

  await db.insert(tasks).values({
    id: "not-accepted",
    projectId: "project",
    title: "verified",
    body: "",
    mode: "single",
    status: "done",
    stage: "verified",
    priority: "none",
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(await reopenAcceptedStage("not-accepted"), false, "非 accepted 阶段不得改写");
  unsubscribe();
  console.log("reopen acceptance: single/team/debate 回归验证通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
