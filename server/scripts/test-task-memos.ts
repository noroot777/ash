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

const [
  { db, ensureSchema }, schema, memoRoutes, { TASK_MEMO_MAX_LEN, TASK_MEMO_MAX_COUNT }, { TASK_BATCH_LIMIT },
] = await Promise.all([
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

/**
 * 把一发请求的正文**切成两段**送，中间留一个真实的 await 窗口给 `between` 跑。
 *
 * 这是「先查后写」那类缺口唯一的真复现方式：第一段送出之后 handler 已经过了开头那几道
 * 检查、正停在 `await bodyOf(c)` 上，`between` 这时才改库（删备忘、删任务），然后剩下
 * 半段才送完。普通的 `post`/`patch` 一次性把正文给齐，handler 根本没有停下来的时机。
 */
async function sendSplit(path: string, method: string, body: unknown, between: () => Promise<void>) {
  const payload = JSON.stringify(body);
  const encoder = new TextEncoder();
  let push: (chunk: string) => void = () => undefined;
  let done: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      done = () => controller.close();
    },
  });
  const pending = call(path, {
    method,
    headers: { "content-type": "application/json" },
    body: stream,
    // 流式请求体必须声明它（undici 的要求），否则 Request 根本构造不出来。
    duplex: "half",
  } as RequestInit);
  push(payload.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await between();
  push(payload.slice(10));
  done();
  return pending;
}
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
  // 时间戳只到毫秒,而上面那次 PATCH 可能跟下面这条新增落在同一刻 —— 那样「谁最新」就
  // 轮到按 id 定(服务端的确定性 tie-break),而 id 是随机的,这条用例会时绿时红。
  await new Promise((resolve) => setTimeout(resolve, 5));
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

// ── 条数上限:并发也不许越过 ─────────────────────────────────────────────────
{
  await db.insert(tasks).values({
    id: "t-cap", projectId: "p1", title: "cap", body: "", status: "done", mode: "single",
    createdAt: now(), updatedAt: now(),
  });
  // 先灌到离上限一条。直接写库(不走端点)是为了快,判据只在最后那几发上。
  const ts = now();
  await db.insert(taskMemos).values(Array.from({ length: TASK_MEMO_MAX_COUNT - 1 }, (_, at) => ({
    id: `cap-${at}`, taskId: "t-cap", body: `第 ${at} 条`, createdAt: ts, updatedAt: ts,
  })));

  // **并发**发两条:上限检查和插入要在同一个语句批里,否则两发都读到 499 然后都插进去。
  const [first, second] = await Promise.all([
    post("/tasks/t-cap/memos", { body: "压线那条" }),
    post("/tasks/t-cap/memos", { body: "越线那条" }),
  ]);
  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [201, 400], `一条进一条拒:${JSON.stringify(codes)}`);
  const rows = await db.select().from(taskMemos).where(eq(taskMemos.taskId, "t-cap"));
  assert.equal(rows.length, TASK_MEMO_MAX_COUNT, `库里不许超过上限:${rows.length}`);
  // 被拒那条要**一个字都没留下**(不是先插进去再报错)。
  const bodies = new Set(rows.map((row) => row.body));
  assert.equal([...bodies].filter((body) => body === "压线那条" || body === "越线那条").length, 1);

  // 满了之后再发照常 400。
  assert.equal((await post("/tasks/t-cap/memos", { body: "再来一条" })).status, 400);
}

// ── 删 ──────────────────────────────────────────────────────────────────────
{
  const rows = (await call("/tasks/t1/memos")).body;
  assert.equal((await call(`/tasks/t1/memos/${rows[0].id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/tasks/t1/memos/${rows[0].id}`, { method: "DELETE" })).status, 404, "删过的再删是 404");
  assert.equal((await call("/tasks/t1/memos")).body.length, 1);
  assert.equal((await db.select().from(taskMemos).where(eq(taskMemos.taskId, "t1"))).length, 1);
}

// ── 正文还在上传时任务被删掉：那一行不许留下来 ──────────────────────────────
{
  await db.insert(tasks).values({
    id: "t-gone", projectId: "p1", title: "t-gone", body: "",
    status: "done", mode: "single", createdAt: now(), updatedAt: now(),
  });
  // 正文上传期间把任务删掉（连它的备忘一起清，跟删任务那条路一样）。「先查后插」那种
  // 写法会在这里插进一行孤儿并回 201 —— 任务已经没了，界面上再也打不开它（第 2 位审查者
  // 第 2 轮 N2）。
  const late = await sendSplit("/tasks/t-gone/memos", "POST", { body: "任务已经没了，这条不该留下" }, async () => {
    await db.delete(taskMemos).where(eq(taskMemos.taskId, "t-gone"));
    await db.delete(tasks).where(eq(tasks.id, "t-gone"));
  });
  assert.equal(late.status, 404, `任务没了就不该留下这条备忘：${JSON.stringify(late.body)}`);
  const left = await db.select().from(taskMemos).where(eq(taskMemos.taskId, "t-gone"));
  assert.equal(left.length, 0, `孤儿行必须当场收走，库里还剩 ${left.length} 条`);
}

// ── 正文还在上传时这条备忘被删掉：回执不许谎称存上了 ─────────────────────────
{
  const created = await post("/tasks/t2/memos", { body: "原来那一版" });
  const memoId = created.body.id;
  // 这是另一个窗口按下的删除。改动端点开头查到过这条，不等于写下去的时候它还在。
  const late = await sendSplit(`/tasks/t2/memos/${memoId}`, "PATCH", { body: "改到一半的那几百字" }, async () => {
    assert.equal((await call(`/tasks/t2/memos/${memoId}`, { method: "DELETE" })).status, 200);
  });
  assert.equal(late.status, 404, `零行更新不许回 200：${JSON.stringify(late.body)}`);
  const rows = await db.select().from(taskMemos).where(eq(taskMemos.id, memoId));
  assert.equal(rows.length, 0, "不许把已经删掉的那条又写回来");
}

// ── 同一个缺口的另一条触发路径：正文还在上传时**父任务**被删掉 ───────────────
{
  await db.insert(tasks).values({
    id: "t-drop", projectId: "p1", title: "t-drop", body: "",
    status: "done", mode: "single", createdAt: now(), updatedAt: now(),
  });
  const created = await post("/tasks/t-drop/memos", { body: "父任务待删" });
  const late = await sendSplit(
    `/tasks/t-drop/memos/${created.body.id}`,
    "PATCH",
    { body: "父任务已经没了，这一版不该算存上" },
    async () => {
      // 删任务那条路会连着清备忘（task-delete-routes.ts），这里照它的效果来。
      await db.delete(taskMemos).where(eq(taskMemos.taskId, "t-drop"));
      await db.delete(tasks).where(eq(tasks.id, "t-drop"));
    },
  );
  assert.equal(late.status, 404, `父任务没了也不许回 200：${JSON.stringify(late.body)}`);
  assert.equal((await db.select().from(taskMemos).where(eq(taskMemos.taskId, "t-drop"))).length, 0);
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ task memos");
