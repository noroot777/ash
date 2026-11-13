// 建任务时 `workflowMode` 落哪种、什么请求要拒（`createWorkflowMode`）。
//
// 起手式（preset）已停止新建（2026-11-13）：
// ① 外部新建的顶层单任务一律是 free；显式要 preset、带 workflow / workflowId 的都拒，
//    并说清原因——静默改成 free 的话，调用方以为拿到了一条带验证站的线；
// ② 团队/讨论、派生执行者、审查任务在内部照旧落 preset（团队执行者的自动派审跑在这条线
//    上），默认值不许把它们掀成 free，也不许让它们吃 409；
// ③ 批量路由（MCP 的 batch_create_tasks / create_task_chain 走这条）同一份判据，整批打回
//    时不半插进去。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-workflow-mode-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, groups } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
await ensureSchema();

const api = new Hono();
mountTaskRoutes(api);
mountGroupRoutes(api);
const at = new Date().toISOString();

const post = (path: string, body: Record<string, unknown>) => api.request(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const createTask = (body: Record<string, unknown> = {}) =>
  post("/tasks", { projectId: "p", title: "t", useWorktree: false, ...body });
const batch = (body: Record<string, unknown>) =>
  post("/groups/g/tasks/batch", { defaults: { useWorktree: false }, ...body });

try {
  await db.insert(projects).values({ id: "p", name: "默认工作方式", repoPath: root, createdAt: at });
  await db.insert(tasks).values({ id: "parent", projectId: "p", title: "父", body: "", agentType: "claude", mode: "team", status: "idle", createdAt: at, updatedAt: at });
  await db.insert(groups).values({ id: "g", projectId: "p", name: "批次", mode: "parallel", createdAt: at });

  // ── ① 普通单任务：没说就是 free ─────────────────────────────────────────
  const plain = await (await createTask()).json();
  assert.equal(plain.workflowMode, "free", "普通单任务不传 workflowMode 时必须默认 free");
  // free 任务身上不该挂起手式快照：createTasks 会把它置空，这是「真的是 free」而不是
  // 「字段写了 free、线还在身上」的证据。
  assert.equal(plain.workflow, null, "free 任务不该带起手式快照");

  // ── ② 顶层单任务要起手式：一律拒，说清楚为什么 ─────────────────────────
  for (const [label, body] of [
    ["显式 preset", { workflowMode: "preset" }],
    ["带 workflowId", { workflowId: "standard" }],
    ["就地改的线", { workflow: { workspace: "isolated", steps: [{ id: "s1", kind: "run", p: {}, fail: null }] } }],
    ["free + 起手式", { workflowMode: "free", workflowId: "standard" }],
  ] as const) {
    const res = await createTask({ title: label, ...body });
    assert.equal(res.status, 409, `${label} 必须被拒`);
    assert.match((await res.json()).error, /起手式（预设工作流）已停止新建/, `${label} 要说清原因`);
  }
  assert.equal(
    (await db.select().from(tasks)).filter((t) => t.workflowMode === "preset" && t.mode === "single" && !t.parentId).length,
    0,
    "被拒的请求一条都不能落库",
  );

  // ── ③ 内部那几类：默认仍是 preset，且不能 409 ───────────────────────────
  const team = await createTask({ mode: "team", title: "团队" });
  assert.equal(team.status, 201, `团队任务不能吃 ${team.status}`);
  assert.equal((await team.json()).workflowMode, "preset");

  const duet = await createTask({ mode: "duet", title: "讨论" });
  assert.equal(duet.status, 201, "讨论任务不能被掀翻");
  assert.equal((await duet.json()).workflowMode, "preset");

  const child = await createTask({ parentId: "parent", title: "执行者" });
  assert.equal(child.status, 201, "派生执行者不能被掀翻");
  const childTask = await child.json();
  assert.equal(childTask.workflowMode, "preset");
  assert.ok(childTask.workflow, "派生执行者照旧拷一条起手式快照");

  const childWithLine = await createTask({ parentId: "parent", title: "带线的执行者", workflowId: "standard" });
  assert.equal(childWithLine.status, 201, "内部建的 preset 任务照旧能指定起手式");

  const teamFree = await createTask({ workflowMode: "free", mode: "team" });
  assert.equal(teamFree.status, 409);
  assert.match((await teamFree.json()).error, /只适用于普通单任务/);
  const badMode = await createTask({ workflowMode: "freee" });
  assert.equal(badMode.status, 400);
  console.log("✓ 单任务:默认 free;要起手式一律 409 并说明;团队/讨论/派生仍是 preset 且不吃 409");

  // ── ④ 批量路由：同一份判据 ──────────────────────────────────────────────
  const batchPlain = await (await batch({ tasks: [{ title: "一" }, { title: "二" }] })).json();
  assert.deepEqual(
    batchPlain.tasks.map((t: { workflowMode: string }) => t.workflowMode),
    ["free", "free"],
    "批量建出来的普通单任务同样默认 free（MCP 走的就是这条路）",
  );
  assert.ok(batchPlain.tasks.every((t: { workflow: unknown }) => t.workflow === null));

  // 要起手式的整批打回，不半插进去 —— 批次默认和逐任务两种写法都拦。
  for (const [label, body] of [
    ["defaults.workflowId", { tasks: [{ title: "三" }], defaults: { useWorktree: false, workflowId: "standard" } }],
    ["defaults.workflowMode", { tasks: [{ title: "四" }], defaults: { useWorktree: false, workflowMode: "preset" } }],
    ["逐任务 preset", { tasks: [{ title: "五" }, { title: "六", workflowMode: "preset" }] }],
    ["free + 起手式", { tasks: [{ title: "七", workflowMode: "free", workflowId: "standard" }] }],
  ] as const) {
    const res = await batch(body);
    assert.equal(res.status, 409, `批量 ${label} 必须被拒`);
    assert.match((await res.json()).error, /^tasks\[\d\]: 起手式（预设工作流）已停止新建/, `批量 ${label} 要指明哪一条、为什么`);
  }
  assert.equal(
    (await db.select().from(tasks)).filter((t) => ["三", "四", "五", "六", "七"].includes(t.title)).length,
    0,
    "整批打回就不能半插进去",
  );

  const batchBadMode = await batch({ tasks: [{ title: "八", workflowMode: "freee" }] });
  assert.equal(batchBadMode.status, 400);
  assert.match((await batchBadMode.json()).error, /只能是 free 或 preset/);
  console.log("✓ 批量:默认 free;要起手式整批打回并说明;非法值 400");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
