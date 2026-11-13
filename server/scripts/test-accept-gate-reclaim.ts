// macOS 结算时留下的验收快照，任务了结（验收 / 归档 / 删除）时回收 —— accept-gate-reclaim.ts。
//
// 钉的是判据的两面：
//   该收的：已验收、已归档、任务行已删 → 名下已经结算完的快照全部收掉，日志里留一句；
//   不该碰的：任务还在进行（哪怕快照早就跑完）、门禁还在跑、进程还没确认收干净 —— 一份不动。
// 外加两条接线：归档路由当场收；单删任务连 runs 目录一起收（以前只有删项目才收，单删留孤儿）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-gate-reclaim-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, projects, tasks } = await import("../src/db/schema.js");
  const { gateSnapshotPath } = await import("../src/accept-gate-source.js");
  const { acceptGateLogPath } = await import("../src/accept-gate-process.js");
  const { reclaimGateSnapshots, sweepGateSnapshots } = await import("../src/accept-gate-reclaim.js");
  const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
  const { mountTaskArchiveRoutes } = await import("../src/task-archive-routes.js");
  const { Hono } = await import("hono");
  await ensureSchema();

  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "reclaim-project", name: "reclaim", repoPath: join(root, "repo"), createdAt: stamp });
  const task = (id: string, over: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({
    id, projectId: "reclaim-project", title: id, status: "done", createdAt: stamp, updatedAt: stamp, ...over });
  /** 造一份快照（目录 + 旁边的 inputs.json + 门禁日志），有 status 就同时插一条门禁行。 */
  const snapshot = async (taskId: string, runId: string, row?: { status: string; processPending?: boolean }) => {
    const path = gateSnapshotPath(taskId, runId);
    mkdirSync(join(path, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(path, "node_modules", "dep", "index.js"), "x");
    writeFileSync(`${path}.inputs.json`, "{}");
    const logPath = acceptGateLogPath(taskId, runId);
    writeFileSync(logPath, "rc=0\n");
    if (row) await db.insert(acceptGateRuns).values({ id: runId, taskId, projectId: "reclaim-project", command: "npm test",
      cwd: path, status: row.status, processPending: row.processPending ?? false, logPath, startedAt: stamp, finishedAt: stamp });
    return path;
  };

  // ── 已验收：结算完的收掉，在跑的、进程没收干净的留着 ──
  await task("accepted", { stage: "accepted" });
  const passed = await snapshot("accepted", "passed-run", { status: "passed" });
  const failed = await snapshot("accepted", "failed-run", { status: "failed" });
  const running = await snapshot("accepted", "running-run", { status: "running" });
  const pending = await snapshot("accepted", "pending-run", { status: "canceled", processPending: true });
  // 门禁行已经没了（老数据）也照收：任务了结了，没人会再读它。
  const rowless = await snapshot("accepted", "rowless-run");
  assert.equal(await reclaimGateSnapshots("accepted"), 3);
  for (const path of [passed, failed, rowless]) {
    assert.equal(existsSync(path), false, `已了结任务的快照应已回收：${path}`);
    assert.equal(existsSync(`${path}.inputs.json`), false, "旁边那份 inputs.json 一起收");
  }
  assert.match(readFileSync(acceptGateLogPath("accepted", "passed-run"), "utf8"), /独立测试快照已回收/, "日志里留下回收记录");
  assert.equal(existsSync(running), true, "还在跑的门禁不碰");
  assert.equal(existsSync(pending), true, "进程还没确认收干净的不碰");

  // ── 还在进行的任务：快照跑完了也不收（之后可能还要验收、还有人在用） ──
  await task("active", { stage: "verified" });
  const active = await snapshot("active", "done-run", { status: "failed" });
  assert.equal(await reclaimGateSnapshots("active"), 0);
  assert.equal(existsSync(active), true, "未了结任务的快照不收");

  // ── 启动清扫：已归档的、任务行早已删掉的孤儿目录都补收；别的文件不碰 ──
  await task("archived", { archived: true, archivedAt: stamp });
  const archived = await snapshot("archived", "old-run", { status: "passed" });
  const orphan = await snapshot("deleted-long-ago", "old-run");
  const transcript = join(process.env.ASH_RUNS_DIR!, "deleted-long-ago", "session.md");
  writeFileSync(transcript, "正文");
  assert.equal(await sweepGateSnapshots(), 2);
  assert.equal(existsSync(archived), false, "已归档任务的快照在启动清扫里收掉");
  assert.equal(existsSync(orphan), false, "任务行已删的孤儿快照也收掉");
  assert.equal(existsSync(transcript), true, "清扫只认快照，不碰同目录别的文件");
  assert.equal(existsSync(active), true, "启动清扫同样不碰未了结任务");
  assert.equal(existsSync(running), true, "启动清扫同样不碰在跑的门禁");

  // ── 归档路由：归档那一下当场收 ──
  await task("to-archive");
  const beforeArchive = await snapshot("to-archive", "kept-run", { status: "passed" });
  const api = new Hono();
  mountTaskArchiveRoutes(api);
  const response = await api.request("/tasks/to-archive/archive", { method: "POST" });
  assert.equal(response.status, 200, await response.text());
  assert.equal(existsSync(beforeArchive), false, "归档时当场回收快照");

  // ── 单删任务：整个 runs 目录一起收（以前只有删项目才收） ──
  await task("to-delete");
  await snapshot("to-delete", "some-run", { status: "passed" });
  const deleteDir = join(process.env.ASH_RUNS_DIR!, "to-delete");
  writeFileSync(join(deleteDir, "session.md"), "正文");
  await deleteTaskCompletely("to-delete");
  assert.equal(existsSync(deleteDir), false, "删任务连 runs 目录一起收");

  console.log("accept-gate reclaim: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
