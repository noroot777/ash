import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, root, runs, schema, tasks, until } from "./monitors-fixture.js";
import type { setupRegressionReviews } from "./regression-review-fixture.js";

export async function testReviewAcceptanceOwnership(open: Awaited<ReturnType<typeof setupRegressionReviews>>["open"]) {
  const { acceptTask } = await import("../src/task-accept.js");
  const { acceptGateCheck, startPendingAcceptGate } = await import("../src/accept-gate.js");
  const { directionIdentityCleared, turnDirectionStart } = await import("../src/task-direction-epoch.js");
  const { settlementAuthority } = await import("../src/review-ownership.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  for (const timing of ["before-spawn", "while-running"] as const) {
    const review = await open("preset");
    assert.equal((await review.stage()).status, 200);
    await review.settle(true);
    runs.releaseTurn(review.taskId);
    await db.update(tasks).set({ status: "done", ...directionIdentityCleared() }).where(eq(tasks.id, review.taskId));
    const task = (await db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!;
    const authority = settlementAuthority(await review.state());
    const ready = join(root, `gate-${timing}-ready`), release = join(root, `gate-${timing}-release`);
    const script = join(root, `gate-${timing}.cjs`);
    writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10)`);
    await db.update(schema.projects).set({ acceptGateCommand: `node ${JSON.stringify(script)}` }).where(eq(schema.projects.id, task.projectId));
    const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0]!;
    try {
      if (timing === "before-spawn") {
        const planned = await acceptGateCheck(task, project, { choices: { by: "workflow", reviewAuthority: authority } });
        assert.equal(planned?.reason, "accept_gate_required");
        await db.update(tasks).set({ stage: "implemented", ...turnDirectionStart("new-turn", "new-direction") }).where(eq(tasks.id, task.id));
        const stopped = await startPendingAcceptGate(task.id);
        assert.equal(stopped?.status, "failed");
        assert.equal(existsSync(ready), false, "a stale planned gate never spawns its command");
      } else {
        const sessionId = `gate-${task.id}`;
        await db.insert(schema.sessions).values({ id: sessionId, taskId: task.id, role: "single", agentType: "codex",
          executor: "test", startedAt: new Date().toISOString() });
        const started = await acceptTask(task.id, "workflow", { reviewAuthority: authority });
        assert.equal(started.accepted, false);
        assert.equal(!started.accepted && started.reason, "accept_gate_running");
        await until("accept gate running", async () => existsSync(ready));
        const gate = (await db.select().from(schema.acceptGateRuns).where(eq(schema.acceptGateRuns.taskId, task.id)))[0]!;
        assert.deepEqual(JSON.parse(gate.acceptOptions!).reviewAuthority, authority);
        await db.update(tasks).set({ stage: "implemented", ...turnDirectionStart("new-turn", "new-direction") }).where(eq(tasks.id, task.id));
        writeFileSync(release, "release");
        const transcript = sessionTranscriptPath(task.id, sessionId);
        await until("stale gate automatic acceptance refused", async () => existsSync(transcript)
          && /验收前置命令通过后自动继续验收，但没能完成：审查所属的原目标方向已失效/.test(readFileSync(transcript, "utf8")));
        assert.equal((await db.select().from(schema.acceptGateRuns).where(eq(schema.acceptGateRuns.id, gate.id)))[0]?.status, "passed");
      }
      const current = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
      assert.equal(current.stage, "implemented");
      assert.equal(current.activeDirectionToken, "new-direction");
      console.log(`✓ ${timing}: acceptance gate persists original authority and cannot accept a newer direction`);
    } finally {
      writeFileSync(release, "release");
      await db.update(schema.projects).set({ acceptGateCommand: null }).where(eq(schema.projects.id, task.projectId));
    }
  }
}
