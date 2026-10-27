import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, dbClient } from "../src/db/index.js";
import { appSettings, sessions, tasks } from "../src/db/schema.js";
import { isRunning, isTurnClaimed, stopTask } from "../src/runs.js";
import { mountTaskRunRoutes } from "../src/task-run-routes.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";

function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function freezeArchiveCases(root: string): Promise<void> {
  const environment = { path: process.env.PATH, allow: process.env.ASH_ALLOW_REAL_AGENT, log: process.env.ASH_TEST_LEAD_LOG };
  const inputLog = join(root, "archive-retry-input.log");
  process.env.PATH = `${installFakeClaude(root)}${delimiter}${environment.path ?? ""}`;
  process.env.ASH_ALLOW_REAL_AGENT = "1";
  process.env.ASH_TEST_LEAD_LOG = inputLog;
  await db.insert(appSettings).values({ key: "archiveClean", value: JSON.stringify("none") })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify("none") } });
  const api = new Hono();
  mountTaskRunRoutes(api);
  const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (taskId: string, action: string) => fetch(`${base}/tasks/${taskId}/${action}`, { method: "POST" });
    {
      const initialStatus = "done";
      const taskId = `archive-retry-${initialStatus}`;
      const sessionId = `${taskId}-previous`;
      const stamp = new Date().toISOString();
      await db.insert(tasks).values({
        id: taskId, projectId: "p", title: taskId, body: "retry interrupted follow-up", status: initialStatus,
        mode: "single", agentType: "claude", useWorktree: false, createdAt: stamp, updatedAt: stamp,
      });
      await db.insert(sessions).values({
        id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude",
        cliSessionId: "archive-retry-old-cli", startedAt: stamp, endedAt: stamp, exitStatus: 1,
      });
      const transcript = sessionTranscriptPath(taskId, sessionId);
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, `\x1e${JSON.stringify({ t: "user", agent: "claude", text: "RETRY_BEFORE_ARCHIVE", at: stamp })}\n`);
      const execute = dbClient.execute;
      const archiveAllowed = barrier();
      const archiveCommitted = barrier();
      let archiveWaiting = false;
      let guardRead = false;
      let archiveRequest: Promise<Response> | undefined;
      dbClient.execute = async function (statement) {
        const query = typeof statement === "string" ? statement : statement.sql;
        const target = typeof statement !== "string" && Array.isArray(statement.args) && statement.args.includes(taskId);
        if (target && !archiveWaiting && /^update "tasks" set .*"archived" =/i.test(query)) {
          archiveWaiting = true;
          await archiveAllowed.ready;
          const result = await execute.call(dbClient, statement);
          archiveCommitted.release();
          return result;
        }
        if (target && archiveWaiting && !guardRead && /^select "archived", "group_id" from "tasks"/i.test(query)) {
          guardRead = true;
          archiveAllowed.release();
          await archiveCommitted.ready;
        }
        return execute.call(dbClient, statement);
      };
      try {
        archiveRequest = post(taskId, "archive");
        await until(() => archiveWaiting, "archive did not reach its real write boundary");
        const retry = await post(taskId, "retry-turn");
        assert.equal(retry.status, 202);
        assert.equal((await retry.json() as { mode: string }).mode, "resend");
        await until(() => guardRead, "retry did not reach its final freeze fact read");
        assert.equal((await archiveRequest).status, 200);
        await until(() => !isTurnClaimed(taskId) && !isRunning(taskId), "archived retry did not settle");
        const [archived] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(archived?.archived, true);
        assert.equal(archived?.status, initialStatus);
        assert.equal(archived?.followUpFrom, null);
        assert.equal(existsSync(inputLog), false);
        assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length, 1);
        const restored = await post(taskId, "unarchive");
        assert.equal(restored.status, 200);
        const body = await restored.json() as { task: { status: string; archived: boolean } };
        assert.equal(body.task.status, initialStatus);
        assert.equal(body.task.archived, false);
        const [unarchived] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(unarchived?.status, initialStatus);
        assert.equal(unarchived?.archived, false);
        console.log(`PASS: real HTTP archive/retry/unarchive preserves ${initialStatus}, with no CLI or new session`);
      } finally {
        dbClient.execute = execute;
        archiveAllowed.release();
        archiveCommitted.release();
        await archiveRequest?.catch(() => undefined);
        stopTask(taskId);
        await until(() => !isTurnClaimed(taskId) && !isRunning(taskId), "archive retry cleanup left active work");
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (environment.path === undefined) delete process.env.PATH;
    else process.env.PATH = environment.path;
    if (environment.allow === undefined) delete process.env.ASH_ALLOW_REAL_AGENT;
    else process.env.ASH_ALLOW_REAL_AGENT = environment.allow;
    if (environment.log === undefined) delete process.env.ASH_TEST_LEAD_LOG;
    else process.env.ASH_TEST_LEAD_LOG = environment.log;
  }
}
