import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  api, db, dbClient, hits, now, runs, scenario, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { mountGroupRoutes } from "../src/group-routes.js";
import { runGroup } from "../src/scheduler.js";
import { takeResumePrompt } from "../src/task-resume-prompt.js";
import { reserveQueuedTask, taskQueueReservation } from "../src/task-queue-reservation.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { isDiagnosticSession } from "../src/turn-failure.js";
import { id } from "../src/util.js";

const groupApi = new Hono();
mountGroupRoutes(groupApi);

async function transcript(taskId: string): Promise<string> {
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, taskId));
  return sessions.map((session) => {
    const path = sessionTranscriptPath(taskId, session.id);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\n");
}

export async function checkpointGroupFailureCases(): Promise<void> {
  for (const failure of ["write", "guarded-stop", "cleanup"]) {
    const members = [];
    for (let index = 0; index < 6; index++) {
      const test = await scenario(0);
      const body = `GROUP_MEMBER_${id()}`;
      await takeResumePrompt(test.taskId, test.checkpoint);
      await db.update(tasks).set({ status: "backlog", body }).where(eq(tasks.id, test.taskId));
      members.push({ ...test, body });
    }
    const first = await taskOf(members[0]!.taskId);
    const groupId = id();
    const queueId = id();
    await db.insert(schema.groups).values({ id: groupId, projectId: first.projectId, name: failure, mode: "parallel", createdAt: now() });
    const follower = await scenario(0);
    for (const member of [...members, follower]) await db.update(tasks).set({ groupId }).where(eq(tasks.id, member.taskId));
    await db.insert(schema.queueItems).values({ taskId: follower.taskId, queueId, position: 0, createdAt: now() });
    const failedId = members[1]!.taskId;
    const execute = dbClient.execute;
    let injected = false;
    let cleanupFailed = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    dbClient.execute = async function (statement) {
      if (typeof statement !== "string" && /^update "tasks" set "status" =/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args.includes(failedId)) {
        if (!injected && statement.args[0] === "queued") {
          injected = true;
          if (failure === "guarded-stop") {
            await reserveQueuedTask(taskQueueReservation(await taskOf(failedId)));
            assert.equal((await api.request(`/tasks/${failedId}/stop`, { method: "POST" })).status, 200);
          } else {
            if (failure === "cleanup") await execute.call(dbClient, statement);
            throw new Error("INJECT_MEMBER_SEAT_WRITE_FAILURE");
          }
        } else if (failure === "cleanup" && !cleanupFailed && statement.args[0] === "backlog") {
          cleanupFailed = true;
          throw new Error("INJECT_MEMBER_SEAT_CLEANUP_FAILURE");
        }
      }
      return execute.call(dbClient, statement);
    };
    try {
      await runGroup(groupId);
      assert.equal(injected, true);
      assert.equal(cleanupFailed, failure === "cleanup");
      for (const member of members) {
        await settled(member.taskId);
        assert.equal((await taskOf(member.taskId)).queueSeatToken, null);
        const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, member.taskId));
        if (member.taskId === failedId) {
          assert.equal(hits(member.body), 0);
          assert.equal((await taskOf(failedId)).status, failure === "guarded-stop" ? "canceled" : "backlog");
          assert.ok(sessions.some(isDiagnosticSession));
          assert.match(await transcript(failedId), /分组本次启动未完成/);
        } else {
          assert.ok(hits(member.body) > 0, "超过并发上限的第5/6项也到达执行器");
          assert.equal(sessions.filter((session) => !isDiagnosticSession(session)).length, 1);
        }
      }
      await until("并行分组收尾仍推进关联队列", async () => hits(follower.checkpoint) === 1);
      await settled(follower.taskId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      dbClient.execute = execute;
      process.off("unhandledRejection", onUnhandled);
      await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    }
    console.log(`PASS: parallel group ${failure} stays local, later members and linked queues still run with durable diagnostics`);
  }

  {
    const test = await scenario(0);
    await takeResumePrompt(test.taskId, test.checkpoint);
    await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, test.taskId));
    const task = await taskOf(test.taskId);
    const groupId = id();
    await db.insert(schema.groups).values({ id: groupId, projectId: task.projectId, name: "background-error", mode: "parallel", createdAt: now() });
    await db.update(tasks).set({ groupId }).where(eq(tasks.id, test.taskId));
    const execute = dbClient.execute;
    let reads = 0;
    let injected = false;
    dbClient.execute = async function (statement) {
      if (typeof statement !== "string" && /from "groups" where/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args.includes(groupId) && ++reads === 2) {
        injected = true;
        throw new Error("INJECT_BACKGROUND_GROUP_READ_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    try {
      assert.equal((await groupApi.request(`/groups/${groupId}/run`, { method: "POST" })).status, 202);
      await until("后台恢复失败留下持久时间线", async () => /INJECT_BACKGROUND_GROUP_READ_FAILURE/.test(await transcript(test.taskId)));
      assert.equal(injected, true);
      const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, test.taskId));
      assert.equal(sessions.length, 1);
      assert.ok(isDiagnosticSession(sessions[0]!));
      assert.equal(runs.isTurnClaimed(test.taskId), false);
    } finally {
      dbClient.execute = execute;
    }
    console.log("PASS: real group-run HTTP background rejection is reported in a refresh-persistent diagnostic session");
  }
}
