// 「派它的那条任务」（tasks.dispatched_by）：存量回填认得出、新建时自动记上、显式给的能收，
// 团队那一套（执行者 parentId、调度台用 MCP 另建的任务）一处不碰。判据见 src/task-dispatch.ts。
// 跑：npm -w @ash/server run test:task-dispatched-by
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-dispatched-by-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions } = await import("../src/db/schema.js");
const { backfillDispatchedBy } = await import("../src/db/migrate-dispatched-by.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { dispatchWorkers } = await import("../src/team/dispatch.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
const at = new Date().toISOString();
const origin = (taskId: string) => JSON.stringify({ kind: "agent", taskId, agentType: "claude" });
const row = (id: string, extra: Partial<typeof tasks.$inferInsert> = {}) => ({
  id, projectId: "project", title: id, body: "", agentType: "claude" as const, createdAt: at, updatedAt: at, ...extra,
});
const dispatchedOf = async (id: string) => (await db.select({ v: tasks.dispatchedBy }).from(tasks).where(eq(tasks.id, id))).at(0)?.v ?? null;
const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) => api.request("/tasks", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ projectId: "project", useWorktree: false, ...body }),
});

try {
  await db.insert(projects).values({ id: "project", name: "派活归属", repoPath: root, createdAt: at });

  // —— 存量：升级前派出去的任务只在 creation_origin 里记着来源，回填之后收在派它的那条下面。
  await db.insert(tasks).values([
    row("analysis"),
    row("legacy-1", { creationOrigin: origin("analysis") }),
    row("legacy-2", { creationOrigin: origin("analysis") }),
    row("grandchild", { creationOrigin: origin("legacy-1") }),
    row("team", { mode: "team" }),
    row("team-worker", { parentId: "team", creationOrigin: origin("team") }),
    row("team-made", { creationOrigin: origin("team") }),
    row("duet-made", { mode: "duet", creationOrigin: origin("analysis") }),
    row("worker-in-single", { parentId: "analysis", creationOrigin: origin("analysis") }),
    row("self", { creationOrigin: origin("self") }),
    row("gone-source", { creationOrigin: origin("deleted-task") }),
    row("user-made", { creationOrigin: JSON.stringify({ kind: "user" }) }),
    row("broken", { creationOrigin: "not json" }),
    row("already", { creationOrigin: origin("analysis"), dispatchedBy: "legacy-2" }),
  ]);
  await backfillDispatchedBy(dbClient as never);
  assert.equal(await dispatchedOf("legacy-1"), "analysis", "普通任务里派出去的存量任务认得出");
  assert.equal(await dispatchedOf("legacy-2"), "analysis");
  assert.equal(await dispatchedOf("grandchild"), "legacy-1", "派出去的任务自己又派的，收在它自己下面");
  assert.equal(await dispatchedOf("team-worker"), null, "团队执行者归它的团队（parentId），不收第二层");
  assert.equal(await dispatchedOf("team-made"), null, "团队调度台另建的任务不收：团队在侧栏的样子不动");
  assert.equal(await dispatchedOf("duet-made"), null, "讨论任务不收");
  assert.equal(await dispatchedOf("worker-in-single"), null, "有 parentId 的一律不收");
  assert.equal(await dispatchedOf("self"), null);
  assert.equal(await dispatchedOf("gone-source"), null, "来源任务已经删了，不挂一个指向空处的归属");
  assert.equal(await dispatchedOf("user-made"), null);
  assert.equal(await dispatchedOf("broken"), null, "来源记录坏了也不报错");
  assert.equal(await dispatchedOf("already"), "legacy-2", "已经有归属的不覆盖");
  await backfillDispatchedBy(dbClient as never);
  assert.equal(await dispatchedOf("legacy-1"), "analysis", "幂等");

  // —— 随任务列表一起下发，不用一行一请求。
  const list = await (await api.request("/tasks")).json() as { id: string; dispatchedBy: string | null }[];
  const byId = new Map(list.map((task) => [task.id, task]));
  assert.equal(byId.get("legacy-1")?.dispatchedBy, "analysis");
  assert.equal(byId.get("team-worker")?.dispatchedBy, null);
  const detail = await (await api.request("/tasks/legacy-2")).json();
  assert.equal(detail.dispatchedBy, "analysis", "单条详情也带");

  // —— 新建：智能体在普通任务的回合里建的，自动记上；在团队调度台里建的，不记。
  await db.update(tasks).set({ status: "running", activeTurnToken: "turn-a" }).where(eq(tasks.id, "analysis"));
  await db.insert(sessions).values({ id: "s-analysis", taskId: "analysis", role: "single", agentType: "codex", executor: "Codex", startedAt: at });
  const fromAgent = await (await create({ title: "回合里派出去的" }, { "x-ash-source-task-id": "analysis", "x-ash-turn-token": "turn-a" })).json();
  assert.equal(fromAgent.dispatchedBy, "analysis");
  assert.equal(fromAgent.parentId ?? null, null, "派出去的任务不是团队执行者");
  await db.update(tasks).set({ status: "running", activeTurnToken: "turn-t" }).where(eq(tasks.id, "team"));
  await db.insert(sessions).values({ id: "s-team", taskId: "team", role: "lead", agentType: "claude", executor: "Claude", startedAt: at });
  const fromTeam = await (await create({ title: "调度台另建的" }, { "x-ash-source-task-id": "team", "x-ash-turn-token": "turn-t" })).json();
  assert.equal(fromTeam.dispatchedBy, null);
  const workers = await dispatchWorkers("team", [{ title: "团队执行者", body: "test" }], { run: false });
  assert.equal(workers.tasks[0].parentId, "team");
  assert.equal(workers.tasks[0].dispatchedBy ?? null, null, "团队派执行者：parentId 照旧，不记派活人");

  // —— 显式指定派活人（回复框派出去的入口，界面在后面的任务里接）。
  const explicit = await (await create({ title: "显式归属", dispatchedBy: "legacy-1" })).json();
  assert.equal(explicit.dispatchedBy, "legacy-1");
  const missing = await create({ title: "派活人不存在", dispatchedBy: "nope" });
  assert.equal(missing.status, 404);
  const toTeam = await create({ title: "挂到团队底下", dispatchedBy: "team" });
  assert.equal(toTeam.status, 400, "团队不收派出去的普通任务");
  const asWorker = await create({ title: "执行者挂两层", dispatchedBy: "analysis", parentId: "team" });
  assert.equal(asWorker.status, 400);
  const asDuet = await create({ title: "讨论挂进来", dispatchedBy: "analysis", mode: "duet" });
  assert.equal(asDuet.status, 400);

  console.log("✓ 派它的那条任务：存量回填、随列表下发、回合里新建自动记上、显式指定、团队那一套不碰");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
