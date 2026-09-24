// 建任务时 `workflowMode` 的**默认值**是怎么定的。
//
// 这条以前是写死的 `preset`，于是同一件事从界面建和从 MCP/脚本建会落到两种模式上：
// 新建面板默认选 free，而 HTTP 调用方（MCP 的 batch_create_tasks / create_task_chain）
// 根本不知道有这个字段，拿到的一律是 preset —— preset 任务在界面上没有「派审查 / 打开
// 预览」入口（`FreeWorkflowToolbar` 第一行就整条返回 null），用户只看到一个功能被剪掉的
// 任务，却找不到原因。
//
// 这份回归盯的是改完之后的两件事，缺一不可：
// ① 普通单任务默认真的落 free（否则改了个寂寞）；
// ② **老调用方一个都不许被掀翻**——团队/讨论、派生执行者、审查任务、自带起手式的请求
//    都容不下 free，默认给它们 free 等于让它们凭空吃 409。默认值的判据必须就是门禁
//    那一份（`freeWorkflowFits`），两处各写一份早晚漂。
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

  // ── ② 显式给了就照给的来（默认值不许盖掉显式意图）──────────────────────
  const explicitPreset = await (await createTask({ workflowMode: "preset" })).json();
  assert.equal(explicitPreset.workflowMode, "preset", "显式 preset 不能被新默认值掀掉");
  assert.ok(explicitPreset.workflow, "preset 任务要拷一条起手式快照");

  // ── ③ 容不下 free 的四种请求：默认必须仍然是 preset，且不能 409 ──────────
  // 这四条就是路由门禁那四条。默认值但凡比门禁宽一点，这里就会从 201 变 409 ——
  // 而这些调用方（duet 接手、派生面板、审查任务、带起手式的新建）什么都没改。
  const team = await createTask({ mode: "team", title: "团队" });
  assert.equal(team.status, 201, `团队任务不能因为新默认值吃 ${team.status}`);
  assert.equal((await team.json()).workflowMode, "preset");

  const duet = await createTask({ mode: "duet", title: "讨论" });
  assert.equal(duet.status, 201, "讨论任务同样不能被新默认值掀翻");
  assert.equal((await duet.json()).workflowMode, "preset");

  const child = await createTask({ parentId: "parent", title: "执行者" });
  assert.equal(child.status, 201, "派生执行者不能被新默认值掀翻");
  assert.equal((await child.json()).workflowMode, "preset");

  const withPreset = await createTask({ workflowId: "standard", title: "自带起手式" });
  assert.equal(withPreset.status, 201, "自带起手式的请求不能被新默认值掀翻");
  const withPresetTask = await withPreset.json();
  assert.equal(withPresetTask.workflowMode, "preset", "给了 workflowId 就说明要走预设那条线");
  assert.ok(withPresetTask.workflow, "起手式必须真的拷进来，不能被默认值吃掉");

  // 就地改过的线（inline workflow）同理。
  const inline = await createTask({
    title: "就地改的线",
    workflow: { workspace: "isolated", steps: [{ id: "s1", kind: "run", p: {}, fail: null }] },
  });
  assert.equal(inline.status, 201);
  assert.equal((await inline.json()).workflowMode, "preset");

  // 显式 free + 起手式仍然是矛盾的（这条门禁一个字都没动）。
  const contradiction = await createTask({ workflowMode: "free", workflowId: "standard" });
  assert.equal(contradiction.status, 400);
  assert.match((await contradiction.json()).error, /不能同时携带起手式/);
  const teamFree = await createTask({ workflowMode: "free", mode: "team" });
  assert.equal(teamFree.status, 409);
  console.log("✓ 单任务:默认 free;显式不被盖;团队/讨论/派生/自带起手式仍是 preset 且不吃 409");

  // ── ④ 批量路由：同一份判据 ──────────────────────────────────────────────
  const batchPlain = await (await batch({ tasks: [{ title: "一" }, { title: "二" }] })).json();
  assert.deepEqual(
    batchPlain.tasks.map((t: { workflowMode: string }) => t.workflowMode),
    ["free", "free"],
    "批量建出来的普通单任务同样默认 free（MCP 走的就是这条路）",
  );
  assert.ok(batchPlain.tasks.every((t: { workflow: unknown }) => t.workflow === null));

  // defaults.workflowId = 这一批要走预设线 → 默认跟着变 preset。
  const batchPreset = await (await batch({
    tasks: [{ title: "三" }],
    defaults: { useWorktree: false, workflowId: "standard" },
  })).json();
  assert.equal(batchPreset.tasks[0].workflowMode, "preset");
  assert.ok(batchPreset.tasks[0].workflow, "批量这条路也要真的拷起手式");

  // 逐任务覆盖批次默认。
  const batchMixed = await (await batch({
    tasks: [{ title: "四" }, { title: "五", workflowMode: "free" }],
    defaults: { useWorktree: false, workflowMode: "preset" },
  })).json();
  assert.deepEqual(
    batchMixed.tasks.map((t: { workflowMode: string }) => t.workflowMode),
    ["preset", "free"],
    "任务自己的 workflowMode 要能盖住批次默认",
  );

  // 显式 free 撞上起手式：整批打回，不许静默丢掉其中一个 —— 丢了调用方会拿到一条
  // 没有验证站的任务而毫不知情。
  const batchConflict = await batch({
    tasks: [{ title: "六", workflowMode: "free" }],
    defaults: { useWorktree: false, workflowId: "standard" },
  });
  assert.equal(batchConflict.status, 400);
  assert.match((await batchConflict.json()).error, /不能同时携带起手式/);
  assert.equal(
    (await db.select().from(tasks)).filter((t) => t.title === "六").length,
    0,
    "整批打回就不能半插进去",
  );

  const batchBadMode = await batch({ tasks: [{ title: "七", workflowMode: "freee" }] });
  assert.equal(batchBadMode.status, 400);
  assert.match((await batchBadMode.json()).error, /只能是 free 或 preset/);
  console.log("✓ 批量:默认 free;defaults.workflowId 转 preset;逐任务可覆盖;free+起手式整批打回");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
