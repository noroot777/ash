// 「等你裁定」（Task.disputeOpen）这一格：投影查得对，变了列表就收到新快照（dispute-open-sync.ts）。
//
// 第 1 轮审查：转独立任务那一路提前返回、只发了 task.review，侧栏只认 task.updated，原任务一直写着
// 「等你裁定」。第 2 轮审查：改成挂在 task.review 上统一推送后，又按进程里记着的值去重 —— 重启后
// 记忆是空的，裁定把 true 改成 false 时恰好「相等」，照样不发。所以这里每个出口都走**冷**的一遍
// （驳回直接落在库里，进程从没为它发过任何事件，等同重启之后）：
// ① 采纳执行者（withdrawn）；② 转独立任务（deferred）；③ 被用户新派的审查取代；
// ④ 驳回落下；⑤ 转出时建任务失败、回滚 —— 每一处原任务都要收到一份当前事实的快照。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-dispute-open-sync-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, projects, reviewerProfiles, freeReviewRuns, freeReviewRounds, tasks } = await import("../src/db/schema.js");
  const { createTasks, enrichTasks } = await import("../src/task-store.js");
  const { resolveFreeReviewDispute, supersedeOpenDisputes } = await import("../src/free-review-dispute.js");
  const { disputeOpenSettled } = await import("../src/dispute-open-sync.js");
  const { bus } = await import("../src/bus.js");
  await ensureSchema();

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "codex@test", type: "codex", isDefault: true });
  await db.insert(reviewerProfiles).values({ id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at });

  // 一条任务一条审查链一轮；disputed=true 时驳回直接写在库里（冷：进程没为它发过任何事件）。
  async function seed(id: string, disputed: boolean) {
    await createTasks([{ id, projectId: "p", title: id, body: "", mode: "single", status: "done", agentType: "codex", executorId: "ex",
      autoTitle: false, workflowMode: "free", useWorktree: false, createdAt: at, updatedAt: at }]);
    await db.insert(freeReviewRuns).values({ id: `${id}-run`, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "stopped", createdAt: at, updatedAt: at, finishedAt: at });
    await db.insert(freeReviewRounds).values({ id: `${id}-round`, runId: `${id}-run`, round: 1, status: "failed", conclusion: "verify_failed",
      reportMarkdown: "review", startedAt: at, endedAt: at,
      ...(disputed ? { disputeReason: "报告读错了行号", disputeDeferReason: "基线就有的问题，不属于本任务", disputeAt: at } : {}) });
  }
  const projected = async (id: string) => (await enrichTasks(await db.select().from(tasks).where(eq(tasks.id, id))))[0]!.disputeOpen;

  const snapshots: { id: string; disputeOpen: boolean | undefined }[] = [];
  bus.subscribe((event) => {
    if (event.type === "task.updated") snapshots.push({ id: event.task.id, disputeOpen: event.task.disputeOpen });
  });
  const last = async (id: string) => {
    await disputeOpenSettled(id);
    return snapshots.filter((entry) => entry.id === id).at(-1)?.disputeOpen;
  };

  // ① 冷的采纳执行者：页面先整表拉到 true，裁定之后必须收到 false。
  await seed("withdraw", true);
  assert.equal(await projected("withdraw"), true);
  await resolveFreeReviewDispute("withdraw", "withdrawn");
  assert.equal(await last("withdraw"), false, "重启后采纳执行者：原任务快照重发成 false");

  // ② 冷的转独立任务（第 1 轮复现的那一路，第 2 轮复现的冷状态）。
  await seed("defer", true);
  const deferred = await resolveFreeReviewDispute("defer", "deferred");
  assert.ok(deferred.deferredTask, "派生任务建出来了");
  assert.equal(await last("defer"), false, "重启后转独立任务：原任务快照重发成 false");

  // ③ 冷的被取代：用户没裁、自己又派了一轮审查。
  await seed("supersede", true);
  await supersedeOpenDisputes("supersede", "新派了一轮审查");
  assert.equal(await last("supersede"), false, "被新一轮审查取代：快照重发成 false");

  // ④ 驳回落下：从 false 到 true，审查面板那条事件一到快照就跟上。
  await seed("dispute", false);
  assert.equal(await projected("dispute"), false);
  await db.update(freeReviewRounds).set({ disputeReason: "报告读错了行号", disputeAt: at }).where(eq(freeReviewRounds.id, "dispute-round"));
  bus.publish({ type: "task.review", taskId: "dispute" });
  assert.equal(await last("dispute"), true, "驳回落下：快照重发成 true");

  // ⑤ 转出时建任务失败、回滚：裁定字段恢复，原任务的快照仍是 true（没有人被留在「已裁定」上）。
  await seed("rollback", true);
  const created = await db.select({ id: tasks.id }).from(tasks);
  await db.run(sql`create trigger fail_insert before insert on tasks begin select raise(abort, 'boom'); end`);
  snapshots.length = 0;
  await assert.rejects(resolveFreeReviewDispute("rollback", "deferred"));
  await db.run(sql`drop trigger fail_insert`);
  assert.equal((await db.select({ id: tasks.id }).from(tasks)).length, created.length, "派生任务没建出来");
  assert.equal(await projected("rollback"), true, "回滚之后仍在等裁定");
  assert.equal(await last("rollback"), true, "回滚也发一声：列表拿到的仍是等你裁定");

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
