// 「派它的那条任务」（tasks.dispatched_by）：存量回填认得出、新建时自动记上、显式给的能收，
// 团队那一套（执行者 parentId、调度台用 MCP 另建的任务）一处不碰。判据见 src/task-dispatch.ts。
// 跑：npm -w @navi/server run test:task-dispatched-by
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-dispatched-by-"));
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, appSettings } = await import("../src/db/schema.js");
const { backfillDispatchedBy, backfillDispatchedByAfterCopy, DISPATCHED_BY_BACKFILL_KEY } = await import("../src/db/migrate-dispatched-by.js");
const { createClient } = await import("../src/db/node-sqlite-client.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { dispatchWorkers } = await import("../src/team/dispatch.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
const at = new Date(Date.now() - 60_000).toISOString();
const backfillMark = async () => (await db.select().from(appSettings).where(eq(appSettings.key, DISPATCHED_BY_BACKFILL_KEY))).at(0)?.value ?? null;
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
  // 空库首启时回填已经跑过一遍、记下了边界；这里抹掉那条记录，当作老实例刚升级上来。
  assert.match(String(await backfillMark()), /"cutoff":/, "空库首启也记下边界");
  await db.delete(appSettings).where(eq(appSettings.key, DISPATCHED_BY_BACKFILL_KEY));
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
    row("team-exec", { parentId: "team", mode: "single" }),
    row("exec-made", { creationOrigin: origin("team-exec") }),
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
  assert.equal(await dispatchedOf("exec-made"), null, "团队执行者另建的任务不收：执行者详情里不冒出派出的任务");
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
  const fromAgent = await (await create({ title: "回合里派出去的" }, { "x-navi-source-task-id": "analysis", "x-navi-turn-token": "turn-a" })).json();
  assert.equal(fromAgent.dispatchedBy, "analysis");
  assert.equal(fromAgent.parentId ?? null, null, "派出去的任务不是团队执行者");
  await db.update(tasks).set({ status: "running", activeTurnToken: "turn-t" }).where(eq(tasks.id, "team"));
  await db.insert(sessions).values({ id: "s-team", taskId: "team", role: "lead", agentType: "claude", executor: "Claude", startedAt: at });
  const fromTeam = await (await create({ title: "调度台另建的" }, { "x-navi-source-task-id": "team", "x-navi-turn-token": "turn-t" })).json();
  assert.equal(fromTeam.dispatchedBy, null);
  const workers = await dispatchWorkers("team", [{ title: "团队执行者", body: "test" }], { run: false });
  assert.equal(workers.tasks[0].parentId, "team");
  assert.equal(workers.tasks[0].dispatchedBy ?? null, null, "团队派执行者：parentId 照旧，不记派活人");
  await db.update(tasks).set({ status: "running", activeTurnToken: "turn-e" }).where(eq(tasks.id, "team-exec"));
  await db.insert(sessions).values({ id: "s-exec", taskId: "team-exec", role: "single", agentType: "claude", executor: "Claude", startedAt: at });
  const fromExec = await (await create({ title: "执行者另建的" }, { "x-navi-source-task-id": "team-exec", "x-navi-turn-token": "turn-e" })).json();
  assert.equal(fromExec.creationOrigin?.taskId, "team-exec");
  assert.equal(fromExec.dispatchedBy, null, "团队执行者回合里建的任务不记在执行者名下");

  // —— 明确选了不归属（dispatchedBy:null / ""）：重启（回填再跑一遍）之后也不会被挂回来源名下。
  const optOut = await (await create({ title: "明确不归属", dispatchedBy: null }, { "x-navi-source-task-id": "analysis", "x-navi-turn-token": "turn-a" })).json();
  assert.equal(optOut.creationOrigin?.taskId, "analysis");
  assert.equal(optOut.dispatchedBy, null);
  const optOutBlank = await (await create({ title: "空串也算不归属", dispatchedBy: "" }, { "x-navi-source-task-id": "analysis", "x-navi-turn-token": "turn-a" })).json();
  assert.equal(optOutBlank.dispatchedBy, null);
  await backfillDispatchedBy(dbClient as never);
  assert.equal(await dispatchedOf(optOut.id), null, "重启之后，明确不归属的仍然不归属");
  assert.equal(await dispatchedOf(optOutBlank.id), null);
  // 不经 createTasks 直接写进库的老行（预览测试库开局从主库拷来、旧备份恢复）：边界早就记下了，
  // 下次启动照样认得出来；边界之后建的、明确不归属的，再跑多少遍都碰不到。
  const boundary = String(await backfillMark());
  await db.insert(tasks).values(row("copied-in", { creationOrigin: origin("analysis") }));
  await backfillDispatchedBy(dbClient as never);
  assert.equal(await dispatchedOf("copied-in"), "analysis", "边界之前的老行后来才写进库，下次启动补上");
  assert.equal(await dispatchedOf(optOut.id), null, "边界之后建的、明确不归属的，重跑也碰不到");
  assert.equal(String(await backfillMark()), boundary, "边界只在第一次记，之后不挪");

  // 预览测试库开局从主库拷任务：边界改用主库的。主库升级之后明确不归属的那条（晚于主库边界、
  // 早于预览库自己开局那一刻），不能在预览库里被挂回去；主库升级之前的老行照样补上。
  const offset = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
  const source = createClient({ url: join(root, "main.db") });
  await source.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  await source.execute({ sql: "INSERT INTO app_settings (key, value) VALUES (?, ?)", args: [DISPATCHED_BY_BACKFILL_KEY, JSON.stringify({ cutoff: offset(10) })] });
  await db.insert(tasks).values([
    row("main-legacy", { creationOrigin: origin("analysis"), createdAt: offset(5) }),
    row("main-opted-out", { creationOrigin: origin("analysis"), createdAt: offset(30) }),
  ]);
  assert.ok(boundary.includes("cutoff") && JSON.parse(boundary).cutoff > offset(30), "前提：预览库自己的边界晚于那条明确不归属的");
  await backfillDispatchedByAfterCopy(dbClient as never, source as never);
  source.close();
  assert.equal(await dispatchedOf("main-legacy"), "analysis", "主库升级之前的老行补上");
  assert.equal(await dispatchedOf("main-opted-out"), null, "主库升级之后明确不归属的，拷到预览库里也不被挂回去");
  assert.equal(JSON.parse(String(await backfillMark())).cutoff, offset(10), "边界换成主库的");

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
  const toExec = await create({ title: "挂到团队执行者底下", dispatchedBy: "team-exec" });
  assert.equal(toExec.status, 400, "团队执行者不当派活人");

  console.log("✓ 派它的那条任务：存量回填只碰升级前的行、随列表下发、回合里新建自动记上、显式指定与明确不归属、团队（含执行者）那一套不碰");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
