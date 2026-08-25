// 列表接口**不带正文**的回归（起临时库 + 挂真路由，不 spawn agent）。
//
// 钉三件事：
//   GET  /tasks         —— 每行都没有 body 这个键（一千多行任务里它占了整份响应的一半）
//   GET  /tasks/:id     —— 详情仍带正文（详情面就是从这里取的）
//   POST /tasks/bodies  —— 批量按 id 取正文；不存在的 id 不出现在结果里
//
// 类型上 `TaskListItem = Omit<Task, "body">` 已经挡住了「拿列表行当详情用」，但挡不住
// 有人在序列化那一层把 body 塞回去（比如给 enrichTasks 加字段时顺手 spread 整行）。
// 那种回退在界面上完全看不出来，只会让响应悄悄涨回两倍——所以在这里钉住。
// 跑：npm -w server run test:task-list-body
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "ash-task-list-body-"));
process.env.ASH_DB = join(root, "ash.db");

const [{ db, ensureSchema }, schema, { mountTaskRoutes }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-routes.js"),
]);
const { projects, tasks } = schema;

await ensureSchema();
const at = new Date().toISOString();
const taskRow = (id: string, body: string) => ({
  id,
  projectId: "project",
  groupId: null,
  parentId: null,
  title: id,
  body,
  mode: "single",
  status: "done",
  stage: null,
  reviewOf: null,
  reviewRound: null,
  reviewRequested: false,
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: "claude",
  executorId: null,
  autoTitle: false,
  duet: null,
  team: null,
  scheduleId: null,
  createdAt: at,
  updatedAt: at,
  useWorktree: false,
  worktreeBase: null,
  originTaskId: null,
});

try {
  await db.insert(projects).values({
    id: "project",
    name: "task list body",
    repoPath: root,
    apiKeys: null,
    createdAt: at,
  });
  await db.insert(tasks).values([taskRow("with-body", "把正文留在详情里"), taskRow("empty-body", "")]);

  const api = new Hono();
  mountTaskRoutes(api);

  const list = await (await api.request("/tasks")).json() as Record<string, unknown>[];
  assert.equal(list.length, 2, "两行任务都在列表里");
  for (const row of list) {
    assert.ok(!("body" in row), `列表行不该带正文：${String(row.id)}`);
    assert.ok(row.title, "列表行仍带标题等身份字段");
  }

  const detail = await (await api.request("/tasks/with-body")).json() as { body?: string };
  assert.equal(detail.body, "把正文留在详情里", "详情接口必须带正文");

  const bodiesResponse = await api.request("/tasks/bodies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskIds: ["with-body", "empty-body", "no-such-task"] }),
  });
  assert.equal(bodiesResponse.status, 200);
  const bodies = await bodiesResponse.json() as { taskId: string; body: string }[];
  const byId = new Map(bodies.map((row) => [row.taskId, row.body]));
  assert.equal(byId.get("with-body"), "把正文留在详情里");
  assert.equal(byId.get("empty-body"), "", "正文为空的任务照样有行——空正文和查不到是两回事");
  assert.ok(!byId.has("no-such-task"), "查不到的 id 不该编一行空正文出来");

  const empty = await (await api.request("/tasks/bodies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskIds: [] }),
  })).json();
  assert.deepEqual(empty, [], "空请求不查库");

  console.log("✓ task list omits body");
} finally {
  rmSync(root, { recursive: true, force: true });
}
