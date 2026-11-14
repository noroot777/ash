// 原始事件流的保留期（run-trace-retention.ts，判据与清扫在 run-retention.ts）：任务了结（验收 / 归档）之后再等满宽限期才删，
// 别的一律不碰。宽限期从「这一次了结」起算——不是日志的修改时间（第 1 轮审查 F1：搁了一个月
// 才验收的任务，一验收就被删），也不是很久以前那一次了结（第 2 轮审查 F1：两次清扫之间重新
// 打开又验收、取回又归档，清扫一次都没看到中间状态）；保留天数填错按默认值，不能变成立刻删
// （第 1 轮 F2）；一个任务目录出错不拦别的任务（第 2 轮 N1）。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-trace-retention-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_TRACE_KEEP_DAYS;

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { sweepRunRetention, retentionKeepDays } = await import("../src/run-retention.js");
  const sweepRawTraces = async (nowMs: number) => (await sweepRunRetention(nowMs)).traces;
  const { commitAcceptanceStage } = await import("../src/review-acceptance.js");
  const { commitReopenAcceptedStage } = await import("../src/task-stage.js");
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
    assert.equal(retentionKeepDays(), days, `ASH_TRACE_KEEP_DAYS=${JSON.stringify(raw)}`);
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

  // ── 两次清扫之间重新打开又验收（走生产的摘牌 / 落章）：身份换了，重新起算 ──
  await task("reaccepted", { stage: "accepted", acceptanceId: "first-acceptance" });
  const history = events("reaccepted", 30);
  await sweepRawTraces(t0); // 第一次验收被看到
  await commitReopenAcceptedStage("reaccepted");
  await commitAcceptanceStage("reaccepted", "accepted");
  // 中间一次清扫都没跑；现在离第一次验收已满 8 天，但这一次验收刚发生。
  assert.equal((await sweepRawTraces(t0 + 8 * DAY)).removed, 0, "重新验收之后旧起点作废");
  assert.equal(existsSync(history), true);
  assert.equal((await sweepRawTraces(t0 + 14 * DAY)).removed, 0, "从重新验收被看到那一刻算，还没满");
  assert.equal((await sweepRawTraces(t0 + 15 * DAY)).removed, 1);

  // ── 两次清扫之间取回又归档：同理 ──
  await task("rearchived", { archived: true, archivedAt: iso(t0) });
  const archiveHistory = events("rearchived", 30);
  await sweepRawTraces(t0);
  await db.update(tasks).set({ archived: false, archivedAt: null }).where(eq(tasks.id, "rearchived"));
  await db.update(tasks).set({ archived: true, archivedAt: iso(t0 + 8 * DAY) }).where(eq(tasks.id, "rearchived"));
  assert.equal((await sweepRawTraces(t0 + 8 * DAY)).removed, 0, "重新归档之后旧起点作废");
  assert.equal((await sweepRawTraces(t0 + 14 * DAY)).removed, 0);
  assert.equal((await sweepRawTraces(t0 + 15 * DAY)).removed, 1);
  assert.equal(existsSync(archiveHistory), false);

  // ── 了结之后新写的日志也要自己满宽限期 ──
  await task("late-write", { stage: "accepted", acceptanceId: "late" });
  const early = events("late-write", 30);
  await sweepRawTraces(t0); // 了结在 t0 被看到
  const late = events("late-write", -10, "s1-20261123T000000000Z"); // 了结之后（t0+10 天）才写
  await sweepRawTraces(t0 + 16 * DAY);
  assert.equal(existsSync(early), false, "了结前的日志按了结起算，已满");
  assert.equal(existsSync(late), true, "了结后写的日志自己还没满 7 天");
  await sweepRawTraces(t0 + 17 * DAY);
  assert.equal(existsSync(late), false);

  // ── 一个目录出错不拦别的任务 ──
  await task("stuck", { stage: "accepted", acceptanceId: "stuck" });
  events("stuck", 30);
  await sweepRawTraces(t0); // 落下起点
  await db.update(tasks).set({ stage: "verified" }).where(eq(tasks.id, "stuck")); // 重新打开：要撤起点
  const stuckDir = join(process.env.ASH_RUNS_DIR!, "stuck");
  chmodSync(stuckDir, 0o500); // 起点撤不掉
  await task("after", { stage: "accepted", acceptanceId: "after" });
  const after = events("after", 30);
  try {
    await sweepRawTraces(t0);
    assert.equal((await sweepRawTraces(t0 + 7 * DAY)).removed, 1, "别的任务照常清扫");
    assert.equal(existsSync(after), false);
  } finally {
    chmodSync(stuckDir, 0o700);
  }

  // ── 保留期 0 天：第一次看到了结就删，不等下一趟（第 3 轮审查 N1） ──
  await task("zero", { stage: "accepted", acceptanceId: "zero" });
  const zero = events("zero", 1);
  process.env.ASH_TRACE_KEEP_DAYS = "0";
  try {
    await sweepRawTraces(t0);
  } finally {
    delete process.env.ASH_TRACE_KEEP_DAYS;
  }
  assert.equal(existsSync(zero), false);

  console.log("run trace retention: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
