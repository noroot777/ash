// 删任务之后收磁盘（run-dir-reclaim.ts）。钉的是第 1、2 轮审查 F3/F2 那组反例：
//   清理责任跟删任务行同一个原子批提交——任务删成了就一定有账，删不成就一定没有；
//   磁盘失败不算删除失败：接口照常 200，如实列出哪几个没收干净；
//   账只在磁盘真收干净后销掉，收不掉记下次数和原因、后台重试；
//   清理层出任何错（账写不上）都不改写已经提交的删除结果；
//   同一个 id 又有了任务行（接力迁回本机）：账作废、目录一个字节不动；
//   旧清理和同编号的真实接力导入交错（第 3 轮审查 F1）：两种先后都不许删掉导入的正文。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import fsPromises from "node:fs/promises";
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
  const { importHandoff } = await import("../src/handoff-import.js");
  const { withTaskDirLock } = await import("../src/task-dir-lock.js");
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
  assert.equal(await sweepPendingTaskDisk(), 1, "账作废也算了账");
  assert.equal(existsSync(join(runs, "returned", "session", "s.md")), true);
  assert.equal(await debt("returned"), undefined);

  // ── 旧清理与同编号的真实接力导入交错 ──
  const manifest = (id: string, sessionId: string, text: string) => ({ version: 1, sourceHost: "peer", sourcePort: null,
    sourceFingerprint: "a".repeat(64), originFingerprint: "a".repeat(64), transferId: `transfer-${id}`,
    targetProjectId: "p", autoResume: false, sourceWorkspace: null, git: null,
    task: { id, title: id, body: "", status: "done", stage: null, labels: "[]", agentType: "claude", model: null,
      reasoningEffort: null, autoTitle: false, useWorktree: false, worktreeBase: null, workflow: null, workflowMode: "free",
      workflowAt: null, reviewStep: null, verifyRounds: 0, verifyStationRounds: 0, resumePrompt: null, question: null,
      questionOptions: null, questionItems: null, pinnedAt: null, starredAt: null, createdAt: stamp, startedAt: stamp, endedAt: stamp },
    sessions: [{ id: sessionId, role: "main", agentType: "claude", executor: "claude", startedAt: stamp, endedAt: stamp, cliSessionId: null }],
    files: [{ kind: "run-artifact", rel: `${sessionId}.md`, dataBase64: Buffer.from(text).toString("base64") }],
    freeWorkflow: null, uploads: [], messages: [], schedule: null });
  /** 删一个任务并让它的目录先收不掉，留下一笔欠着的清理。 */
  const owe = async (id: string) => {
    await task(id);
    lock(runDir(id));
    assert.deepEqual((await del(id)).body.diskCleanupPending, [id]);
    unlockAll();
  };

  // 先后一：旧清理已经进到删目录那一步，导入才来——导入要等它删完再写。
  await owe("race-a");
  const original = fsPromises.rm;
  let reached!: () => void;
  let resume!: () => void;
  const atRm = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  fsPromises.rm = (async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === join(runs, "race-a")) { reached(); await gate; }
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const cleaning = sweepPendingTaskDisk();
    await atRm;
    const importing = importHandoff(manifest("race-a", "sa", "导入的正文 A\n"));
    resume();
    await cleaning;
    const imported = await importing as { ok?: boolean };
    assert.equal(imported.ok, true);
  } finally {
    fsPromises.rm = original;
    syncBuiltinESMExports();
  }
  assert.equal(await taskRow("race-a"), 1);
  assert.equal(readFileSync(join(runs, "race-a", "sa.md"), "utf8"), "导入的正文 A\n", "旧清理删完之后导入才写，正文在");
  assert.equal(await debt("race-a"), undefined);
  assert.equal(await sweepPendingTaskDisk(), 0);
  assert.equal(existsSync(join(runs, "race-a", "sa.md")), true, "之后的清扫也不碰活任务的目录");

  // 先后二：导入正在写（持锁），旧清理后到——清理要等导入建完行，然后作废这笔账。
  await owe("race-b");
  let finishImport!: () => void;
  const importDone = new Promise<void>((resolve) => { finishImport = resolve; });
  // 用目录锁卡住一个「正在导入」的窗口：真实导入排在它后面，清理再排在导入后面。
  const holding = withTaskDirLock("race-b", () => importDone);
  const importing = importHandoff(manifest("race-b", "sb", "导入的正文 B\n"));
  const cleaning = sweepPendingTaskDisk();
  finishImport();
  await holding;
  assert.equal((await importing as { ok?: boolean }).ok, true);
  await cleaning;
  assert.equal(await taskRow("race-b"), 1);
  assert.equal(readFileSync(join(runs, "race-b", "sb.md"), "utf8"), "导入的正文 B\n", "导入先占住，清理排在后面、看到任务已回来");
  assert.equal(await debt("race-b"), undefined);

  console.log("task delete disk: ok");
} finally {
  unlockAll();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
