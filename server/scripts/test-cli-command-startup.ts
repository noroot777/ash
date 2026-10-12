import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-cli-startup-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
delete process.env.ASH_ALLOW_REAL_AGENT;
const { db, ensureSchema } = await import("../src/db/index.js");
const { groups, projects, tasks, sessions, queueItems } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { isTurnClaimed } = await import("../src/runs.js");
const { bus } = await import("../src/bus.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
mountGroupRoutes(api);
mountTaskRunRoutes(api);
const at = new Date().toISOString();
const request = (path: string, method: string, body: Record<string, unknown> = {}) => api.request(path, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const create = (body: string, agentType: string) => request("/tasks", "POST", {
  projectId: "project", title: "命令任务", body, agentType, useWorktree: false,
});
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

async function runFailed(taskId: string, message: RegExp): Promise<string> {
  const response = await request(`/tasks/${taskId}/run`, "POST");
  assert.equal(response.status, 202);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await row(taskId)).status === "failed" && !isTurnClaimed(taskId)) break;
    await delay(20);
  }
  assert.equal((await row(taskId)).status, "failed");
  assert.equal(isTurnClaimed(taskId), false);
  const listed = await api.request(`/tasks/${taskId}/sessions`);
  assert.equal(listed.status, 200);
  const recorded = await listed.json();
  assert.equal(recorded.length, 1, "起跑前失败也必须有持久会话，重试不能重复造会话");
  assert.equal(recorded[0].cliSessionId, null, "诊断记录不能冒充已经启动的 CLI 会话");
  assert.equal(recorded[0].exitStatus, 1);
  assert.ok(recorded[0].endedAt);
  const output = await api.request(`/sessions/${recorded[0].id}/output`);
  assert.equal(output.status, 200);
  const text = await output.text();
  assert.match(text, /这一轮没能起跑/);
  assert.match(text, message);
  return recorded[0].id;
}

try {
  await db.insert(projects).values({ id: "project", name: "命令验证", repoPath: root, createdAt: at });
  await db.insert(groups).values({ id: "group", projectId: "project", name: "串行验证", mode: "serial", createdAt: at });
  for (const [agentType, body, expected] of [
    ["claude", "/plan 怎么做这个功能", /当前执行器的 ash 通道不支持 \/plan/],
    ["codex", "/usage 看一下用量", /\/usage 不接受参数/],
    ["codex", "/goal 完成测试 --budget 0", /目标预算必须是正整数/],
    ["claude", "/goal 完成测试 --budget 100", /不支持 token 预算参数/],
  ] as const) {
    const before = (await db.select().from(tasks)).length;
    const response = await create(body, agentType);
    assert.equal(response.status, 400, body);
    assert.match((await response.json()).error, expected);
    assert.equal((await db.select().from(tasks)).length, before);
  }
  const invalidBatch = await request("/groups/group/tasks/batch", "POST", {
    chain: true, defaults: { agentType: "codex", useWorktree: false },
    tasks: [{ title: "先建", body: "普通正文" }, { title: "无效", body: "/status 看进度" }],
  });
  assert.equal(invalidBatch.status, 400);
  assert.match((await invalidBatch.json()).error, /\/status 不接受参数/);
  assert.equal((await db.select().from(tasks)).length, 0);
  assert.equal((await db.select().from(queueItems)).length, 0);
  for (const [agentType, body] of [
    ["claude", "/compact 保留重点"], ["claude", "/review 自定义技能"],
    ["codex", "/review 看看这次改动"], ["codex", "/goal 完成测试 --budget 100"],
  ]) assert.equal((await create(body!, agentType!)).status, 201, body);

  const edited = await (await create("普通正文", "codex")).json();
  const patch = await request(`/tasks/${edited.id}`, "PATCH", { body: "/status 看一下当前进度再决定下一步" });
  assert.equal(patch.status, 200);
  const diagnosticEvents: string[] = [];
  const unsubscribe = bus.subscribe((event) => {
    if (event.type === "agent.event" && event.taskId === edited.id && event.event.kind === "system") diagnosticEvents.push(event.sessionId);
  });
  const sessionId = await runFailed(edited.id, /\/status 不接受参数/);
  assert.ok(diagnosticEvents.includes(sessionId), "实时事件必须落到实际会话");
  unsubscribe();
  assert.equal(await runFailed(edited.id, /\/status 不接受参数/), sessionId);

  await db.insert(tasks).values({ id: "legacy", projectId: "project", title: "老任务", body: "/usage 看一下这个月的用量再决定", agentType: "codex", status: "backlog", createdAt: at, updatedAt: at });
  await runFailed("legacy", /\/usage 不接受参数/);
  await db.insert(tasks).values({ id: "legacy-claude", projectId: "project", title: "Claude 老任务", body: "/plan 怎么做这个功能", agentType: "claude", status: "backlog", createdAt: at, updatedAt: at });
  await runFailed("legacy-claude", /ash 通道不支持 \/plan/);
  assert.equal((await db.select().from(sessions)).every((session) => !session.agentPid && !session.cliSessionId), true);
  console.log("native creation errors return 400; edited/legacy startup failures persist and remain visible after reload: passed");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
