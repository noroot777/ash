// 第 11 轮审查修复回归（ML6MSHoXU2Il r1）：回合所有权与预约槽的原子性。
// 覆盖：验收锁下 /run·/retry·/fire 不再谎报 202；duet 与 single 共用同一把单飞锁
// （模块内 running Set 已删）；once 班次撞上验收锁不被消费；就地验证轮挂着时不许归档、
// 归档任务不许答复；预约槽 CAS 消费不会抹掉用户中途保存的新预约；resumePrompt 的
// 取走/回填 CAS；旧 merge 列升级后 accepted/merged 上的遗留预约被清干净。
//
// 第 12 轮（ciajLs3YZ08S r1）续：未收尾的验证轮 / 待答复的提问不许验收、也不许 /fire
// 另起一轮；已验收任务不接受 agent 自报 stage；team 的 /run 同样受验收锁管；预约启动
// 失败要把槽还回去（但不许盖掉用户中途存的新预约）；自动续轮只在槽空着时挂。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-turn-ownership-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { freeWorkflowStates, projects, schedules, tasks } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { claimTurn, isTurnClaimed, releaseTurn } = await import("../src/runs.js");
const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { runDuet, resumeDuet } = await import("../src/duet/index.js");
const { tick } = await import("../src/schedules.js");
const {
  armFollowUpFreeReview, readFreeReviewReservation, consumeFreeReviewReservation, startReservedFreeReview,
} = await import("../src/free-review-reservations.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { acceptTask } = await import("../src/task-accept.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "turn ownership", repoPath: join(root, "repo"), apiKeys: null, workflowId: null, createdAt: stamp,
});

const baseTask = {
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single", status: "done",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "preset",
};

const api = new Hono();
mountTaskRunRoutes(api);
const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

// ── ① 验收锁下的启动入口一律 409，且不留下占着的回合 ──────────────────────────
// runTask/runDuet 撞上验收锁只会静默 return，先发 202 再撞就是谎报「已启动」。
await createTasks([
  { ...baseTask, id: "t-run", title: "run under acceptance", status: "done" },
  { ...baseTask, id: "t-retry", title: "retry under acceptance", status: "failed" },
]);
assert.equal(beginAccepting("t-run"), true);
assert.equal(beginAccepting("t-retry"), true);
for (const [path, id] of [["/tasks/t-run/run", "t-run"], ["/tasks/t-run/fire", "t-run"], ["/tasks/t-retry/retry", "t-retry"]] as const) {
  const res = await post(path);
  assert.equal(res.status, 409, `${path} 在验收锁下必须 409，实际 ${res.status}`);
  assert.equal(isTurnClaimed(id), false, `${path} 退避后必须把回合放回去`);
}
endAccepting("t-run");
endAccepting("t-retry");

// ── ② duet 与 single 共用同一把单飞锁 ─────────────────────────────────────────
// 老实现是 duet 模块内的 running Set：调用方看不见它，验收锁也挡不住它。
await createTasks([{ ...baseTask, id: "t-duet", title: "duet", mode: "duet", status: "failed", duet: JSON.stringify({ rounds: 1 }) }]);
assert.equal(claimTurn("t-duet", "single"), true);
assert.equal(await runDuet("t-duet"), false, "别人占着回合时 runDuet 必须拒绝");
assert.equal(await resumeDuet("t-duet"), false, "别人占着回合时 resumeDuet 必须拒绝");
releaseTurn("t-duet");
assert.equal(beginAccepting("t-duet"), true);
assert.equal(await runDuet("t-duet"), false, "验收锁下 runDuet 必须拒绝");
assert.equal(isTurnClaimed("t-duet"), false, "拒绝后不许留着占位");
const duetRun = await post("/tasks/t-duet/run");
assert.equal(duetRun.status, 409, "验收锁下 duet 的 /run 必须 409");

// ── ③ 撞上验收锁的 once 班次不被消费 ──────────────────────────────────────────
// 先记账后开火的老顺序会把被跳过的班永久记作已跑（once 直接 enabled=false）。
await db.insert(schedules).values({
  id: "s-once", taskId: "t-duet", kind: "once", at: new Date(Date.now() - 60_000).toISOString(),
  cron: null, enabled: true, lastRunAt: null, createdAt: stamp,
});
await tick();
const sched = (await db.select().from(schedules).where(eq(schedules.id, "s-once"))).at(0)!;
assert.equal(sched.enabled, true, "验收锁下的 once 班次不许被消费");
assert.equal(sched.lastRunAt, null);
assert.equal(isTurnClaimed("t-duet"), false, "调度器退避后必须把回合放回去");
endAccepting("t-duet");
await db.delete(schedules).where(eq(schedules.id, "s-once"));

// ── ④ 就地验证轮挂着时不许归档；归档任务不许答复 ──────────────────────────────
// 旁路结算把 status 放回原终态，verifyRound + question 都还挂着，只看 status/turn 的
// 门禁会放行，最后留下 archived=true + stage=verifying 的死局。
await createTasks([{ ...baseTask, id: "t-verify", title: "verify pending", status: "done" }]);
await db.update(tasks)
  .set({ verifyRound: 1, stage: "verifying", question: "验证者中途提问" })
  .where(eq(tasks.id, "t-verify"));
const archiveRes = await post("/tasks/t-verify/archive");
assert.equal(archiveRes.status, 409, "验证轮没结束不许归档");
assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-verify"))).at(0)!.archived, false);

await createTasks([{ ...baseTask, id: "t-frozen", title: "archived with question", status: "done" }]);
await db.update(tasks).set({ archived: true, question: "还等着答复" }).where(eq(tasks.id, "t-frozen"));
const answerRes = await post("/tasks/t-frozen/answer", { answer: "答案" });
assert.equal(answerRes.status, 409, "归档任务不许答复");
assert.equal((await db.select().from(tasks).where(eq(tasks.id, "t-frozen"))).at(0)!.question, "还等着答复", "被拒的答复不许把问题清掉");

// ── ⑤ 预约槽 CAS：结算读到的是 A，用户中途存了 B，A 不许把 B 抹掉 ──────────────
await createTasks([{ ...baseTask, id: "t-slot", title: "reservation", workflowMode: "free" }]);
await db.insert(freeWorkflowStates).values({
  taskId: "t-slot", selectedReviewerId: "rev-A", reviewArmed: true, reviewCheckMode: "logic",
  reviewRetryLimit: 1, reviewNote: null, reviewRunId: null, updatedAt: stamp,
});
const snapshotA = await readFreeReviewReservation("t-slot");
assert.equal(snapshotA?.reviewerId, "rev-A");
// 用户把预约改成了 B（任何一次保存都会推进 updatedAt）
await db.update(freeWorkflowStates)
  .set({ selectedReviewerId: "rev-B", updatedAt: new Date(Date.now() + 1000).toISOString() })
  .where(eq(freeWorkflowStates.taskId, "t-slot"));
assert.equal(await consumeFreeReviewReservation("t-slot", snapshotA), null, "过期快照不许消费");
const afterStale = (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "t-slot"))).at(0)!;
assert.equal(afterStale.reviewArmed, true, "用户新存的预约必须还在");
assert.equal(afterStale.selectedReviewerId, "rev-B");
// 结算拿着过期快照进来：重读一次，按最新那条 B 启动，并且只消费一次。
const started: string[] = [];
await startReservedFreeReview("t-slot", snapshotA, {
  continueRun: async (runId) => { started.push(`continue:${runId}`); },
  startNew: async (input) => { started.push(`new:${input.reviewerId}`); },
});
assert.deepEqual(started, ["new:rev-B"], "过期快照必须重读后按最新预约启动");
assert.equal((await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "t-slot"))).at(0)!.reviewArmed, false);
// 已经消费掉的槽再来一次什么都不做
await startReservedFreeReview("t-slot", snapshotA, {
  continueRun: async () => { started.push("continue:again"); },
  startNew: async () => { started.push("new:again"); },
});
assert.deepEqual(started, ["new:rev-B"], "空槽不许再启动一轮");

// ── ⑥ resumePrompt 的取走/回填都要 CAS ────────────────────────────────────────
// 两路并发续跑抢同一段 checkpoint 指令：没送出去的必须原样回位（前半），而回位时若
// agent 已经写下新的一段，迟到的旧值不许盖上去（后半）。
await createTasks([{ ...baseTask, id: "t-resume", title: "checkpoint", status: "paused" }]);
await db.update(tasks).set({ resumePrompt: "继续：跑 tts 那一段" }).where(eq(tasks.id, "t-resume"));
// 别处占着回合 → continueTask/runTask 都启动不了，两路都走到「没送出去」这一支。
assert.equal(claimTurn("t-resume", "blocker"), true);
await Promise.all([resumeOrRunTask("t-resume"), resumeOrRunTask("t-resume")]);
releaseTurn("t-resume");
assert.equal(
  (await db.select().from(tasks).where(eq(tasks.id, "t-resume"))).at(0)!.resumePrompt,
  "继续：跑 tts 那一段",
  "没送出去的 checkpoint 指令必须回到原位",
);
// 回填的 CAS：取走之后、回填之前，agent 可能已经 pause_task 写下了**新的**一段，
// 迟到的旧值不许盖上去。窗口是 continueTask 里那一次 DB 查询——本地 libsql 是同步的，
// 两条链只在 microtask 边界交错，所以用 `await Promise.resolve()` 逐拍推进来卡进去
// （setImmediate 太粗，整段会在第一个宏任务前跑完）。
assert.equal(claimTurn("t-resume", "blocker"), true);
let settled = false;
const pending = resumeOrRunTask("t-resume").then(() => { settled = true; });
let caught = false;
for (let i = 0; i < 200 && !settled && !caught; i++) {
  await Promise.resolve();
  const row = (await db.select({ rp: tasks.resumePrompt }).from(tasks).where(eq(tasks.id, "t-resume"))).at(0);
  if (row && row.rp === null) {
    await db.update(tasks).set({ resumePrompt: "继续：换成新的一段" }).where(eq(tasks.id, "t-resume"));
    caught = true;
  }
}
await pending;
releaseTurn("t-resume");
assert.equal(caught, true, "没能卡进回填窗口，这条 CAS 断言就没测到东西");
assert.equal(
  (await db.select().from(tasks).where(eq(tasks.id, "t-resume"))).at(0)!.resumePrompt,
  "继续：换成新的一段",
  "迟到的回填不许盖掉 agent 新写的 checkpoint 指令",
);

// ── ⑦ 旧 merge 列升级：stage 补完之后，accepted/merged 上的遗留预约必须被清掉 ────
// 清理只跑在合并状态迁移之前的话，老库那时 stage 还是空的，一行都匹配不到；旧 merge
// 列随后就被删了，预约永久留存，日后 reopen 再确认完成就是一轮幽灵审查。
await dbClient.execute("ALTER TABLE free_workflow_states ADD COLUMN merge_status TEXT");
await dbClient.execute("ALTER TABLE free_workflow_states ADD COLUMN merge_message TEXT");
await dbClient.execute("ALTER TABLE free_workflow_states ADD COLUMN merged_at TEXT");
await createTasks([
  { ...baseTask, id: "old-merged", title: "legacy merged", workflowMode: "free" },
  { ...baseTask, id: "old-merging", title: "legacy merging", workflowMode: "free" },
]);
for (const [taskId, mergeStatus] of [["old-merged", "merged"], ["old-merging", "merging"]] as const) {
  await db.insert(freeWorkflowStates).values({
    taskId, selectedReviewerId: "rev-legacy", reviewArmed: true, reviewCheckMode: "logic",
    reviewRetryLimit: 1, reviewNote: "旧生命周期留下的预约", reviewRunId: null, updatedAt: stamp,
  });
  await dbClient.execute({
    sql: "UPDATE free_workflow_states SET merge_status = ? WHERE task_id = ?",
    args: [mergeStatus, taskId],
  });
}
await ensureSchema(); // 模拟一次真实升级启动
for (const [taskId, expectedStage] of [["old-merged", "accepted"], ["old-merging", "merged"]] as const) {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  assert.equal(row.stage, expectedStage, `${taskId} 的 stage 应恢复成 ${expectedStage}`);
  const state = (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId))).at(0)!;
  assert.equal(state.reviewArmed, false, `${taskId} 的遗留预约必须在 stage 补完后被清掉`);
  assert.equal(state.reviewNote, null);
}

// ── ⑧ 未收尾的验证轮 / 提问态不许验收 ─────────────────────────────────────────
// 两者都不体现在 status 上（旁路结算把 status 放回原终态），只看 status/turn 锁的门禁
// 会放行：验证轮回来会拿结论盖掉 accepted，答复会 resume 会话继续往一个已经合并、
// 已经删掉的 worktree 里写（审查实测：验收后 done|accepted|verify_round=1|question 仍在，
// 再 POST /answer 仍 200）。
await createTasks([
  { ...baseTask, id: "t-acc-verify", title: "accept during verify", status: "done" },
  { ...baseTask, id: "t-acc-ask", title: "accept while asking", status: "paused" },
]);
await db.update(tasks).set({ verifyRound: 2, stage: "verifying" }).where(eq(tasks.id, "t-acc-verify"));
await db.update(tasks).set({ question: "这两个方案选哪个" }).where(eq(tasks.id, "t-acc-ask"));
const verifyAccept = await acceptTask("t-acc-verify");
assert.equal(verifyAccept.accepted, false, "验证轮没出结论时不许验收");
if (!verifyAccept.accepted) assert.equal(verifyAccept.reason, "verify_round_in_flight");
const askAccept = await acceptTask("t-acc-ask");
assert.equal(askAccept.accepted, false, "提问态不许验收");
if (!askAccept.accepted) assert.equal(askAccept.reason, "question_pending");
for (const id of ["t-acc-verify", "t-acc-ask"]) {
  const row = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
  assert.notEqual(row.stage, "accepted", `${id} 被拒的验收不许留下 accepted`);
}

// ── ⑨ 已验收的任务不接受 agent 自报阶段 ───────────────────────────────────────
// stage 是单值字段：一次 report_stage 就把 accepted 覆盖成 verified，验收事实无处可查。
const stageApi = new Hono();
mountTaskStageRoutes(stageApi);
await createTasks([{ ...baseTask, id: "t-accepted", title: "already accepted", status: "done" }]);
await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, "t-accepted"));
const stageRes = await stageApi.request("/tasks/t-accepted/stage", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ stage: "verified" }),
});
assert.equal(stageRes.status, 409, "已验收任务的 report_stage 必须 409");
assert.equal(
  (await db.select().from(tasks).where(eq(tasks.id, "t-accepted"))).at(0)!.stage,
  "accepted",
  "被拒的上报不许改动验收阶段",
);

// ── ⑩ /fire 不许顶着未收尾的验证轮 / 提问态另起一轮 ───────────────────────────
// fresh 一轮下去，轮次号还挂在任务身上，新起的执行会被 sideTurn 判据当成这一轮验证的
// 续跑，最后拿它的收尾当验证结论；提问态则是把 agent 停在半路等的那个问题一起丢掉。
await createTasks([
  { ...baseTask, id: "t-fire-verify", title: "fire during verify", status: "done" },
  { ...baseTask, id: "t-fire-ask", title: "fire while asking", status: "paused" },
]);
await db.update(tasks).set({ verifyRound: 1 }).where(eq(tasks.id, "t-fire-verify"));
await db.update(tasks).set({ question: "等你拍板" }).where(eq(tasks.id, "t-fire-ask"));
for (const id of ["t-fire-verify", "t-fire-ask"]) {
  const res = await post(`/tasks/${id}/fire`);
  assert.equal(res.status, 409, `${id} 的 /fire 必须 409，实际 ${res.status}`);
  assert.equal(isTurnClaimed(id), false, `${id} 被拒后不许留着占位`);
}

// ── ⑪ 团队 /run 同样受验收锁管 ────────────────────────────────────────────────
// team 分支早先排在 claimTurn / isAcceptingTask **之前**直接 202，验收进行中照样
// startTeam：用户看到「已启动」，调度台其实撞上验收锁（审查实测）。
await createTasks([{ ...baseTask, id: "t-team-run", title: "team under acceptance", mode: "team", status: "idle" }]);
assert.equal(beginAccepting("t-team-run"), true);
const teamRun = await post("/tasks/t-team-run/run");
assert.equal(teamRun.status, 409, "验收锁下 team 的 /run 必须 409");
assert.equal(isTurnClaimed("t-team-run"), false, "team 退避后必须把占位放回去");
endAccepting("t-team-run");

// ── ⑫ 预约启动失败要把槽还回去 ────────────────────────────────────────────────
// CAS 消费已经把槽清空了，启动又抛在半路 —— 不还回去这条预约就永久蒸发：既没跑也不在
// 了，用户下次确认完成时什么都不会发生，界面上只剩一行失败时间线（审查实测）。
await createTasks([{ ...baseTask, id: "t-arm-fail", title: "reservation rollback", workflowMode: "free" }]);
await db.insert(freeWorkflowStates).values({
  taskId: "t-arm-fail", selectedReviewerId: "rev-X", reviewArmed: true, reviewCheckMode: "logic",
  reviewRetryLimit: 1, reviewNote: null, reviewRunId: null, updatedAt: stamp,
});
await startReservedFreeReview("t-arm-fail", await readFreeReviewReservation("t-arm-fail"), {
  continueRun: async () => { throw new Error("不该走这条"); },
  startNew: async () => { throw new Error("派审失败"); },
});
const rolledBack = (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "t-arm-fail"))).at(0)!;
assert.equal(rolledBack.reviewArmed, true, "启动失败必须把预约放回槽里");
assert.equal(rolledBack.selectedReviewerId, "rev-X");
// 但如果用户在启动失败之前就存了新预约，回滚不许把它盖掉（CAS 令牌对不上）。
await startReservedFreeReview("t-arm-fail", await readFreeReviewReservation("t-arm-fail"), {
  continueRun: async () => { throw new Error("不该走这条"); },
  startNew: async () => {
    await db.update(freeWorkflowStates)
      .set({ reviewArmed: true, selectedReviewerId: "rev-Y", updatedAt: new Date(Date.now() + 5000).toISOString() })
      .where(eq(freeWorkflowStates.taskId, "t-arm-fail"));
    throw new Error("派审失败");
  },
});
const afterUserEdit = (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "t-arm-fail"))).at(0)!;
assert.equal(afterUserEdit.selectedReviewerId, "rev-Y", "回滚不许盖掉用户中途存的新预约");
assert.equal(afterUserEdit.reviewArmed, true);

// ── ⑬ 自动续轮只在槽空着时挂 ──────────────────────────────────────────────────
// 槽里已经 armed = 用户在这一轮审查期间自己预约了下一条，那是他的最新意思；无条件
// onConflictDoUpdate 会把 reviewRunId 改写成本链的 run，用户预约的新审查链再也不会开。
await createTasks([{ ...baseTask, id: "t-arm-follow", title: "follow-up reservation", workflowMode: "free" }]);
const runA = { id: "run-A", reviewerId: "rev-A", checkMode: "logic", retryLimit: 1 };
assert.equal(await armFollowUpFreeReview("t-arm-follow", runA, stamp), true, "空槽必须挂上续轮预约");
await db.update(freeWorkflowStates)
  .set({ reviewArmed: true, reviewRunId: null, selectedReviewerId: "rev-user", updatedAt: new Date(Date.now() + 1000).toISOString() })
  .where(eq(freeWorkflowStates.taskId, "t-arm-follow"));
assert.equal(
  await armFollowUpFreeReview("t-arm-follow", { ...runA, id: "run-B" }, new Date(Date.now() + 2000).toISOString()),
  false,
  "槽里有用户预约时不许挂续轮",
);
const keptUser = (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "t-arm-follow"))).at(0)!;
assert.equal(keptUser.selectedReviewerId, "rev-user", "用户的预约必须原样留着");
assert.equal(keptUser.reviewRunId, null, "用户预约的 runId 不许被续轮改写");
await db.update(freeWorkflowStates).set({ reviewArmed: false }).where(eq(freeWorkflowStates.taskId, "t-arm-follow"));
assert.equal(
  await armFollowUpFreeReview("t-arm-follow", { ...runA, id: "run-C" }, new Date(Date.now() + 3000).toISOString()),
  true,
  "槽空出来之后照常挂",
);
assert.equal(
  (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "t-arm-follow"))).at(0)!.reviewRunId,
  "run-C",
);

console.log("turn-ownership regressions ok");
process.exit(0);