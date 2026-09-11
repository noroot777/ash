import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Task } from "@ash/shared";
import { forkTaskBody, snapshotConversationFork } from "../../web/src/task-detail/conversationFork.ts";
import type { ConversationItem } from "../../web/src/task-detail/conversationModel.ts";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-reply-fork-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
await ensureSchema();
const app = new Hono();
mountTaskRoutes(app);
const at = new Date().toISOString();
try {
  await db.insert(projects).values({ id: "p1", name: "派生验证", repoPath: root, createdAt: at });
  await db.insert(tasks).values({ id: "source", projectId: "p1", title: "来源", body: "原始目标", status: "running", createdAt: at, updatedAt: at });
  await db.insert(sessions).values({ id: "old-session", taskId: "source", role: "single", agentType: "codex", executor: "codex", cliSessionId: "must-not-resume", startedAt: at });
  const source = await (await app.request("/tasks/source")).json() as Task;
  const reply: ConversationItem = { kind: "agent", id: "a1", sessionId: "old-session", label: "Codex", markdown: "所选答复", endedAt: at,
    segments: [{ id: "seg1", markdown: "所选答复", events: [], attachments: [] }] };
  const seed = snapshotConversationFork(source, [reply, { kind: "user", id: "u2", text: "后续机密标记", attachments: [] }], reply.id);
  const body = forkTaskBody(seed.fork, "新的要求");
  const create = (originTaskId: string) => app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p1", title: "新的分支任务", body, mode: "single", originTaskId, agentType: "codex", useWorktree: false, workflowMode: "free" }) });
  const response = await create(source.id);
  assert.equal(response.status, 201);
  const forked = await response.json() as Task;
  assert.equal(forked.originTaskId, source.id);
  assert.equal(forked.parentId, null);
  assert.equal(forked.status, "backlog");
  assert.equal(forked.resumePrompt, null);
  assert.equal(forked.body, body);
  assert.ok(!forked.body.includes("后续机密标记"));
  assert.ok(!forked.body.includes("must-not-resume"));
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, forked.id))).length, 0);
  await db.update(tasks).set({ body: "来源此后变化" }).where(eq(tasks.id, source.id));
  const reloaded = await (await app.request(`/tasks/${forked.id}`)).json() as Task;
  assert.equal(reloaded.body, body, "重新读取持久化任务仍然使用原快照");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, source.id)))[0]!.status, "running");
  assert.equal((await create("missing-source")).status, 404);
  console.log("reply fork HTTP persistence, source isolation, fresh session and provenance: passed");
} finally {
  await releaseTmpDb(db);
  rmSync(root, { recursive: true, force: true });
}
