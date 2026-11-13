// 原始事件流的保留期（run-trace-retention.ts）：任务了结（验收 / 归档）之后再等满宽限期才删，
// 别的一律不碰。宽限期从清扫第一次看到「已了结」那一刻起算——不是日志的修改时间（第 1 轮审查
// F1：搁了一个月才验收的任务，一验收就被删）；保留天数填错按默认值，不能变成立刻删（F2）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-trace-retention-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_TRACE_KEEP_DAYS;

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { sweepRawTraces, traceKeepDays } = await import("../src/run-trace-retention.js");
  const { eq } = await import("drizzle-orm");
  await ensureSchema();

  const DAY = 86_400_000;
  const t0 = Date.parse("2026-11-13T00:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: join(root, "repo"), createdAt: iso(t0) });
  const task = (id: string, over: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({
    id, projectId: "p", title: id, status: "done", createdAt: iso(t0), updatedAt: iso(t0), ...over });
  /** 在任务目录里放一份文件，修改时间设成 t0 往前 ageDays 天。 */
  const file = (taskId: string, name: string, ageDays: number) => {
    const dir = join(process.env.ASH_RUNS_DIR!, taskId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "{}\n");
    const at = (t0 - ageDays * DAY) / 1000;
    utimesSync(path, at, at);
    return path;
  };
  const events = (taskId: string, ageDays: number, turn = "s1-20261001T000000000Z") =>
    file(taskId, `${turn}.codex-events.jsonl`, ageDays);

  // ── 配置：只认有限、不为负的天数，其余回到默认 7 天 ──
  for (const [raw, days] of [[undefined, 7], ["", 7], ["  ", 7], ["7d", 7], ["-1", 7], ["NaN", 7], ["Infinity", 7], ["0", 0], ["3", 3]] as const) {
    if (raw === undefined) delete process.env.ASH_TRACE_KEEP_DAYS;
    else process.env.ASH_TRACE_KEEP_DAYS = raw;
    assert.equal(traceKeepDays(), days, `ASH_TRACE_KEEP_DAYS=${JSON.stringify(raw)}`);
  }
  delete process.env.ASH_TRACE_KEEP_DAYS;

  // 日志都是一个月前写的；任务此刻才了结。
  await task("accepted", { stage: "accepted" });
  const accepted = events("accepted", 30);
  const keepers = [file("accepted", "s1.md", 30), file("accepted", "s1.trace.jsonl", 30),
    file("accepted", "s1-20261001T000000000Z.stderr.log", 30), file("accepted", "s1-20261001T000000000Z.diagnostics.json", 30)];
  await task("archived", { archived: true, archivedAt: iso(t0) });
  const archived = events("archived", 30);
  await task("active", { stage: "verified" });
  const active = events("active", 60);
  const orphan = events("no-such-task", 60);

  // ── 第一次看到了结：只起算，一份不删（F1） ──
  assert.deepEqual(await sweepRawTraces(t0), { removed: 0, bytes: 0 });
  assert.equal(existsSync(accepted), true, "刚验收的任务，日志再旧也要先留满宽限期");
  assert.equal(existsSync(archived), true, "刚归档的同理");

  // ── 配置填错不能变成立刻删（F2） ──
  process.env.ASH_TRACE_KEEP_DAYS = "7d";
  assert.equal((await sweepRawTraces(t0 + DAY)).removed, 0, "填错的天数按默认值，不放行删除");
  delete process.env.ASH_TRACE_KEEP_DAYS;

  // ── 宽限期内仍不删，满了才删 ──
  assert.equal((await sweepRawTraces(t0 + 6 * DAY)).removed, 0);
  assert.equal((await sweepRawTraces(t0 + 7 * DAY)).removed, 2);
  assert.equal(existsSync(accepted), false, "了结满 7 天删掉");
  assert.equal(existsSync(archived), false);
  assert.equal(existsSync(active), true, "进行中的任务不管多旧都不碰");
  assert.equal(existsSync(orphan), true, "查不到任务行的目录不归这里管");
  for (const path of keepers) assert.equal(existsSync(path), true, `只删原始事件流，别的不碰：${path}`);

  // ── 重新打开再了结：重新起算；了结之后新写的日志也要自己满宽限期 ──
  await db.update(tasks).set({ stage: "verified" }).where(eq(tasks.id, "accepted"));
  const reopened = events("accepted", -8, "s1-20261121T000000000Z"); // 重新打开期间写的（t0+8 天）
  await sweepRawTraces(t0 + 8 * DAY); // 看到未了结：撤掉起算点
  await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, "accepted"));
  await sweepRawTraces(t0 + 9 * DAY); // 重新起算
  assert.equal((await sweepRawTraces(t0 + 15 * DAY)).removed, 0, "从重新了结那一刻算，还没满");
  assert.equal((await sweepRawTraces(t0 + 16 * DAY)).removed, 1);
  assert.equal(existsSync(reopened), false);

  console.log("run trace retention: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
