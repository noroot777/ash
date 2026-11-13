// 自由审查截图的保留期（review-image-retention.ts，判据与清扫在 run-retention.ts）：跟原始事件流
// 同一套「这一次了结 + 满 KEEP_DAYS」、同一个天数开关。钉住的是：
//   · 了结满 7 天删截图，report.md / review.diff / 日志一份不碰；
//   · 进行中、了结未满 7 天、两次清扫之间重新打开又验收的任务不受影响；
//   · 删掉的那几张在状态里报成 expiredScreenshots、证据接口回 410，而不是「从来没有」的 404；
//   · 删之前先记过期清单，记不上就一张不删；符号链接一律不跟；
//   · 跟同编号的接力导入按目录锁互斥：导入持锁期间把任务重新打开，清扫读到的是导入之后的状态。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-review-image-retention-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_TRACE_KEEP_DAYS;

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { freeReviewRounds, freeReviewRuns, projects, tasks } = await import("../src/db/schema.js");
  const { sweepRunRetention } = await import("../src/run-retention.js");
  const { EXPIRED_REVIEW_IMAGES, freeReviewEvidenceDir } = await import("../src/free-review-files.js");
  const { freeWorkflowState } = await import("../src/free-workflow-state.js");
  const { mountFreeWorkflowRoutes } = await import("../src/free-workflow-routes.js");
  const { commitAcceptanceStage } = await import("../src/review-acceptance.js");
  const { commitReopenAcceptedStage } = await import("../src/task-stage.js");
  const { withTaskDirLock } = await import("../src/task-dir-lock.js");
  const { Hono } = await import("hono");
  const { eq } = await import("drizzle-orm");
  await ensureSchema();
  const api = new Hono();
  mountFreeWorkflowRoutes(api);

  const DAY = 86_400_000;
  const t0 = Date.parse("2026-11-13T00:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: join(root, "repo"), createdAt: iso(t0) });

  const IMAGES = ["a.png", "shots/b.jpg", "c.webp"];
  const TEXTS = ["report.md", "review.diff", "server.log", "notes.json"];
  /** 一个跑过一轮自由审查的任务：证据目录里放图和文字产物，修改时间都设成 t0 往前 30 天。 */
  async function reviewed(id: string, over: Partial<typeof tasks.$inferInsert> = {}) {
    await db.insert(tasks).values({
      id, projectId: "p", title: id, status: "done", workflowMode: "free", createdAt: iso(t0), updatedAt: iso(t0), ...over,
    });
    const runId = `${id}-run`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      checkMode: "logic", currentRound: 1, status: "passed", createdAt: iso(t0), updatedAt: iso(t0),
    });
    await db.insert(freeReviewRounds).values({ id: `${runId}-1`, runId, round: 1, status: "passed", conclusion: "verified", startedAt: iso(t0) });
    const dir = freeReviewEvidenceDir(id, runId, 1);
    const paths = Object.fromEntries([...IMAGES, ...TEXTS].map((name) => {
      const path = join(dir, ...name.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, name.endsWith(".md") ? `# 报告\n\n![](${IMAGES[0]})\n` : "x");
      const at = (t0 - 30 * DAY) / 1000;
      utimesSync(path, at, at);
      return [name, path];
    }));
    return { runId, dir, paths };
  }
  const images = (task: { paths: Record<string, string> }) => IMAGES.map((name) => existsSync(task.paths[name]!));
  const texts = (task: { paths: Record<string, string> }) => TEXTS.every((name) => existsSync(task.paths[name]!));
  const round = async (id: string) => (await freeWorkflowState(id)).reviews[0]!.rounds[0]!;
  const fetchFile = (id: string, runId: string, name: string) =>
    api.request(`/tasks/${id}/free-workflow/review-file?run=${runId}&round=1&name=${encodeURIComponent(name)}`);

  const accepted = await reviewed("accepted", { stage: "accepted", acceptanceId: "acc-1" });
  const archived = await reviewed("archived", { archived: true, archivedAt: iso(t0) });
  const active = await reviewed("active", { stage: "verified" });
  const finishedOnly = await reviewed("finished-only"); // 跑完了，没验收也没归档
  const late = await reviewed("late", { stage: "verified" });

  // ── 第一次看到了结：只起算 ──
  assert.equal((await sweepRunRetention(t0)).screenshots.removed, 0);
  assert.deepEqual(images(accepted), [true, true, true], "刚验收的任务，截图再旧也先留满宽限期");

  // 3 天后才验收的那个
  await db.update(tasks).set({ stage: "accepted", acceptanceId: "late-1" }).where(eq(tasks.id, "late"));
  assert.equal((await sweepRunRetention(t0 + 3 * DAY)).screenshots.removed, 0);
  assert.equal((await sweepRunRetention(t0 + 6 * DAY)).screenshots.removed, 0, "未满 7 天不删");

  // ── 满 7 天：只删图，文字产物都在 ──
  const swept = await sweepRunRetention(t0 + 7 * DAY);
  assert.equal(swept.screenshots.removed, 6, "验收的、归档的各 3 张");
  assert.ok(swept.screenshots.bytes > 0);
  for (const task of [accepted, archived]) {
    assert.deepEqual(images(task), [false, false, false]);
    assert.equal(texts(task), true, "report.md、review.diff、日志一份不碰");
  }
  assert.deepEqual(images(active), [true, true, true], "进行中的任务不管多旧都不碰");
  assert.deepEqual(images(finishedOnly), [true, true, true], "没验收也没归档的不在范围内");
  assert.deepEqual(images(late), [true, true, true], "了结才 4 天的不碰");

  // ── 删了的如实报出来：状态里有 expiredScreenshots，接口回 410；文字照常读 ──
  const expiredRound = await round("accepted");
  assert.deepEqual(expiredRound.screenshots, []);
  assert.deepEqual(expiredRound.expiredScreenshots, [...IMAGES].sort());
  assert.match(expiredRound.reportMarkdown, /# 报告/);
  assert.equal((await fetchFile("accepted", accepted.runId, "a.png")).status, 410);
  assert.equal((await fetchFile("accepted", accepted.runId, "shots/b.jpg")).status, 410);
  assert.equal((await fetchFile("accepted", accepted.runId, "never.png")).status, 404, "从来没有的图仍是 404");
  assert.equal((await fetchFile("accepted", accepted.runId, "report.md")).status, 200);
  assert.equal((await round("active")).expiredScreenshots, undefined, "没删过的轮次不带这个字段");

  // 同名的图又回来了（例如接力带回）：以磁盘为准，不再算过期。
  writeFileSync(accepted.paths["a.png"]!, "back");
  utimesSync(accepted.paths["a.png"]!, (t0 + 100 * DAY) / 1000, (t0 + 100 * DAY) / 1000); // 别让它在下面的计数里被当成过期再删
  const restored = await round("accepted");
  assert.deepEqual(restored.screenshots, ["a.png"]);
  assert.deepEqual(restored.expiredScreenshots, ["c.webp", "shots/b.jpg"]);
  assert.equal((await fetchFile("accepted", accepted.runId, "a.png")).status, 200);

  // ── 两次清扫之间重新打开又验收（生产的摘牌 / 落章）：旧起点作废，重新等满 ──
  const reaccepted = await reviewed("reaccepted", { stage: "accepted", acceptanceId: "first" });
  await sweepRunRetention(t0);
  await commitReopenAcceptedStage("reaccepted");
  await commitAcceptanceStage("reaccepted", "accepted");
  await sweepRunRetention(t0 + 8 * DAY);
  assert.deepEqual(images(reaccepted), [true, true, true], "重新验收之后旧起点作废");
  await sweepRunRetention(t0 + 14 * DAY);
  assert.deepEqual(images(reaccepted), [true, true, true], "从重新验收被看到那一刻算，还没满");
  await sweepRunRetention(t0 + 15 * DAY);
  assert.deepEqual(images(reaccepted), [false, false, false]);

  // ── 重新打开之后停在进行中：一张不删 ──
  const reopened = await reviewed("reopened", { stage: "accepted", acceptanceId: "r1" });
  await sweepRunRetention(t0);
  await commitReopenAcceptedStage("reopened");
  await sweepRunRetention(t0 + 30 * DAY);
  assert.deepEqual(images(reopened), [true, true, true]);
  assert.equal(existsSync(join(process.env.ASH_RUNS_DIR!, "reopened", EXPIRED_REVIEW_IMAGES)), false);

  // ── 符号链接一律不跟：链出去的图、链出去的轮次目录都不碰 ──
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.png"), "outside");
  writeFileSync(join(outside, "deep.png"), "outside");
  const linked = await reviewed("linked", { stage: "accepted", acceptanceId: "l1" });
  symlinkSync(join(outside, "keep.png"), join(linked.dir, "evil.png"));
  symlinkSync(outside, join(dirname(linked.dir), "round-2"));
  await sweepRunRetention(t0);
  await sweepRunRetention(t0 + 7 * DAY);
  assert.deepEqual(images(linked), [false, false, false], "证据目录里的真文件照删");
  assert.equal(existsSync(join(outside, "keep.png")), true);
  assert.equal(existsSync(join(outside, "deep.png")), true);

  // ── 过期清单记不上：一张不删（不能删了图却说不出它是过期没的） ──
  const unrecorded = await reviewed("unrecorded", { stage: "accepted", acceptanceId: "u1" });
  await sweepRunRetention(t0);
  const unrecordedDir = join(process.env.ASH_RUNS_DIR!, "unrecorded");
  mkdirSync(join(unrecordedDir, EXPIRED_REVIEW_IMAGES)); // 清单那个位置被一个目录占着
  await sweepRunRetention(t0 + 7 * DAY);
  assert.deepEqual(images(unrecorded), [true, true, true]);
  rmSync(join(unrecordedDir, EXPIRED_REVIEW_IMAGES), { recursive: true });

  // ── 一个任务目录出错不拦别的任务 ──
  const stuck = await reviewed("stuck", { stage: "accepted", acceptanceId: "s1" });
  const after = await reviewed("after", { stage: "accepted", acceptanceId: "a1" });
  await sweepRunRetention(t0);
  chmodSync(stuck.dir, 0o500); // 图删不掉、但清单照写
  try {
    await sweepRunRetention(t0 + 7 * DAY);
    assert.deepEqual(images(after), [false, false, false], "别的任务照常清扫");
  } finally {
    chmodSync(stuck.dir, 0o700);
  }
  const stuckRound = await round("stuck");
  assert.ok(stuckRound.screenshots.includes("a.png"), "删失败的图还在就照常显示");
  assert.ok(!stuckRound.expiredScreenshots?.includes("a.png"), "还在的不报过期");

  // ── 与接力导入互斥：导入持锁期间任务被领回、重新打开，清扫等它落定后读到的是新状态 ──
  const handed = await reviewed("handed", { stage: "accepted", acceptanceId: "h1" });
  await sweepRunRetention(t0);
  let releaseImport!: () => void;
  const importing = withTaskDirLock("handed", () => new Promise<void>((resolve) => { releaseImport = resolve; }));
  const sweeping = sweepRunRetention(t0 + 7 * DAY);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(images(handed), [true, true, true], "导入持锁期间清扫不动这个目录");
  await db.update(tasks).set({ stage: "verified", acceptanceId: null }).where(eq(tasks.id, "handed"));
  releaseImport();
  await importing;
  await sweeping;
  assert.deepEqual(images(handed), [true, true, true], "清扫读到的是导入之后的任务行：进行中，不删");

  // ── 保留期 0 天：第一次看到了结就删 ──
  const zero = await reviewed("zero", { stage: "accepted", acceptanceId: "z1" });
  process.env.ASH_TRACE_KEEP_DAYS = "0";
  try {
    await sweepRunRetention(t0);
  } finally {
    delete process.env.ASH_TRACE_KEEP_DAYS;
  }
  assert.deepEqual(images(zero), [false, false, false]);
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.ASH_RUNS_DIR!, "zero", EXPIRED_REVIEW_IMAGES), "utf8")),
    { [`${zero.runId}/round-1`]: [...IMAGES].sort() });

  console.log("review image retention: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
