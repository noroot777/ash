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

  // ── 第 8 轮审查修复回归 ──
  const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
  const { api: rootApi } = await import("../src/routes.js");
  const { setTaskStatus } = await import("../src/status.js");
  const { freeWorkflowState } = await import("../src/free-workflow-state.js");
  const { tick } = await import("../src/schedules.js");
  const { schedules, scheduledMessages: schedMsgs2, sessions: sessionRows, queueItems: queueRows } = await import("../src/db/schema.js");
  const runApi = new Hono();
  mountTaskRunRoutes(runApi);

  // ⑧ dispatch 与验收共用一把占位互斥：派活结束锁必须释放，期间验收按在途拒绝。
  await createTasks([{ ...baseTask, id: "cas-lead", title: "cas lead", mode: "team" }]);
  assert.equal(beginAccepting("cas-lead"), true);
  await assert.rejects(dispatchWorkers("cas-lead", [{ body: "x" }], { run: false }), /验收/);
  endAccepting("cas-lead");
  await dispatchWorkers("cas-lead", [{ body: "真派一个" }], { run: false });
  assert.equal(beginAccepting("cas-lead"), true, "派活正常结束后互斥锁必须释放（对称 endAccepting）");
  endAccepting("cas-lead");

  // ⑨ 验收锁期间 fire 端点 409（不再谎报 202）；once/cron 班次不消费、解锁后补跑。
  await createTasks([{ ...baseTask, id: "sched-task", title: "sched", reasoningEffort: "ultra-fake" }]);
  assert.equal(beginAccepting("sched-task"), true);
  const fireBlocked = await runApi.request("/tasks/sched-task/fire", { method: "POST" });
  assert.equal(fireBlocked.status, 409, "验收期间手动触发必须如实拒绝");
  const pastAt = new Date(Date.now() - 60_000).toISOString();
  await db.insert(schedules).values({
    id: "sched-once", taskId: "sched-task", kind: "once", at: pastAt, cron: null,
    enabled: true, lastRunAt: null, createdAt: pastAt,
  });
  await tick();
  let schedRow = (await db.select().from(schedules).where(eq(schedules.id, "sched-once"))).at(0);
  assert.equal(schedRow?.enabled, true, "验收锁内 once 班次不得被消费（enabled 保持）");
  assert.equal(schedRow?.lastRunAt, null, "验收锁内 once 不得记 lastRunAt");
  endAccepting("sched-task");
  await tick();
  schedRow = (await db.select().from(schedules).where(eq(schedules.id, "sched-once"))).at(0);
  assert.equal(schedRow?.enabled, false, "解锁后的下一个 tick 应正常消费 once 班次");
  assert.equal(!!schedRow?.lastRunAt, true);

  // ⑩ 尾段失败不清补跑凭据：失败站与后续站保留补跑入口，修好后再次验收接着跑。
  const tailFailWorkflow = JSON.stringify({ workspace: "shared", steps: [
    { id: "f-run", kind: "run", p: { instruction: null, executorId: null, model: null, reasoningEffort: null }, fail: null },
    { id: "f-gate", kind: "human", p: { show: [], notify: [] }, fail: null },
    { id: "f-c1", kind: "command", p: { cmd: "echo one >> tail2.log", where: "repo" }, fail: null },
    { id: "f-c2", kind: "command", p: { cmd: "test -f tail2.flag && echo two >> tail2.log", where: "repo" }, fail: null },
    { id: "f-c3", kind: "command", p: { cmd: "echo three >> tail2.log", where: "repo" }, fail: null },
  ] });
  await createTasks([{ ...baseTask, id: "tail-fail-task", title: "tail fail" }]);
  await db.update(tasks).set({
    workflow: tailFailWorkflow, workflowAt: "f-gate", stage: "accepted",
    acceptedTailPending: true, acceptedTailDone: "[]",
  }).where(eq(tasks.id, "tail-fail-task"));
  const tailFirst = await acceptTask("tail-fail-task");
  assert.equal(tailFirst.accepted, true);
  assert.equal((tailFirst as { tail?: { ok: boolean } }).tail?.ok, false, "f-c2 失败要如实报告");
  let tailFailRow = (await db.select({ pending: tasks.acceptedTailPending, done: tasks.acceptedTailDone })
    .from(tasks).where(eq(tasks.id, "tail-fail-task"))).at(0);
  assert.equal(tailFailRow?.pending, true, "尾段失败后补跑凭据必须保留");
  assert.equal(tailFailRow?.done, JSON.stringify(["f-c1"]), "已完成的站留在逐站清单");
  writeFileSync(join(repo, "tail2.flag"), "ok\n");
  const tailSecond = await acceptTask("tail-fail-task");
  assert.equal(tailSecond.accepted, true);
  assert.equal((tailSecond as { tail?: { ok: boolean } }).tail?.ok, true);
  assert.equal(readFileSync(join(repo, "tail2.log"), "utf8"), "one\ntwo\nthree\n",
    "补跑只执行失败站与后续站，已完成的 one 不重复");
  tailFailRow = (await db.select({ pending: tasks.acceptedTailPending, done: tasks.acceptedTailDone })
    .from(tasks).where(eq(tasks.id, "tail-fail-task"))).at(0);
  assert.equal(tailFailRow?.pending, false);
  assert.equal(tailFailRow?.done, "[]");

  // ⑪ 项目删除传播生命周期锁，并复用同一份级联（不留 state/event/message/queue/session/schedule 孤儿）。
  const projDel = await rootApi.request("/projects", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "del-proj", repoPath: join(root, "del-proj-repo") }),
  });
  assert.equal(projDel.status, 201);
  const delProject = await projDel.json() as { id: string };
  await createTasks([{ ...baseTask, id: "proj-task", title: "proj task", projectId: delProject.id, workflowMode: "free" }]);
  const projAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "proj-review", taskId: "proj-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: projAt, updatedAt: projAt, finishedAt: null,
  });
  await db.insert(freeWorkflowStates).values({
    taskId: "proj-task", selectedReviewerId: reviewer.id, reviewArmed: true,
    reviewCheckMode: "logic", reviewRetryLimit: 1, reviewNote: null, reviewRunId: null, updatedAt: projAt,
  });
  await db.insert(schedMsgs2).values({
    id: "proj-msg", taskId: "proj-task", text: "x", mode: "queued", sendAt: projAt, status: "pending", createdAt: projAt,
  });
  await db.insert(schedules).values({
    id: "proj-sched", taskId: "proj-task", kind: "cron", at: null, cron: "0 0 * * *",
    enabled: true, lastRunAt: null, createdAt: projAt,
  });
  assert.equal(beginAccepting("proj-task"), true);
  const projBlocked = await rootApi.request(`/projects/${delProject.id}`, { method: "DELETE" });
  assert.equal(projBlocked.status, 409, "项目下有任务在验收（含尾段）时不得删除项目");
  endAccepting("proj-task");
  const projDeleted = await rootApi.request(`/projects/${delProject.id}`, { method: "DELETE" });
  assert.equal(projDeleted.status, 200);
  assert.equal((await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, "proj-task"))).length, 0, "项目删除级联收审查链");
  assert.equal((await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "proj-task"))).length, 0, "项目删除级联收预约槽");
  assert.equal((await db.select().from(schedMsgs2).where(eq(schedMsgs2.taskId, "proj-task"))).length, 0, "项目删除级联收排队消息");
  assert.equal((await db.select().from(schedules).where(eq(schedules.taskId, "proj-task"))).length, 0, "项目删除级联收定时计划");

  // ⑫ 投递租约挂着的消息不可取消（取消成功=谎报，原文可能已送达）。
  await createTasks([{ ...baseTask, id: "msg-task", title: "msg task" }]);
  const msgAt = new Date().toISOString();
  await db.insert(schedMsgs2).values({
    id: "leased-msg", taskId: "msg-task", text: "在途消息", mode: "queued",
    sendAt: msgAt, status: "pending", createdAt: msgAt, deliveringSince: msgAt,
  });
  const cancelLeased = await runApi.request("/scheduled-messages/leased-msg", { method: "DELETE" });
  assert.equal(cancelLeased.status, 409, "租约挂着时取消必须被拒");
  await db.update(schedMsgs2).set({ deliveringSince: null }).where(eq(schedMsgs2.id, "leased-msg"));
  const cancelFree = await runApi.request("/scheduled-messages/leased-msg", { method: "DELETE" });
  assert.equal(cancelFree.status, 200, "租约还回去之后可以正常取消");

  // ⑬ stateVersion 覆盖 task.status：execution 变化必须带来更大的版本，不被前端拒收。
  await createTasks([{ ...baseTask, id: "sv-task", title: "sv task", workflowMode: "free" }]);
  const svBefore = await freeWorkflowState("sv-task");
  await setTaskStatus("sv-task", "failed");
  const svAfter = await freeWorkflowState("sv-task");
  assert.equal(svAfter.stateVersion > svBefore.stateVersion, true, "task.status 变化必须 bump 修订号");
  assert.equal(svAfter.executions.at(-1)?.status, "failed");

  // ⑭ 并发 answer 只有一个能执行（CAS 清问题）。占住 turn 避免真投递（答复落排队）。
  await createTasks([{ ...baseTask, id: "ans-task", title: "ans task", status: "paused", reasoningEffort: "ultra-fake" }]);
  await db.update(tasks).set({ question: "选 A 还是 B？" }).where(eq(tasks.id, "ans-task"));
  assert.equal(claimTurn("ans-task"), true);
  const firstAnswer = await runApi.request("/tasks/ans-task/answer", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "A1" }),
  });
  assert.equal(firstAnswer.status, 200);
  const secondAnswer = await runApi.request("/tasks/ans-task/answer", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "A2" }),
  });
  assert.equal(secondAnswer.status, 409, "问题已被第一次答复清掉，第二次必须拒绝");

  // ⑮ 归档团队：running 但无 handle/turn 的执行者先落格再归档，不得留下 archived+running。
  await createTasks([
    { ...baseTask, id: "arch-lead", title: "arch lead", mode: "team" },
    { ...baseTask, id: "arch-child", title: "arch child", parentId: "arch-lead", status: "running" },
  ]);
  const archived = await runApi.request("/tasks/arch-lead/archive", { method: "POST" });
  assert.equal(archived.status, 200);
  const archChild = (await db.select({ status: tasks.status, archived: tasks.archived })
    .from(tasks).where(eq(tasks.id, "arch-child"))).at(0);
  assert.equal(archChild?.archived, true);
  assert.equal(archChild?.status, "failed", "无 handle 的 running 执行者按重启残留口径落格，不得 archived+running");

  // ── 第 9 轮审查修复回归 ──
  const { acceptSharedTeamWorkers } = await import("../src/task-accept-shared-workers.js");
  const { groups: groupRows } = await import("../src/db/schema.js");
  const { mountReviewRoutes } = await import("../src/review.js");
  const reviewApi = new Hono();
  mountReviewRoutes(reviewApi);

  // ⑯ turn 已占（claim→running 窗口）时 run/retry/fire 必须 409，班次不消费。
  await createTasks([{ ...baseTask, id: "turn-window-task", title: "turn window", status: "failed" }]);
  assert.equal(claimTurn("turn-window-task"), true);
  const runBlocked = await runApi.request("/tasks/turn-window-task/run", { method: "POST" });
  assert.equal(runBlocked.status, 409, "turn 被占时 /run 不得谎报 202");
  const retryBlocked = await runApi.request("/tasks/turn-window-task/retry", { method: "POST" });
  assert.equal(retryBlocked.status, 409, "turn 被占时 /retry 不得谎报 202");
  const fireBlockedTurn = await runApi.request("/tasks/turn-window-task/fire", { method: "POST" });
  assert.equal(fireBlockedTurn.status, 409, "turn 被占时 /fire 不得谎报 202");
  const turnPast = new Date(Date.now() - 60_000).toISOString();
  await db.insert(schedules).values({
    id: "turn-once", taskId: "turn-window-task", kind: "once", at: turnPast, cron: null,
    enabled: true, lastRunAt: null, createdAt: turnPast,
  });
  await tick();
  let turnSched = (await db.select().from(schedules).where(eq(schedules.id, "turn-once"))).at(0);
  assert.equal(turnSched?.enabled, true, "turn 被占时 once 班次不得被消费");
  assert.equal(turnSched?.lastRunAt, null);
  releaseTurn("turn-window-task");
  await db.update(schedules).set({ enabled: false }).where(eq(schedules.id, "turn-once"));

  // ⑰ 团队验收不得把 backlog/paused 的共享执行者盖成 accepted。
  await createTasks([
    { ...baseTask, id: "cover-lead", title: "cover lead", mode: "team" },
    { ...baseTask, id: "cover-done", title: "done worker", parentId: "cover-lead" },
    { ...baseTask, id: "cover-backlog", title: "backlog worker", parentId: "cover-lead", status: "backlog" },
  ]);
  const coverAccept = await acceptTask("cover-lead");
  assert.equal(coverAccept.accepted, false, "有 backlog 共享执行者时团队验收必须被挡");
  if (!coverAccept.accepted) assert.equal(coverAccept.reason, "shared_team_workers_in_flight");
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, "cover-backlog"));
  const coverAccept2 = await acceptTask("cover-lead");
  assert.equal(coverAccept2.accepted, false, "有 paused 共享执行者时团队验收必须被挡");
  // 联动纵深防御：即使绕过 guard 直接联动，也只盖终态的执行者。
  await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, "cover-backlog"));
  const linked = await acceptSharedTeamWorkers("cover-lead");
  assert.equal(
    (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, "cover-backlog"))).at(0)?.stage,
    null, "联动绝不给非终态执行者盖验收章",
  );
  assert.equal(linked.updated, 1, "done 的执行者照常联动");

  // ⑱ preset 手动派验证与普通回合原子互斥（holdTurn）。
  await createTasks([{ ...baseTask, id: "verify-window-task", title: "verify window" }]);
  assert.equal(claimTurn("verify-window-task"), true);
  const verifyBlocked = await reviewApi.request("/tasks/verify-window-task/review/dispatch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(verifyBlocked.status, 400, "turn 被占时手动派验证必须被拒");
  const verifyRow = (await db.select({ verifyRound: tasks.verifyRound, stage: tasks.stage })
    .from(tasks).where(eq(tasks.id, "verify-window-task"))).at(0);
  assert.equal(verifyRow?.verifyRound, null, "被拒的派验证不得写 verifyRound");
  assert.equal(verifyRow?.stage, null, "被拒的派验证不得写 stage=verifying");
  releaseTurn("verify-window-task");

  // ⑲ 删除团队 lead 级联收走内部组；启动迁移回收存量孤儿组。
  await createTasks([{ ...baseTask, id: "grp-lead", title: "grp lead", mode: "team" }]);
  await dispatchWorkers("grp-lead", [{ body: "活" }], { run: false });
  assert.equal(
    (await db.select().from(groupRows).where(eq(groupRows.ownerTaskId, "grp-lead"))).length, 1,
    "派活会建内部组",
  );
  const grpDel = await api.request("/tasks/grp-lead", { method: "DELETE" });
  assert.equal(grpDel.status, 200);
  assert.equal(
    (await db.select().from(groupRows).where(eq(groupRows.ownerTaskId, "grp-lead"))).length, 0,
    "删除 lead 必须级联收走内部组",
  );

  // ⑳ 旧自由工作流合并状态迁移：merged 补 stage，merging/failed 留可见说明，不删证据。
  const { ensureSchema: ensureAgain } = await import("../src/db/index.js");
  for (const sql of [
    "ALTER TABLE free_workflow_states ADD COLUMN merge_status TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN merge_message TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN merged_at TEXT",
  ]) {
    try { await db.run(sql as never); } catch { /* 已存在 */ }
  }
  await createTasks([
    { ...baseTask, id: "mig-merged", title: "mig merged", workflowMode: "free" },
    { ...baseTask, id: "mig-merging", title: "mig merging", workflowMode: "free" },
  ]);
  const migAt = new Date().toISOString();
  for (const [tid, ms] of [["mig-merged", "merged"], ["mig-merging", "merging"]] as const) {
    await db.run(`INSERT INTO free_workflow_states (task_id, review_armed, updated_at, merge_status, merge_message)
      VALUES ('${tid}', 0, '${migAt}', '${ms}', NULL)` as never);
  }
  await ensureAgain();
  const migMerged = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, "mig-merged"))).at(0);
  assert.equal(migMerged?.stage, "accepted", "旧 merge_status=merged 必须补上验收标记");
  const migMerging = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, "mig-merging"))).at(0);
  assert.equal(migMerging?.stage, null, "merging 不可知，不得伪造 stage");

  console.log("✓ 生命周期交错窗口：对账不提前结算活 reviewer；尾段逐站补跑不重复副作用；重启消费 write-ahead 基线整套挂回；fresh 重跑启动即摘牌；团队派活/删除/归档与验收互斥；删除级联收走审查链孤儿；派活占位互斥对称释放；验收锁内班次不丢不谎报；尾段失败保留补跑凭据；项目删除锁+级联；租约中消息不可取消；stateVersion 覆盖 status；并发 answer CAS；归档不留 archived+running；turn 窗口 run/retry/fire/班次不谎报不消费；团队验收不盖未执行的执行者；手动派验证原子互斥；内部组级联+孤儿回收；旧合并状态迁移不丢证据");
} finally {
  rmSync(root, { recursive: true, force: true });
}
