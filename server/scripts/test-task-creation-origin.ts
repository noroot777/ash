import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { parseTaskCreationOrigin, taskCreationLabel } from "@ash/shared/task-origin";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-origin-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, groups } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { dispatchWorkers } = await import("../src/team/dispatch.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
mountGroupRoutes(api);
const at = new Date().toISOString();
const source = "source-agent";
const headers = { "x-ash-source-task-id": source, "x-ash-turn-token": "source-turn" };
const create = (body: Record<string, unknown> = {}, identity: Record<string, string> = {}) => api.request("/tasks", {
  method: "POST", headers: { "content-type": "application/json", ...identity },
  body: JSON.stringify({ projectId: "project", title: "用户新建", useWorktree: false, ...body }),
});
try {
  await db.insert(projects).values({ id: "project", name: "来源验证", repoPath: root, createdAt: at });
  await db.insert(tasks).values({ id: source, projectId: "project", title: "父任务", body: "", agentType: "claude", status: "running", activeTurnToken: "source-turn", createdAt: at, updatedAt: at });
  await db.insert(sessions).values({ id: "source-session", taskId: source, role: "single", agentType: "codex", executor: "Codex Dev", startedAt: at });
  const user = await (await create({ creationOrigin: { kind: "agent", agentType: "fake" } })).json();
  assert.deepEqual(user.creationOrigin, { kind: "user" }, "client body cannot forge the creator");
  const userDerived = await (await create({ title: "用户从父任务派生", originTaskId: source })).json();
  assert.deepEqual(userDerived.creationOrigin, { kind: "user" }, "a source relationship does not mean an agent created the task");
  const derived = await (await create({ title: "Codex 派生的任务", agentType: "claude" }, headers)).json();
  assert.deepEqual(derived.creationOrigin, { kind: "agent", taskId: source, taskTitle: "父任务", agentType: "codex", executorLabel: "Codex Dev" });
  assert.equal(derived.agentType, "claude", "worker identity stays independent of its creator");
  const stale = await create({}, { ...headers, "x-ash-turn-token": "stale" });
  assert.equal(stale.status, 409);
  assert.match(stale.headers.get("content-type")!, /application\/json/);
  assert.match((await stale.json()).error, /回合身份已过期/);
  const missing = await create({}, { ...headers, "x-ash-source-task-id": "missing-source" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "来源任务不存在" });
  const external = await (await create({ title: "外部智能体创建" }, { "x-ash-client": "mcp" })).json();
  assert.deepEqual(external.creationOrigin, { kind: "agent" });
  assert.equal(taskCreationLabel(external.creationOrigin), "智能体创建");
  assert.equal(taskCreationLabel({ kind: "agent", taskId: source }), "智能体派生");
  assert.equal(taskCreationLabel(derived.creationOrigin), "Codex 派生");
  assert.equal(taskCreationLabel(parseTaskCreationOrigin(null)), "来源未记录");
  assert.equal(taskCreationLabel(parseTaskCreationOrigin("broken")), "来源未记录");
  await db.insert(groups).values({ id: "origin-batch", projectId: "project", name: "batch", mode: "parallel", createdAt: at });
  const batch = await (await api.request("/groups/origin-batch/tasks/batch", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ tasks: [{ title: "一" }, { title: "二" }], defaults: { useWorktree: false } }),
  })).json();
  assert.equal(batch.tasks.length, 2);
  assert.ok(batch.tasks.every((t: typeof derived) => t.creationOrigin.agentType === "codex"));
  await db.update(tasks).set({ mode: "team", status: "idle" }).where(eq(tasks.id, source));
  await db.update(sessions).set({ role: "lead" }).where(eq(sessions.id, "source-session"));
  const workers = await dispatchWorkers(source, [{ title: "团队执行者", body: "test" }], { run: false });
  assert.deepEqual(workers.tasks[0].creationOrigin, derived.creationOrigin);
  await db.update(tasks).set({ title: "父任务已改名", agentType: "claude" }).where(eq(tasks.id, source));
  await db.update(sessions).set({ executor: "另一执行器" }).where(eq(sessions.id, "source-session"));
  const reloaded = await (await api.request(`/tasks/${derived.id}`)).json();
  assert.deepEqual(reloaded.creationOrigin, derived.creationOrigin, "creator snapshot survives later task/profile changes");
  await api.request(`/tasks/${derived.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ creationOrigin: { kind: "user" } }) });
  assert.deepEqual((await (await api.request(`/tasks/${derived.id}`)).json()).creationOrigin, derived.creationOrigin, "PATCH cannot rewrite creation provenance");
  const legacy = await (await api.request(`/tasks/${source}`)).json();
  assert.equal(legacy.creationOrigin, null, "legacy task is not silently labeled user-created");
  console.log("✓ user vs agent, user derivation, actual source session vs worker, stale identity, external MCP, batch, team dispatch, immutable provenance, legacy unknown");
  if (process.argv.includes("--serve")) {
    const { serve } = await import("@hono/node-server");
    const server = serve({ fetch: new Hono().route("/api", api).fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { createServer } = await import("vite");
    const web = await createServer({ root: join(process.cwd(), "web"), logLevel: "error", server: { host: "127.0.0.1", port: 0, proxy: { "/api": `http://127.0.0.1:${address.port}` } } });
    await web.listen();
    const webAddress = web.httpServer!.address();
    assert.ok(webAddress && typeof webAddress === "object");
    console.log(JSON.stringify({ pid: process.pid, root, url: `http://127.0.0.1:${webAddress.port}/scripts/fixtures/task-creation-origin.html` }));
    await new Promise<void>(resolve => {
      process.once("SIGTERM", resolve); process.once("SIGINT", resolve);
      process.on("message", message => { if (message === "close-fixture") resolve(); });
    });
    await web.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.connected) process.disconnect();
  }
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
