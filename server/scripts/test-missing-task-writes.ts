// 「任务不存在」时的写型端点:一律不许 2xx,一行都不许落库。
//
// 起因(第 2 轮审查 P2):`PUT /tasks/:id/schedule` 读了任务行却从不判空,于是拿一个
// 编出来的 id 打过去会 200,并插出一条挂在虚构任务上的班次 —— 调度器扫得到它,界面上
// 却没有任何任务能显示它;多人模式下它连个可见性锚点都没有(schedules 跟着任务/项目走)。
//
// 为什么是**一整组**而不是一条断言:横切闸对查不到的 id 是**刻意放行**的
// (`auth/resource-gate.ts` 末尾:它不知道该说「任务不存在」还是「分组不存在」,把 404
// 留给业务路由),所以每条 `/tasks/:id/...` 都得自己判空 —— 少判的那条就是下一个孤儿。
// 靠通读维护不住,这里按名单打一遍。
//
// 名单只收**写型**端点,且都是在任务不存在时应当立刻收口的(不真起进程、不碰 git)。
// 新加 `/tasks/:id/…` 的写端点时把它加进来:漏了不会红,加了才会钉住。
//
// 跑法(自带临时库):
//   npm -w server run test:missing-task-writes
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-missing-task-"));
process.env.ASH_DB ||= join(stage, "missing-task.db");
requireTmpDb("test-missing-task-writes");

// 碰库的模块一律等 ASH_DB 落定之后再 import(静态 import 会被提升到上面那句之前)。
const { db, ensureSchema } = await import("../src/db/index.js");
const schema = await import("../src/db/schema.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { api } = await import("../src/routes.js");

await ensureSchema();

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
app.route("/api", api);

const MISSING = "no-such-task-id";
const WRITES: { method: string; path: string; body?: unknown }[] = [
  { method: "PUT", path: "/schedule", body: { kind: "once", at: "2099-01-01T00:00:00.000Z" } },
  { method: "PUT", path: "/free-workflow/review-reservation", body: {} },
  { method: "POST", path: "/stage", body: { stage: "implemented" } },
  { method: "POST", path: "/gate", body: { decision: "approve" } },
  { method: "POST", path: "/archive", body: {} },
  { method: "POST", path: "/unarchive", body: {} },
  { method: "POST", path: "/pause", body: { resumePrompt: "x" } },
  { method: "POST", path: "/complete", body: {} },
  { method: "POST", path: "/ask", body: { question: "x" } },
  { method: "POST", path: "/answer", body: { answer: "x" } },
  { method: "POST", path: "/stop", body: {} },
  { method: "POST", path: "/requeue", body: {} },
  { method: "POST", path: "/retry", body: {} },
  { method: "POST", path: "/retry-turn", body: {} },
  { method: "PATCH", path: "", body: { title: "x" } },
  { method: "POST", path: "/accept", body: {} },
  { method: "DELETE", path: "/handoff" },
  { method: "POST", path: "/workflow/verify-override", body: {} },
  { method: "POST", path: "/free-workflow/review", body: {} },
  { method: "POST", path: "/review/dispatch", body: {} },
  { method: "POST", path: "/team/halt", body: {} },
  { method: "POST", path: "/team/iterate-duet", body: {} },
];

/** 全库每张表的行数。判「有没有落库」只能这么判:光看状态码放不过「403 但已经写进去了」。 */
async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(schema)) {
    if (!table || typeof table !== "object" || !("_" in (table as object))) continue;
    try { out[name] = (await db.select().from(table as never)).length; } catch { /* 不是表 */ }
  }
  return out;
}

const before = await rowCounts();
for (const w of WRITES) {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317/api/tasks/${MISSING}${w.path}`, {
    method: w.method,
    headers: { "content-type": "application/json" },
    body: w.body === undefined ? undefined : JSON.stringify(w.body),
  }));
  const text = await res.text();
  assert.ok(
    res.status < 200 || res.status >= 300,
    `${w.method} /tasks/:id${w.path} 对不存在的任务回了 ${res.status} —— 写型端点不该说「成功」:${text.slice(0, 200)}`,
  );
}
const after = await rowCounts();
for (const [table, count] of Object.entries(after)) {
  assert.equal(
    count, before[table] ?? 0,
    `任务不存在时不该有任何一行落库,但 ${table} 从 ${before[table] ?? 0} 变成了 ${count}`,
  );
}

console.log(`missing-task writes ok(${WRITES.length} 条端点)`);
await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
