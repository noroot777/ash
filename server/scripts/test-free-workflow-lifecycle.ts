// 第 7 轮审查修复回归（从 test-free-workflow-hardening.ts 拆出，纯行数拆分）：
// 生命周期交错窗口——重启消费 write-ahead 基线、尾段逐站补跑、fresh 重跑摘牌、
// 团队派活/删除/归档与验收互斥、删除级联收孤儿、对账不提前结算活 reviewer。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-free-lifecycle-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, projects, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { reconcileFreeReviews } = await import("../src/free-workflow.js");
  const { claimTurn, releaseTurn } = await import("../src/runs.js");
  const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
  const { mountReviewerProfileRoutes } = await import("../src/reviewer-profiles.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { acceptTask } = await import("../src/task-accept.js");
  await ensureSchema();

  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Harness Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  await db.insert(projects).values({ id: "p-git", name: "git test", repoPath: repo, apiKeys: null, workflowId: null, createdAt: new Date().toISOString() });
  await db.insert(agents).values({
    id: "reviewer-executor", name: "codex@test", type: "codex", target: '{"kind":"local"}',
    model: "gpt-test", extraArgs: "[]", reasoningEffort: "high", speed: null, providerId: null, isDefault: true,
  });

  const api = new Hono();
  mountReviewerProfileRoutes(api);
  mountTaskRoutes(api);
  const created = await api.request("/reviewer-profiles", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Codex logic", agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high" }),
  });
  assert.equal(created.status, 201);
  const reviewer = await created.json() as { id: string };

  // ── 第 7 轮审查修复回归：生命周期交错窗口 ──
  const { runTask, reconcileInterrupted } = await import("../src/orchestrator.js");
  const { peekAcceptedStage, clearAcceptedSnapshot } = await import("../src/task-stage.js");
  const { recordTurnBaseline } = await import("../src/turn-baseline.js");
  const { dispatchWorkers } = await import("../src/team/dispatch.js");
  const { scheduledMessages: schedMsgs, freeWorkflowEvents: fwEvents } = await import("../src/db/schema.js");
  const baseTask = {
    projectId: "p-git", groupId: null, parentId: null, body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "preset",
  };

  // ① 启动对账不得提前结算仍活着的 reviewer：round 已有结论 + turn 被 reattach 接回
  //    （占用中）→ 原样跳过；回合真的死了才补结算。
  await createTasks([{ ...baseTask, id: "live-reviewer-task", title: "live reviewer", status: "running", workflowMode: "free" }]);
  const liveAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "live-reviewing", taskId: "live-reviewer-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: liveAt, updatedAt: liveAt, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "live-reviewing-round-1", runId: "live-reviewing", round: 1, status: "reviewing",
    conclusion: "verified", startedAt: liveAt, endedAt: null,
  });
  assert.equal(claimTurn("live-reviewer-task", "reviewer"), true);
  await reconcileFreeReviews();
  assert.equal(
    (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "live-reviewing"))).at(0)?.status,
    "reviewing", "回合仍被占（reattach 接回）时对账不得提前结算已上报的结论",
  );
  releaseTurn("live-reviewer-task");
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "live-reviewer-task"));
  await reconcileFreeReviews();
  assert.equal(
    (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "live-reviewing"))).at(0)?.status,
    "passed", "回合确实死了、结论在卷上时对账才补结算",
  );

  // ② 验收尾段逐站 durable：崩溃补跑只跑没做过的站，不重复已发生的外部副作用。
  const tailWorkflow = JSON.stringify({ workspace: "shared", steps: [
    { id: "s-run", kind: "run", p: { instruction: null, executorId: null, model: null, reasoningEffort: null }, fail: null },
    { id: "s-gate", kind: "human", p: { show: [], notify: [] }, fail: null },
    { id: "s-c1", kind: "command", p: { cmd: "echo one >> tail.log", where: "repo" }, fail: null },
    { id: "s-c2", kind: "command", p: { cmd: "echo two >> tail.log", where: "repo" }, fail: null },
  ] });
  await createTasks([{ ...baseTask, id: "tail-ledger-task", title: "tail ledger" }]);
  await db.update(tasks).set({
    workflow: tailWorkflow, workflowAt: "s-gate", stage: "accepted",
    acceptedTailPending: true, acceptedTailDone: JSON.stringify(["s-c1"]),
  }).where(eq(tasks.id, "tail-ledger-task"));
  const tailRetry = await acceptTask("tail-ledger-task");
  assert.equal(tailRetry.accepted, true);
  assert.equal(tailRetry.kind, "already_accepted", "尾段补跑走 already_accepted 快路");
  const tailLog = readFileSync(join(repo, "tail.log"), "utf8");
  assert.equal(tailLog, "two\n", "已落账的站（s-c1）不得重跑——只补执行剩下的 s-c2");
  const tailRow = (await db.select({ pending: tasks.acceptedTailPending, done: tasks.acceptedTailDone })
    .from(tasks).where(eq(tasks.id, "tail-ledger-task"))).at(0);
  assert.equal(tailRow?.pending, false, "尾段全部跑完后清 pending");
  assert.equal(tailRow?.done, "[]", "尾段全部跑完后清逐站清单");

  // ③ 重启恢复必须消费 write-ahead 基线：进程死在「快照已清、回合未结算」的窗口，
  //    reconcileInterrupted 要把验收事实整套挂回，而不是只恢复 status。
  await createTasks([{ ...baseTask, id: "wa-restart-task", title: "write-ahead restart", status: "running" }]);
  await db.update(tasks).set({
    followUpFrom: "done", stage: "accepted", acceptedTargetBranch: "main",
    acceptedBaseCommit: "base123", acceptedMergeCommit: "merge456",
    acceptedTailPending: true, acceptedTailDone: JSON.stringify(["s-c1"]),
  }).where(eq(tasks.id, "wa-restart-task"));
  const waPeeked = await peekAcceptedStage("wa-restart-task");
  assert.equal(await recordTurnBaseline("wa-restart-task", repo, false, waPeeked), true);
  await clearAcceptedSnapshot("wa-restart-task");
  await reconcileInterrupted();
  const waRow = (await db.select({
    status: tasks.status, stage: tasks.stage, target: tasks.acceptedTargetBranch,
    base: tasks.acceptedBaseCommit, merge: tasks.acceptedMergeCommit,
    pending: tasks.acceptedTailPending, done: tasks.acceptedTailDone,
  }).from(tasks).where(eq(tasks.id, "wa-restart-task"))).at(0);
  assert.equal(waRow?.status, "done", "续聊回合被打断 → 回到续聊前的终态");
  assert.equal(waRow?.stage, "accepted", "重启恢复必须消费基线，把摘掉的牌子挂回");
  assert.equal(waRow?.target, "main", "合并快照整套挂回");
  assert.equal(waRow?.base, "base123");
  assert.equal(waRow?.merge, "merge456");
  assert.equal(waRow?.pending, true, "尾段补跑凭据挂回");
  assert.equal(waRow?.done, JSON.stringify(["s-c1"]), "尾段逐站进度挂回");

  // ④ fresh 重跑（Cron/fire）启动即摘牌：新一版产出不得躲在旧「已验收」牌子下。
  await createTasks([{ ...baseTask, id: "fresh-reopen-task", title: "fresh reopen", reasoningEffort: "ultra-fake" }]);
  await db.update(tasks).set({
    stage: "accepted", acceptedTargetBranch: "main", acceptedBaseCommit: "b", acceptedMergeCommit: "m",
  }).where(eq(tasks.id, "fresh-reopen-task"));
  await runTask("fresh-reopen-task"); // 执行器解析必炸（非法思考强度），不真拉起进程
  const freshRow = (await db.select({ status: tasks.status, stage: tasks.stage, target: tasks.acceptedTargetBranch })
    .from(tasks).where(eq(tasks.id, "fresh-reopen-task"))).at(0);
  assert.equal(freshRow?.status, "failed");
  assert.equal(freshRow?.stage, null, "fresh 重跑一旦启动，旧验收牌子必须摘除");
  assert.equal(freshRow?.target, null, "合并快照随牌子一并清空");

  // ⑤ 团队派活与验收互斥：验收（含发布尾段）期间派活必须被拒，且不产生任何写入。
  await createTasks([{ ...baseTask, id: "dispatch-lock-lead", title: "dispatch lead", mode: "team" }]);
  assert.equal(beginAccepting("dispatch-lock-lead"), true);
  await assert.rejects(
    dispatchWorkers("dispatch-lock-lead", [{ body: "做点什么" }], { run: false }),
    /验收/, "验收进行中派活必须被拒",
  );
  endAccepting("dispatch-lock-lead");
  assert.equal(
    (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, "dispatch-lock-lead"))).length,
    0, "被拒的派活不得留下执行者行",
  );

  // ⑥ 删除/归档必须传播 child 的验收锁。
  await createTasks([
    { ...baseTask, id: "del-lock-lead", title: "del lead", mode: "team" },
    { ...baseTask, id: "del-lock-child", title: "del child", parentId: "del-lock-lead" },
  ]);
  assert.equal(beginAccepting("del-lock-child"), true);
  const delBlocked = await api.request("/tasks/del-lock-lead", { method: "DELETE" });
  assert.equal(delBlocked.status, 409, "child 验收（含尾段）进行中不得删除团队");
  endAccepting("del-lock-child");
  const delOk = await api.request("/tasks/del-lock-lead", { method: "DELETE" });
  assert.equal(delOk.status, 200);

  // ⑦ 删除任务级联收走审查链/预约/事件/排队消息，不留永久孤儿。
  await createTasks([{ ...baseTask, id: "cascade-task", title: "cascade", workflowMode: "free" }]);
  const cascadeAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "cascade-review", taskId: "cascade-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: cascadeAt, updatedAt: cascadeAt, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "cascade-review-round-1", runId: "cascade-review", round: 1, status: "reviewing",
    conclusion: null, startedAt: cascadeAt, endedAt: null,
  });
  await db.insert(freeWorkflowStates).values({
    taskId: "cascade-task", selectedReviewerId: reviewer.id, reviewArmed: true,
    reviewCheckMode: "logic", reviewRetryLimit: 1, reviewNote: null, reviewRunId: null, updatedAt: cascadeAt,
  });
  await db.insert(fwEvents).values({
    id: "cascade-event", taskId: "cascade-task", kind: "task_execution", source: "system",
    detail: null, occurredAt: cascadeAt,
  });
  await db.insert(schedMsgs).values({
    id: "cascade-msg", taskId: "cascade-task", text: "【答复】继续", mode: "queued",
    sendAt: cascadeAt, status: "pending", createdAt: cascadeAt, sessionRole: "reviewer",
  });
  const cascadeDel = await api.request("/tasks/cascade-task", { method: "DELETE" });
  assert.equal(cascadeDel.status, 200);
  assert.equal((await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, "cascade-task"))).length, 0, "审查链随任务删除");
  assert.equal((await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.runId, "cascade-review"))).length, 0, "轮次随任务删除");
  assert.equal((await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "cascade-task"))).length, 0, "预约槽随任务删除");
  assert.equal((await db.select().from(fwEvents).where(eq(fwEvents.taskId, "cascade-task"))).length, 0, "事件随任务删除");
  assert.equal((await db.select().from(schedMsgs).where(eq(schedMsgs.taskId, "cascade-task"))).length, 0, "排队消息随任务删除");

  console.log("✓ 生命周期交错窗口：对账不提前结算活 reviewer；尾段逐站补跑不重复副作用；重启消费 write-ahead 基线整套挂回；fresh 重跑启动即摘牌；团队派活/删除/归档与验收互斥；删除级联收走审查链孤儿");
} finally {
  rmSync(root, { recursive: true, force: true });
}
