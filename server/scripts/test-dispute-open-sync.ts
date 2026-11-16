// 「等你裁定」（Task.disputeOpen）这一格：投影查得对，变了就重发任务快照（dispute-open-sync.ts）。
//
// 钉的是第 1 轮审查那一条：转独立任务那一路提前返回、只发了 task.review，侧栏只认 task.updated，
// 于是原任务一直写着「等你裁定」。推送现在挂在 task.review 上统一做，这里每个出口各走一遍：
// ① 驳回落下 → 快照里 disputeOpen 变 true；② 转独立任务（deferred）→ 变回 false；
// ③ 采纳执行者（withdrawn）→ 变回 false；④ 审查进度类的 task.review、那一格没变 → 不重发。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-dispute-open-sync-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, projects, reviewerProfiles, freeReviewRuns, freeReviewRounds, tasks } = await import("../src/db/schema.js");
  const { createTasks, enrichTasks } = await import("../src/task-store.js");
  const { resolveFreeReviewDispute } = await import("../src/free-review-dispute.js");
  const { disputeOpenSettled } = await import("../src/dispute-open-sync.js");
  const { bus } = await import("../src/bus.js");
  await ensureSchema();

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "codex@test", type: "codex", isDefault: true });
  await db.insert(reviewerProfiles).values({ id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at });

  // 一条任务一条审查链一轮，驳回先不写（理由空着 = 还没驳回）。
  async function seed(id: string) {
    await createTasks([{ id, projectId: "p", title: id, body: "", mode: "single", status: "done", agentType: "codex", executorId: "ex",
      autoTitle: false, workflowMode: "free", useWorktree: false, createdAt: at, updatedAt: at }]);
    await db.insert(freeReviewRuns).values({ id: `${id}-run`, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "stopped", createdAt: at, updatedAt: at, finishedAt: at });
    await db.insert(freeReviewRounds).values({ id: `${id}-round`, runId: `${id}-run`, round: 1, status: "failed", conclusion: "verify_failed",
      reportMarkdown: "review", startedAt: at, endedAt: at });
  }
  const projected = async (id: string) => (await enrichTasks(await db.select().from(tasks).where(eq(tasks.id, id))))[0]!.disputeOpen;

  const snapshots: { id: string; disputeOpen: boolean | undefined }[] = [];
  bus.subscribe((event) => {
    if (event.type === "task.updated") snapshots.push({ id: event.task.id, disputeOpen: event.task.disputeOpen });
  });
  const publishedFor = async (id: string) => {
    await disputeOpenSettled(id);
    return snapshots.filter((entry) => entry.id === id).map((entry) => entry.disputeOpen);
  };
  const review = async (id: string) => {
    snapshots.length = 0;
    bus.publish({ type: "task.review", taskId: id });
    return publishedFor(id);
  };

  // ① 驳回落下：投影是 true，审查面板那条事件一到，快照跟着重发。
  await seed("defer");
  assert.equal(await projected("defer"), false);
  assert.deepEqual(await review("defer"), [], "还没驳回：那一格没变，不重发");
  await db.update(freeReviewRounds).set({ disputeDeferReason: "基线就有的问题，不属于本任务", disputeAt: at })
    .where(eq(freeReviewRounds.id, "defer-round"));
  assert.equal(await projected("defer"), true);
  assert.deepEqual(await review("defer"), [true], "驳回落下：快照重发，disputeOpen=true");
  assert.deepEqual(await review("defer"), [], "审查进度类的事件、那一格没变：不重发");

  // ② 转独立任务：第 1 轮审查复现的那一路，原任务的快照必须重发成 false。
  snapshots.length = 0;
  const deferred = await resolveFreeReviewDispute("defer", "deferred");
  assert.ok(deferred.deferredTask, "派生任务建出来了");
  assert.deepEqual(await publishedFor("defer"), [false], "转独立任务之后：原任务快照重发，不再写着等你裁定");
  assert.equal(await projected("defer"), false);

  // ③ 采纳执行者：同样变回 false。
  await seed("withdraw");
  await db.update(freeReviewRounds).set({ disputeReason: "报告读错了行号", disputeAt: at }).where(eq(freeReviewRounds.id, "withdraw-round"));
  assert.deepEqual(await review("withdraw"), [true]);
  snapshots.length = 0;
  await resolveFreeReviewDispute("withdraw", "withdrawn");
  assert.deepEqual(await publishedFor("withdraw"), [false], "采纳执行者之后：快照重发成 false");

  console.log("dispute open sync ok");
} catch (error) {
  failure = error;
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
