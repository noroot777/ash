// 任务备忘的后端回归：CRUD、校验、批量摘要。自用模式（归属列恒 null）下跑，
// 多人模式那一层（filterOwned / canUseOwned）复用的是随手记同一组函数，不在这里重测。
//
// 跑：ASH_DB=$TMPDIR/task-memos-$$.db npx tsx server/scripts/test-task-memos.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-memos-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("task-memos");

const [{ db, ensureSchema }, schema, memoRoutes, { TASK_MEMO_MAX_LEN }, { TASK_BATCH_LIMIT }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-memos.js"),
  import("@ash/shared/task-memo"),
  import("@ash/shared"),
]);
const { projects, taskMemos, tasks } = schema;

await ensureSchema();

const api = new Hono();
memoRoutes.mountTaskMemoRoutes(api);

const now = () => new Date().toISOString();
const call = async (path: string, init?: RequestInit) => {
  const response = await api.request(`http://x${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
  call(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

await db.insert(projects).values({ id: "p1", name: "memos", repoPath: root, createdAt: now() });
for (const id of ["t1", "t2"]) {
  await db.insert(tasks).values({
    id, projectId: "p1", title: id, body: "", status: "done", mode: "single", createdAt: now(), updatedAt: now(),
  });
}

// ── 增 / 列 ─────────────────────────────────────────────────────────────────
{
  const created = await post("/tasks/t1/memos", { body: "  验收时记得查严格增长门  " });
  assert.equal(created.status, 201);
  assert.equal(created.body.body, "验收时记得查严格增长门", "首尾空白要摘掉");
  assert.equal(created.body.taskId, "t1");
  assert.equal(created.body.createdAt, created.body.updatedAt, "刚建的那条没有「已编辑」之说");

  const listed = await call("/tasks/t1/memos");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  // 别的任务不许串台。
  assert.deepEqual((await call("/tasks/t2/memos")).body, []);
}

// ── 校验：空白、超长、不存在的任务 ──────────────────────────────────────────
{
  assert.equal((await post("/tasks/t1/memos", { body: "   \n " })).status, 400, "全是空白不算内容");
  assert.equal((await post("/tasks/t1/memos", {})).status, 400, "没给正文");
  const tooLong = await post("/tasks/t1/memos", { body: "字".repeat(TASK_MEMO_MAX_LEN + 1) });
  assert.equal(tooLong.status, 400, "超长要报错而不是悄悄截断");
  assert.match(tooLong.body.error, /最多/);
  assert.equal((await post("/tasks/nope/memos", { body: "x" })).status, 404, "往不存在的任务上写");
}

// ── 改 ──────────────────────────────────────────────────────────────────────
{
  const memo = (await call("/tasks/t1/memos")).body[0];
  const updated = await patch(`/tasks/t1/memos/${memo.id}`, { body: "改过了" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.body, "改过了");
  assert.notEqual(updated.body.updatedAt, updated.body.createdAt, "改过的那条要能看出来");
  assert.equal((await patch(`/tasks/t1/memos/${memo.id}`, { body: " " })).status, 400);
  // 单条端点一律挂在任务 id 下，拿着别的任务的 id 来改同一条就是 404 —— 这条路径
  // 走的是横切闸（`/tasks/:id/…`），换成全局 `/memos/:id` 就整个漏在闸外了。
  assert.equal((await patch(`/tasks/t2/memos/${memo.id}`, { body: "越过去改" })).status, 404);
  assert.equal((await call(`/tasks/t2/memos/${memo.id}`, { method: "DELETE" })).status, 404);
}

// ── 批量摘要：几条、哪条最新、超长截断 ──────────────────────────────────────
{
  await post("/tasks/t1/memos", { body: "第二条，更新" });
  await post("/tasks/t2/memos", { body: "另一个任务的" });
  // 时间戳只到毫秒：连着两发可能落在同一刻，而这条用例要的是「后写的那条赢」。
  await new Promise((resolve) => setTimeout(resolve, 5));
  const long = "很长的备忘。".repeat(400);
  await post("/tasks/t2/memos", { body: long });

  const digests = await post("/tasks/memos", { taskIds: ["t1", "t2", "t-none"] });
  assert.equal(digests.status, 200);
  const byTask = new Map(digests.body.map((row: { taskId: string }) => [row.taskId, row]));
  assert.equal(byTask.size, 2, "没有备忘的任务不出现在结果里（前端据此区分「没有」和「没问过」）");
  assert.equal(byTask.get("t1").count, 2);
  assert.equal(byTask.get("t1").text, "第二条，更新", "摘要给的是最近更新的那条");
  assert.equal(byTask.get("t2").truncated, true, "超长摘要要截断，不能把几十 KB 运进列表接口");
  assert.ok(byTask.get("t2").text.endsWith("…"));
  assert.equal((await post("/tasks/memos", { taskIds: "t1" })).status, 400, "taskIds 必须是数组");
  assert.deepEqual((await post("/tasks/memos", { taskIds: [] })).body, []);

  // 超批量上限**返 400，不截断** —— 跟 /tasks/follow-ups、/tasks/bodies 同一条规矩
  // (task-routes.ts overBatchLimit)。静默少返几行会被前端渲染成「还没读到」，一条
  // 永远不会消失的假状态：第 201 个任务明明记了备忘，列表里却永远空着。
  const over = await post("/tasks/memos", {
    taskIds: Array.from({ length: TASK_BATCH_LIMIT + 1 }, (_, at) => `x${at}`),
  });
  assert.equal(over.status, 400, "超限要拒绝而不是悄悄截断");
  assert.equal(over.body.limit, TASK_BATCH_LIMIT);
  assert.equal(over.body.requested, TASK_BATCH_LIMIT + 1);
  // 刚好压线的那一批照常受理。
  assert.equal(
    (await post("/tasks/memos", { taskIds: Array.from({ length: TASK_BATCH_LIMIT }, (_, at) => `x${at}`) })).status,
    200,
  );
}

// ── 请求体形状：合法 JSON 但不是对象 ────────────────────────────────────────
{
  // `null`(以及 3 / "x" / [])都是合法 JSON，解析得出来 —— 只兜 catch 的话随后在 null 上
  // 取属性，一条输入形状错误会被报成 500。四个入口都该是 400。
  const raw = (path: string, method: string, body: string) =>
    call(path, { method, headers: { "content-type": "application/json" }, body });
  const memo = (await call("/tasks/t1/memos")).body[0];
  for (const body of ["null", "3", '"x"', "[]"]) {
    assert.equal((await raw("/tasks/t1/memos", "POST", body)).status, 400, `POST ${body}`);
    assert.equal((await raw(`/tasks/t1/memos/${memo.id}`, "PATCH", body)).status, 400, `PATCH ${body}`);
    assert.equal((await raw("/tasks/memos", "POST", body)).status, 400, `摘要 ${body}`);
  }
}

// ── 删 ──────────────────────────────────────────────────────────────────────
{
  const rows = (await call("/tasks/t1/memos")).body;
  assert.equal((await call(`/tasks/t1/memos/${rows[0].id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/tasks/t1/memos/${rows[0].id}`, { method: "DELETE" })).status, 404, "删过的再删是 404");
  assert.equal((await call("/tasks/t1/memos")).body.length, 1);
  assert.equal((await db.select().from(taskMemos).where(eq(taskMemos.taskId, "t1"))).length, 1);
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ task memos");
