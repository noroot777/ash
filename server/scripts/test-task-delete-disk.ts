// 删任务之后收磁盘（run-dir-reclaim.ts）。第 1 轮审查 F3 的反例：目录删不掉时，页面报删除失败、
// 任务却已经没了，目录也再没人管。现在钉三件事：
//   磁盘失败不算删除失败——接口照常 200，如实列出哪几个没收干净，任务行确实删了；
//   没收干净的留下持久待办，后台重试能把它收掉、撕掉待办；
//   任务行还在的待办（删行那一步失败、或进程死在中间）只撤待办，什么都不删。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-task-delete-disk-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const runs = process.env.ASH_RUNS_DIR;
const locked: string[] = [];

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { mountTaskDeleteRoutes } = await import("../src/task-delete-routes.js");
  const { markTaskDiskPending, sweepPendingTaskDisk } = await import("../src/run-dir-reclaim.js");
  const { eq } = await import("drizzle-orm");
  const { Hono } = await import("hono");
  await ensureSchema();

  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: join(root, "repo"), createdAt: stamp });
  const task = (id: string) => db.insert(tasks).values({ id, projectId: "p", title: id, status: "done", createdAt: stamp, updatedAt: stamp });
  const pending = (id: string) => join(runs, ".pending-delete", id);
  const api = new Hono();
  mountTaskDeleteRoutes(api);

  // ── 能删干净的：不留待办 ──
  await task("clean");
  mkdirSync(join(runs, "clean"), { recursive: true });
  writeFileSync(join(runs, "clean", "s.md"), "正文");
  const ok = await api.request("/tasks/clean", { method: "DELETE" });
  const okBody = await ok.json() as { diskCleanupPending?: string[] };
  assert.equal(ok.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.diskCleanupPending, undefined);
  assert.equal(existsSync(join(runs, "clean")), false);
  assert.equal(existsSync(pending("clean")), false);

  // ── 删不掉的：照样 200、任务行没了、待办留着 ──
  await task("stuck");
  const inner = join(runs, "stuck", "session");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "s.md"), "正文");
  chmodSync(inner, 0o500);
  locked.push(inner);
  const response = await api.request("/tasks/stuck", { method: "DELETE" });
  assert.equal(response.status, 200, "任务行已经删掉，磁盘失败不能报成删除失败");
  const body = await response.json() as { deleted: boolean; diskCleanupPending?: string[] };
  assert.equal(body.deleted, true);
  assert.deepEqual(body.diskCleanupPending, ["stuck"], "如实说出哪个没收干净");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "stuck"))).length, 0);
  assert.equal(existsSync(join(runs, "stuck")), true);
  assert.equal(existsSync(pending("stuck")), true, "留下持久待办");

  // 还删不掉时重试也不撕待办。
  assert.equal(await sweepPendingTaskDisk(), 0);
  assert.equal(existsSync(pending("stuck")), true);

  // ── 放开之后后台重试收掉 ──
  chmodSync(inner, 0o700);
  locked.length = 0;
  assert.equal(await sweepPendingTaskDisk(), 1);
  assert.equal(existsSync(join(runs, "stuck")), false, "重试把目录收掉");
  assert.equal(existsSync(pending("stuck")), false, "收干净才撕待办");

  // ── 任务还在的待办：只撤待办，不碰目录 ──
  await task("alive");
  mkdirSync(join(runs, "alive"), { recursive: true });
  writeFileSync(join(runs, "alive", "s.md"), "正文");
  markTaskDiskPending("alive");
  assert.equal(await sweepPendingTaskDisk(), 0);
  assert.equal(existsSync(join(runs, "alive", "s.md")), true, "任务还在，目录一个字节都不动");
  assert.equal(existsSync(pending("alive")), false);

  console.log("task delete disk: ok");
} finally {
  for (const dir of locked) chmodSync(dir, 0o700);
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
