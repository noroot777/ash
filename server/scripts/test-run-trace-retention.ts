// 原始事件流的保留期（run-trace-retention.ts）：任务验收或归档、且过了宽限期才删，别的一律不碰。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-trace-retention-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_TRACE_KEEP_DAYS = "7";

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { sweepRawTraces } = await import("../src/run-trace-retention.js");
  await ensureSchema();

  const DAY = 86_400_000;
  const nowMs = Date.parse("2026-11-13T00:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: join(root, "repo"), createdAt: iso(nowMs) });
  const task = (id: string, over: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({
    id, projectId: "p", title: id, status: "done", createdAt: iso(nowMs), updatedAt: iso(nowMs), ...over });
  /** 在任务目录里放一份文件，修改时间设成 ageDays 天前。 */
  const file = (taskId: string, name: string, ageDays: number) => {
    const dir = join(process.env.ASH_RUNS_DIR!, taskId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "{}\n");
    const at = (nowMs - ageDays * DAY) / 1000;
    utimesSync(path, at, at);
    return path;
  };
  const events = (taskId: string, ageDays: number, turn = "s1-20261101T000000000Z") =>
    file(taskId, `${turn}.codex-events.jsonl`, ageDays);

  await task("accepted", { stage: "accepted" });
  const acceptedOld = events("accepted", 10);
  const acceptedFresh = events("accepted", 3, "s1-20261110T000000000Z");
  const keepers = [file("accepted", "s1.md", 30), file("accepted", "s1.trace.jsonl", 30),
    file("accepted", "s1-20261101T000000000Z.stderr.log", 30), file("accepted", "s1-20261101T000000000Z.diagnostics.json", 30)];

  // 归档：宽限期从归档那一刻算，日志本身再旧也要等够。
  await task("archived-recent", { archived: true, archivedAt: iso(nowMs - 2 * DAY) });
  const archivedRecent = events("archived-recent", 40);
  await task("archived-long", { archived: true, archivedAt: iso(nowMs - 20 * DAY) });
  const archivedLong = events("archived-long", 40);

  await task("active", { stage: "verified" });
  const active = events("active", 60);
  const orphan = events("no-such-task", 60);

  const result = await sweepRawTraces(nowMs);
  assert.equal(result.removed, 2);
  assert.equal(existsSync(acceptedOld), false, "已验收且写完超过 7 天的删掉");
  assert.equal(existsSync(archivedLong), false, "归档超过 7 天的删掉");
  assert.equal(existsSync(acceptedFresh), true, "已验收但还在宽限期内的留着");
  assert.equal(existsSync(archivedRecent), true, "归档不满 7 天的留着，哪怕日志本身很旧");
  assert.equal(existsSync(active), true, "进行中的任务不管多旧都不碰");
  assert.equal(existsSync(orphan), true, "查不到任务行的目录不归这里管");
  for (const path of keepers) assert.equal(existsSync(path), true, `只删原始事件流，别的不碰：${path}`);

  console.log("run trace retention: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
