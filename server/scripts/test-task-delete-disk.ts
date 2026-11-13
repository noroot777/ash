// 删任务之后收磁盘（run-dir-reclaim.ts）。钉的是第 1、2 轮审查 F3/F2 那组反例：
//   清理责任跟删任务行同一个原子批提交——任务删成了就一定有账，删不成就一定没有；
//   磁盘失败不算删除失败：接口照常 200，如实列出哪几个没收干净；
//   账只在磁盘真收干净后销掉，收不掉记下次数和原因、后台重试；
//   清理层出任何错（账写不上）都不改写已经提交的删除结果；
//   同一个 id 又有了任务行（接力迁回本机）：账作废、目录一个字节不动。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-task-delete-disk-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const runs = process.env.ASH_RUNS_DIR;
const locked: string[] = [];
const lock = (dir: string) => { chmodSync(dir, 0o500); locked.push(dir); };
const unlockAll = () => { for (const dir of locked.splice(0)) chmodSync(dir, 0o700); };

try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, taskDiskCleanups } = await import("../src/db/schema.js");
  const { deleteTaskCompletely, mountTaskDeleteRoutes } = await import("../src/task-delete-routes.js");
  const { sweepPendingTaskDisk } = await import("../src/run-dir-reclaim.js");
  const { eq } = await import("drizzle-orm");
  const { Hono } = await import("hono");
  await ensureSchema();

  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: join(root, "repo"), createdAt: stamp });
  const task = (id: string) => db.insert(tasks).values({ id, projectId: "p", title: id, status: "done", createdAt: stamp, updatedAt: stamp });
  const runDir = (id: string) => {
    const dir = join(runs, id, "session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.md"), "正文");
    return dir;
  };
  const debt = async (id: string) => (await db.select().from(taskDiskCleanups).where(eq(taskDiskCleanups.taskId, id))).at(0);
  const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).length;
  const api = new Hono();
  mountTaskDeleteRoutes(api);
  const del = async (id: string) => {
    const response = await api.request(`/tasks/${id}`, { method: "DELETE" });
    return { status: response.status, body: await response.json() as { deleted?: boolean; diskCleanupPending?: string[] } };
  };

  // ── 能删干净的：账随即销掉 ──
  await task("clean");
  runDir("clean");
  const ok = await del("clean");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.diskCleanupPending, undefined);
  assert.equal(existsSync(join(runs, "clean")), false);
  assert.equal(await debt("clean"), undefined);

  // ── 删不掉的：照样 200、任务行没了、账留着并记下原因 ──
  await task("stuck");
  lock(runDir("stuck"));
  const stuck = await del("stuck");
  assert.equal(stuck.status, 200, "任务行已经删掉，磁盘失败不能报成删除失败");
  assert.equal(stuck.body.deleted, true);
  assert.deepEqual(stuck.body.diskCleanupPending, ["stuck"], "如实说出哪个没收干净");
  assert.equal(await taskRow("stuck"), 0);
  assert.equal(existsSync(join(runs, "stuck")), true);
  const owed = await debt("stuck");
  assert.equal(owed?.attempts, 1, "收不掉记一次");
  assert.match(owed?.lastError ?? "", /EACCES/, "记下原因");

  // 还删不掉时重试不销账。
  assert.equal(await sweepPendingTaskDisk(), 0);
  assert.equal((await debt("stuck"))?.attempts, 2);

  // ── 放开之后后台重试收掉、销账 ──
  unlockAll();
  assert.equal(await sweepPendingTaskDisk(), 1);
  assert.equal(existsSync(join(runs, "stuck")), false, "重试把目录收掉");
  assert.equal(await debt("stuck"), undefined, "收干净才销账");

  // ── 清理层出错（账写不上）不改写已经提交的删除 ──
  await task("ledger-broken");
  lock(runDir("ledger-broken"));
  await dbClient.executeMultiple(`CREATE TRIGGER block_debt_update BEFORE UPDATE ON task_disk_cleanups
    BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END`);
  const broken = await del("ledger-broken");
  assert.equal(broken.status, 200, "账记不上也不能把已提交的删除报成失败");
  assert.deepEqual(broken.body.diskCleanupPending, ["ledger-broken"]);
  assert.equal(await taskRow("ledger-broken"), 0);
  assert.notEqual(await debt("ledger-broken"), undefined, "同批落下的那一行还在，后台照样会重试");
  await dbClient.executeMultiple("DROP TRIGGER block_debt_update");
  unlockAll();
  assert.equal(await sweepPendingTaskDisk(), 1);
  assert.equal(existsSync(join(runs, "ledger-broken")), false);

  // ── 删行那一批失败：任务还在，也就没有账 ──
  await task("rows-fail");
  runDir("rows-fail");
  await dbClient.executeMultiple(`CREATE TRIGGER block_task_delete BEFORE DELETE ON tasks WHEN old.id = 'rows-fail'
    BEGIN SELECT RAISE(ABORT, 'rows fail'); END`);
  await assert.rejects(deleteTaskCompletely("rows-fail"));
  await dbClient.executeMultiple("DROP TRIGGER block_task_delete");
  assert.equal(await taskRow("rows-fail"), 1);
  assert.equal(await debt("rows-fail"), undefined, "删行没成就不该有清理责任");
  assert.equal(existsSync(join(runs, "rows-fail", "session", "s.md")), true, "目录一个字节不动");

  // ── 同一个 id 又有了任务行：账作废，目录归那个活任务 ──
  await task("returned");
  runDir("returned");
  await db.insert(taskDiskCleanups).values({ taskId: "returned", createdAt: stamp });
  assert.equal(await sweepPendingTaskDisk(), 0);
  assert.equal(existsSync(join(runs, "returned", "session", "s.md")), true);
  assert.equal(await debt("returned"), undefined);

  console.log("task delete disk: ok");
} finally {
  unlockAll();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
