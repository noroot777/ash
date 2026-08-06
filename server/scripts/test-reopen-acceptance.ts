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
    for (const stage of ["accepted", "merged"] as const) {
      const id = `${stage}-${mode}`;
      await db.insert(tasks).values({
        id,
        projectId: "project",
        title: mode,
        body: "",
        mode,
        status: "done",
        stage,
        priority: "none",
        labels: "[]",
        dependsOn: "[]",
        resumeDependsOn: "[]",
        createdAt: at,
        updatedAt: at,
      });

      // merged 跟 accepted 一样是**上一版**的结论，必须一起撤销。留着它的后果不只是
      // 显示不准：`enterHumanGate` 见到 merged 会**静默跳过**「等我点头」那道关口，
      // 于是续聊改出来的新一版一路走到底，连问都不问用户一句。
      assert.equal(await reopenAcceptedStage(id), true, `${mode} 的 ${stage} 续聊时应撤销旧结论`);
      const row = (await db.select({ stage: tasks.stage, updatedAt: tasks.updatedAt }).from(tasks).where(eq(tasks.id, id))).at(0);
      assert.equal(row?.stage, null);
      const stageEvent = events.find((event) => event.type === "task.stage" && event.taskId === id && event.stage === null);
      assert.ok(
        stageEvent,
        `${mode} 的 ${stage} 应广播 stage=null`,
      );
      assert.equal(stageEvent.updatedAt, row?.updatedAt, `${mode} 的 ${stage} 的 SSE 与数据库 updatedAt 应一致`);
    }
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
  assert.equal(await reopenAcceptedStage("not-accepted"), false, "非 accepted/merged 阶段不得改写");
  unsubscribe();
  console.log("reopen acceptance: single/team/debate × accepted/merged 回归验证通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
