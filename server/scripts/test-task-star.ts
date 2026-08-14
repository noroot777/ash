import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@harness/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-task-star-"));
process.env.HARNESS_DB = join(root, "harness.db");

const [{ db, ensureSchema }, schema, { mountTaskRoutes }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-routes.js"),
]);
const { projects, tasks } = schema;

await ensureSchema();
const seededAt = "2026-08-01T00:00:00.000Z";

try {
  await db.insert(projects).values({ id: "project", name: "star", repoPath: root, createdAt: seededAt });
  await db.insert(tasks).values([
    { id: "top", projectId: "project", title: "top-level task", createdAt: seededAt, updatedAt: seededAt },
    { id: "worker", projectId: "project", title: "worker task", parentId: "top", createdAt: seededAt, updatedAt: seededAt },
  ]);

  const api = new Hono();
  mountTaskRoutes(api);
  const patch = (id: string, body: unknown) => api.request(`/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // updatedAt 是「最后活动时间」（同组排序、24 小时折叠、未读事件键都读它）；星标是与
  // 活动正交的手动软记号。只动 starredAt 的 PATCH 推进 updatedAt 的样子：点星的旧任务
  // 跳到组首、24 小时折叠被解除、已读终态被伪装成新完成/失败。
  let response = await patch("top", { starredAt: 1754900000000 });
  assert.equal(response.status, 200);
  let task = await response.json() as Task;
  assert.equal(task.starredAt, 1754900000000);
  assert.equal(task.updatedAt, seededAt, "star-only PATCH must not bump updatedAt");

  // 取消星标同样是纯记号操作。
  response = await patch("top", { starredAt: null });
  assert.equal(response.status, 200);
  task = await response.json() as Task;
  assert.equal(task.starredAt, null);
  assert.equal(task.updatedAt, seededAt, "unstar must not bump updatedAt");

  // 对照组：星标混着真实内容改动时，updatedAt 照常推进 —— 豁免只给「只动星标」。
  response = await patch("top", { title: "renamed", starredAt: 1754900001000 });
  assert.equal(response.status, 200);
  task = await response.json() as Task;
  assert.equal(task.starredAt, 1754900001000);
  assert.notEqual(task.updatedAt, seededAt, "content PATCH must bump updatedAt");

  // UI 只给顶层任务画星标入口：child/worker 拒收非 null，不留「筛选不计数、界面清不掉」
  // 的隐形星标；null（清除）放行 —— 老数据里已有的 child 星标得留一条从 API 清理的路。
  response = await patch("worker", { starredAt: 1754900000000 });
  assert.equal(response.status, 400);
  const worker = (await db.select().from(tasks).where(eq(tasks.id, "worker"))).at(0);
  assert.equal(worker?.starredAt ?? null, null);

  await db.update(tasks).set({ starredAt: 123 }).where(eq(tasks.id, "worker"));
  response = await patch("worker", { starredAt: null });
  assert.equal(response.status, 200, "clearing a legacy child star must be allowed");
  const cleared = (await db.select().from(tasks).where(eq(tasks.id, "worker"))).at(0);
  assert.equal(cleared?.starredAt ?? null, null);
  assert.equal(cleared?.updatedAt, seededAt, "clearing star must not bump updatedAt either");

  // 非法值仍被校验拦下。
  for (const bad of [-1, 1.5, "soon"]) {
    response = await patch("top", { starredAt: bad });
    assert.equal(response.status, 400, `starredAt=${bad} must be rejected`);
  }

  console.log("task star patch tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
