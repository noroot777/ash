// 可以派出去的活的三道边界（主链路在 test-dispatch-suggestion.ts）：
//   · 派出去的新任务归点「派出去」的人：共享项目里 Bob 在 Alice 的任务上选了自己的非默认执行器，新任务就交给它，
//     不按 Alice 看得见的那一份核成 null、悄悄落到 Bob 的默认执行器上；
//   · 智能体挂建议：入口核过回合与方向之后、真写进去之前，用户补了新要求（方向换了）或任务停了——这一批不挂，
//     回 409；两处时机各钉一次：查执行器的空档里、读完建议列正要写的那一刻；
//   · 补了图再派：图的归属跟建任务同一笔。归属写不进去整笔不落（没有新任务、建议还在）；写得进去时回包之前
//     就已经归到新任务上。
//
// 跑：npm -w @navi/server run test:dispatch-suggestion（跟主链路那份串着跑）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";
import { installExitingClis } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "navi-dispatch-suggestion-guards-"));
const originalPath = process.env.PATH;
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.env.NAVI_UPLOADS_DIR = join(root, "uploads");
const fakeBin = join(root, "bin");
mkdirSync(fakeBin);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
await installExitingClis(fakeBin, ["claude", "codex"]);

const [{ db, dbClient, ensureSchema }, schema, mode, store, context, routes] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/auth/mode.js"),
  import("../src/auth/store.js"),
  import("../src/auth/context.js"),
  import("../src/dispatch-suggestion-routes.js"),
]);
const { agents, projects, tasks, uploads } = schema;
await ensureSchema();
await mode.setInstanceMode("multi", join(root, "users"), true);
const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "Alice", gitEmail: "alice@example.test", createdBy: null });
const bob = await store.createUser({ name: "bob", role: "member", dirName: "bob", gitName: "Bob", gitEmail: "bob@example.test", createdBy: null });

const api = new Hono();
let actor: { userId: string; name: string } = { userId: bob.id, name: "bob" };
api.use("*", async (c, next) => { context.setActor(c, { kind: "user", userId: actor.userId, role: "member", name: actor.name }); await next(); });
routes.mountDispatchSuggestionRoutes(api);

const at = new Date(Date.now() - 60_000).toISOString();
await db.insert(projects).values({ id: "p1", name: "shared", repoPath: root, createdAt: at, useWorktreeDefault: false });
await db.insert(agents).values([
  { id: "alice-codex", name: "Alice codex", type: "codex", ownerUserId: alice.id, isDefault: true },
  { id: "bob-default", name: "Bob codex", type: "codex", ownerUserId: bob.id, isDefault: true },
  { id: "bob-chosen", name: "Bob codex（另一套）", type: "codex", ownerUserId: bob.id, isDefault: false },
]);
const suggestion = (id: string) => ({ id, title: `建议 ${id}`, body: "完整说明", note: "", target: null, base: "trunk", proposedAt: at, turnToken: null });
const insertTask = (id: string, extra: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({
  id, projectId: "p1", title: `任务 ${id}`, body: "改输入框高度", ownerUserId: alice.id, mode: "single", status: "done",
  agentType: "codex", labels: "[]", dependsOn: "[]", createdAt: at, updatedAt: at, ...extra,
});
const send = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await api.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const childrenOf = async (id: string) => db.select().from(tasks).where(eq(tasks.dispatchedBy, id));
const launchItem = (id: string, executorId: string | null) => ({
  id, title: `建议 ${id}`, body: "完整说明", target: { agentType: "codex", executorId, model: null, reasoningEffort: null }, worktreeBase: null,
});

/**
 * 在下一次「从 `table` 读」/「写 `table`」真正落到库上之前插一手（只插一次）。drizzle 的查询是链式拼好、await 时
 * 才执行，所以把整条链包起来，等到 then 被调的那一刻先跑 `before`。
 */
function holdOnce<T extends object>(builder: T, before: () => Promise<void>): T {
  return new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === "then" && typeof value === "function") {
        return (ok: unknown, ko: unknown) => before().then(() => (value as (a: unknown, b: unknown) => unknown).call(target, ok, ko));
      }
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const next = (value as (...a: unknown[]) => unknown).apply(target, args);
        return next && typeof next === "object" ? holdOnce(next, before) : next;
      };
    },
  });
}
function beforeNextRead(table: unknown, before: () => Promise<void>): () => boolean {
  const select = db.select.bind(db);
  let fired = false;
  db.select = ((...args: Parameters<typeof select>) => {
    const builder = select(...args);
    const from = builder.from.bind(builder);
    builder.from = ((source: never) => {
      const query = from(source);
      if (source !== table || fired) return query;
      fired = true;
      db.select = select;
      return holdOnce(query, before);
    }) as typeof builder.from;
    return builder;
  }) as typeof db.select;
  return () => fired;
}
function beforeNextWrite(table: unknown, before: () => Promise<void>): () => boolean {
  const update = db.update.bind(db);
  let fired = false;
  db.update = ((target: never) => {
    const builder = update(target);
    if (target !== table || fired) return builder;
    fired = true;
    db.update = update;
    return holdOnce(builder, before);
  }) as typeof db.update;
  return () => fired;
}

try {
  // —— 一、交给谁按点「派出去」的人核 ——
  await insertTask("shared", { dispatchSuggestions: JSON.stringify([suggestion("s-bob"), suggestion("s-alien")]) });
  const picked = await send("/tasks/shared/dispatch-suggestions/launch", { items: [launchItem("s-bob", "bob-chosen")] });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  const [child] = await childrenOf("shared");
  assert.equal(child?.ownerUserId, bob.id, "新任务归点派出去的人");
  assert.equal(child?.executorId, "bob-chosen", "他明确选的非默认执行器原样落下，不被来源任务归属人的那一份核掉");
  // 反过来：他看不见的执行器（Alice 的）照旧核成 null，按类型默认降级——授权口径没被放宽。
  const alien = await send("/tasks/shared/dispatch-suggestions/launch", { items: [launchItem("s-alien", "alice-codex")] });
  assert.equal(alien.status, 200, JSON.stringify(alien.body));
  const second = (await childrenOf("shared")).find((row) => row.id !== child!.id);
  assert.equal(second?.executorId ?? null, null, "别人的执行器 id 不跟着落进自己名下的任务");

  // —— 二、挂建议：核过身份之后方向换了 / 任务停了，这一批不挂 ——
  const turnHeaders = { "x-navi-turn-token": "turn-old", "x-navi-direction-token": "dir-old" };
  const post = (id: string) => send(`/tasks/${id}/dispatch-suggestions`, { tasks: [{ title: "旧方向下的建议", body: "不该挂出来", note: "边界" }] }, turnHeaders);
  const running = { status: "running", activeTurnToken: "turn-old", activeDirectionToken: "dir-old" } as const;

  // ① 查执行器的空档里用户补了新要求。
  await insertTask("race-scope", running);
  const scopeHeld = beforeNextRead(agents, async () => {
    await dbClient.execute("UPDATE tasks SET active_direction_token = 'dir-new' WHERE id = 'race-scope'");
  });
  const raced = await post("race-scope");
  assert.ok(scopeHeld(), "确实停在查执行器那一下");
  assert.equal(raced.status, 409, JSON.stringify(raced.body));
  assert.equal((await taskOf("race-scope")).dispatchSuggestions, null, "旧方向的建议没挂上去");

  // ② 读完建议列、正要写的那一刻任务停了（回合也随之结束）。
  await insertTask("race-write", running);
  const writeHeld = beforeNextWrite(tasks, async () => {
    await dbClient.execute("UPDATE tasks SET status = 'done', active_turn_token = NULL, active_direction_token = NULL WHERE id = 'race-write'");
  });
  const stopped = await post("race-write");
  assert.ok(writeHeld(), "确实停在写建议列那一下");
  assert.equal(stopped.status, 409, JSON.stringify(stopped.body));
  assert.equal((await taskOf("race-write")).dispatchSuggestions, null, "停了之后不再落下这一轮的建议");

  // 对照：身份一路没变就照常挂上。
  await insertTask("steady", running);
  const steady = await post("steady");
  assert.equal(steady.status, 200, JSON.stringify(steady.body));
  assert.equal(JSON.parse((await taskOf("steady")).dispatchSuggestions ?? "[]").length, 1);

  // —— 三、补了图再派：图的归属跟建任务同一笔 ——
  await insertTask("pictured", { dispatchSuggestions: JSON.stringify([suggestion("s-pic")]) });
  await db.insert(uploads).values({ file: "shot.png", ownerUserId: bob.id, taskId: null, createdAt: at });
  const withPicture = { items: [{ ...launchItem("s-pic", null), extra: "看图" }], attachments: ["shot.png"] };
  await dbClient.execute("CREATE TRIGGER fixture_bind_fails BEFORE UPDATE ON uploads BEGIN SELECT RAISE(ABORT, '写盘失败（夹具）'); END");
  const failed = await send("/tasks/pictured/dispatch-suggestions/launch", withPicture);
  assert.equal(failed.status, 409, JSON.stringify(failed.body));
  assert.deepEqual(await childrenOf("pictured"), [], "图归属写不进去：整笔不落，没有新任务");
  assert.equal(JSON.parse((await taskOf("pictured")).dispatchSuggestions ?? "[]").length, 1, "建议原样还在，能再按一次");
  await dbClient.execute("DROP TRIGGER fixture_bind_fails");
  const bound = await send("/tasks/pictured/dispatch-suggestions/launch", withPicture);
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  const [pictured] = await childrenOf("pictured");
  const upload = (await db.select().from(uploads).where(eq(uploads.file, "shot.png"))).at(0);
  assert.equal(upload?.taskId, pictured?.id, "回包之前图已经归到新任务上");

  console.log("dispatch suggestion guards test passed");
} finally {
  process.env.PATH = originalPath;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
