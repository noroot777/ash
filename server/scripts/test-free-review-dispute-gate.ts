// 「驳回还没裁定时，预约的审查不许开跑」这道裁定闸，以及预约来源字段的回归。
//
// 现场（MNW4en5L0iPP，2026-11-02）：执行者 15:52 驳回第 2 轮意见，20 秒后它那个驳回回合
// 正常结束，结算照常消费了用户早先手存的预约，裁定还没做审查就开跑了。驳回只撤 runId 非空
// 的自动续轮，而消费侧对「等裁定」一无所知。所以这里钉三件事：
// ① 驳回未裁定 + 任意来源的预约 + 执行回合正常结束 → 不开审、预约原样 armed、时间线留痕；
// ② 裁定落地之后，下一个执行回合正常结束 → 预约照常触发；
// ③ 既有路径不变：没有驳回时照常触发；驳回按**来源**撤自动续轮、留用户手存；启动失败回滚
//    把来源原样带回；修复回合异常结束只撤自动续轮。
//
// 全程占着各任务的回合（同 test-free-review-dispute.ts 的理由）：起审靠 continueWhenIdle
// 排队，回合占着就只排队不起跑，不会真拉起执行器。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-review-dispute-gate-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const {
    agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, projects, reviewerProfiles, sessions, tasks,
  } = await import("../src/db/schema.js");
  type Source = typeof freeWorkflowStates.$inferSelect["reviewSource"];
  const { createTasks } = await import("../src/task-store.js");
  const { claimTurn } = await import("../src/runs.js");
  const { disputeFreeReview, openDisputeOf, resolveFreeReviewDispute } = await import("../src/free-review-dispute.js");
  const { handleFreeWorkflowSettlement, reserveFreeReview, startFreeReview } = await import("../src/free-workflow.js");
  const {
    armFollowUpFreeReview, readFreeReviewReservation, startReservedFreeReview,
  } = await import("../src/free-review-reservations.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "gate", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "codex@test", type: "codex", model: "gpt-test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "逻辑审查者", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  /** 一个「最近一轮审查未通过、停着等处理」的自由任务，带一条会话好让时间线落盘。 */
  async function seed(id: string): Promise<{ runId: string; roundId: string }> {
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.insert(sessions).values({
      id: `${id}-session`, taskId: id, role: "single", agentType: "codex", executor: "codex@test", startedAt: at,
    });
    const runId = `${id}-run`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "逻辑审查者", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1,
      status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
    });
    const roundId = `${runId}-round`;
    await db.insert(freeReviewRounds).values({
      id: roundId, runId, round: 1, status: "failed", conclusion: "verify_failed",
      reportMarkdown: "第 3 行的 null 检查缺失", startedAt: at, endedAt: at,
    });
    assert.equal(claimTurn(id, "single"), true);
    return { runId, roundId };
  }
  const reserveAsUser = (id: string) => reserveFreeReview(id, { reviewerId: "reviewer", checkMode: "logic", retryLimit: 1 });
  const dispute = (id: string) => disputeFreeReview(id, {
    summary: "报告看错了文件，这条我不认。", reason: "第 3 行是生成代码，不在本次改动里", deferReason: null,
  });
  /** 执行回合正常结束（驳回回合不调 complete_task，所以落 failed + turnOk）。 */
  const settleTurn = async (id: string, status: "done" | "failed" = "failed") => {
    await db.update(tasks).set({ status }).where(eq(tasks.id, id));
    await handleFreeWorkflowSettlement(id, status, status === "done", true);
  };
  const runsOf = (id: string) => db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, id));
  const slotOf = async (id: string) => (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, id))).at(0);
  const timeline = (id: string) => readFileSync(sessionTranscriptPath(id, `${id}-session`), "utf8");
  const writeSlot = async (id: string, source: Source, runId: string | null) => {
    const slot = {
      selectedReviewerId: "reviewer", reviewArmed: true, reviewCheckMode: "logic", reviewRetryLimit: 1,
      reviewRunId: runId, reviewSource: source, updatedAt: new Date().toISOString(),
    };
    await db.insert(freeWorkflowStates).values({ taskId: id, ...slot })
      .onConflictDoUpdate({ target: freeWorkflowStates.taskId, set: slot });
  };

  // ── 写入点各自记下来源 ──
  const sources = await seed("g-sources");
  await reserveAsUser("g-sources");
  assert.equal((await slotOf("g-sources"))?.reviewSource, "user", "用户在面板里保存的预约记作 user");
  await db.update(freeWorkflowStates).set({ reviewArmed: false }).where(eq(freeWorkflowStates.taskId, "g-sources"));
  assert.equal(await armFollowUpFreeReview("g-sources", {
    id: sources.runId, reviewerId: "reviewer", checkMode: "logic", retryLimit: 1,
  }, new Date().toISOString()), true);
  assert.equal((await slotOf("g-sources"))?.reviewSource, "follow_up", "结算自动挂的续轮记作 follow_up");

  // ── ① 现场原样：用户手存预约 → 执行者驳回 → 驳回回合正常结束 ──
  const live = await seed("g-live");
  await reserveAsUser("g-live");
  await dispute("g-live");
  assert.equal((await slotOf("g-live"))?.reviewArmed, true, "驳回不撤用户手存的预约");
  await settleTurn("g-live");
  assert.equal((await runsOf("g-live")).length, 1, "驳回未裁定时，执行回合正常结束也不得开审（现场就是这一步漏了）");
  const held = await slotOf("g-live");
  assert.equal(held?.reviewArmed, true, "被闸挡下的预约原样留着，等裁定后继续");
  assert.equal(held?.reviewSource, "user", "留着的还是用户那条，来源不变");
  assert.match(timeline("g-live"), /预约审查仍在等待：执行者驳回了上一轮审查意见，正等你裁定/,
    "挡下来必须留持久痕迹：刷新后看得出预约为什么没开");
  assert.ok(await openDisputeOf("g-live"), "闸不碰驳回本身，它仍在等裁定");

  // 闸只看「此刻有没有未裁定的驳回」，不看来源：哪怕槽里是一条续轮/接力导入的预约
  // （驳回之后才写进来的，比如并发回滚），也一样挡。
  for (const source of ["follow_up", "handoff"] as const) {
    const id = `g-any-${source}`;
    const seeded = await seed(id);
    await dispute(id);
    await writeSlot(id, source, source === "follow_up" ? seeded.runId : null);
    await settleTurn(id);
    const rows = await runsOf(id);
    assert.equal(rows.length, 1, `来源 ${source} 的预约同样被闸挡下，不开新链`);
    assert.equal(rows[0]?.currentRound, 1, `来源 ${source} 的预约同样不在原链上续轮`);
    assert.equal((await slotOf(id))?.reviewArmed, true, `来源 ${source} 的预约原样保留`);
  }
  // 直接调消费点（不经结算）同样挡：闸长在唯一消费点上，不靠调用方各自记得。
  let started = false;
  await startReservedFreeReview("g-live", await readFreeReviewReservation("g-live"), {
    continueRun: async () => { started = true; },
    startNew: async () => { started = true; },
  });
  assert.equal(started, false, "裁定闸在消费点本身，任何触发路径都绕不过去");

  // ── ② 裁定落地之后照常触发 ──
  // 采纳执行者：这一档不起执行回合，预约等下一个执行回合正常结束；裁定时要说一声它去哪了。
  await resolveFreeReviewDispute("g-live", "withdrawn");
  assert.equal((await slotOf("g-live"))?.reviewArmed, true, "裁定本身不消费预约");
  assert.match(timeline("g-live"), /已预约的审查仍保留：下一个执行回合正常结束时开始/,
    "裁定完要告诉用户那条被挡着的预约现在什么时候走");
  await settleTurn("g-live", "done");
  const afterRuling = await runsOf("g-live");
  assert.equal(afterRuling.length, 2, "裁定之后的执行回合正常结束，预约照常开出新链");
  assert.equal(afterRuling.find((run) => run.id !== live.runId)?.status, "reviewing");
  assert.equal((await slotOf("g-live"))?.reviewArmed, false, "开审即消费预约");

  // 维持意见：顺带发起的修复回合正常结束 = 预约触发的那一刻（回合被占着，修复投不出去，
  // 这里直接结算一个执行回合代替它）。
  const upheld = await seed("g-upheld");
  await reserveAsUser("g-upheld");
  await dispute("g-upheld");
  await settleTurn("g-upheld");
  assert.equal((await runsOf("g-upheld")).length, 1);
  await resolveFreeReviewDispute("g-upheld", "upheld");
  assert.equal(await openDisputeOf("g-upheld"), null);
  await settleTurn("g-upheld", "done");
  assert.equal((await runsOf("g-upheld")).filter((run) => run.id !== upheld.runId).length, 1,
    "维持意见后修复回合正常结束，预约照常开审");

  // ── ③ 既有路径不变 ──
  // 没有驳回：用户手存的预约照常触发。
  await seed("g-plain");
  await reserveAsUser("g-plain");
  await settleTurn("g-plain", "done");
  assert.equal((await runsOf("g-plain")).length, 2, "没有驳回时预约照常开审");

  // 驳回按来源撤：自动续轮撤掉，时间线如实说。
  const auto = await seed("g-auto");
  await armFollowUpFreeReview("g-auto", { id: auto.runId, reviewerId: "reviewer", checkMode: "logic", retryLimit: 1 },
    new Date().toISOString());
  await dispute("g-auto");
  assert.equal((await slotOf("g-auto"))?.reviewArmed, false, "驳回撤掉自动续轮预约");
  assert.match(timeline("g-auto"), /自动复审已取消/, "撤了就要说");
  await settleTurn("g-auto");
  assert.equal((await runsOf("g-auto"))[0]?.currentRound, 1, "撤掉之后不会续轮");

  // 判据是来源，不是 runId：两种「runId 与来源对不上」的行都是直接造的（正常写入点不会产出），
  // 专门用来证明撤不撤只看来源。
  await seed("g-by-source-auto");
  await writeSlot("g-by-source-auto", "follow_up", null);
  await dispute("g-by-source-auto");
  assert.equal((await slotOf("g-by-source-auto"))?.reviewArmed, false, "来源是续轮就撤，不看 runId 空不空");
  const bySourceUser = await seed("g-by-source-user");
  await writeSlot("g-by-source-user", "user", bySourceUser.runId);
  await dispute("g-by-source-user");
  assert.equal((await slotOf("g-by-source-user"))?.reviewArmed, true, "来源是用户就留，不看 runId 空不空");

  // 启动失败回滚：来源跟着原样回来（否则一条手存预约失败一次，下次驳回就会被当成续轮撤掉）。
  await seed("g-restore");
  await reserveAsUser("g-restore");
  await startReservedFreeReview("g-restore", await readFreeReviewReservation("g-restore"), {
    continueRun: async () => { throw new Error("本用例只走新建审查链"); },
    startNew: async () => { throw new Error("投递失败"); },
  });
  const restored = await slotOf("g-restore");
  assert.equal(restored?.reviewArmed, true, "启动失败把预约放回去");
  assert.equal(restored?.reviewSource, "user", "放回去的预约来源不变");

  // 修复回合异常结束：只撤自动续轮（按来源判），用户手存的留着。
  const failedAuto = await seed("g-exec-failed-auto");
  await armFollowUpFreeReview("g-exec-failed-auto", {
    id: failedAuto.runId, reviewerId: "reviewer", checkMode: "logic", retryLimit: 1,
  }, new Date().toISOString());
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "g-exec-failed-auto"));
  await handleFreeWorkflowSettlement("g-exec-failed-auto", "done", true, true, "single", true, true);
  assert.equal((await slotOf("g-exec-failed-auto"))?.reviewArmed, false, "修复执行失败撤掉自动续轮");
  await seed("g-exec-failed-user");
  await reserveAsUser("g-exec-failed-user");
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "g-exec-failed-user"));
  await handleFreeWorkflowSettlement("g-exec-failed-user", "done", true, true, "single", true, true);
  assert.equal((await runsOf("g-exec-failed-user")).length, 2, "修复执行失败不撤用户手存的预约（照旧按预约开审）");

  // ── ④ 驳回与执行结算交错（第 1 轮审查问题 1） ──
  // 驳回是执行回合里的 MCP 调用，回合一结束结算就去消费预约，两者真会同时发生。不论谁先
  // 走到哪一步，结果只能是两种之一：驳回落账、预约留着；或者审查已开、驳回按迟到拒收。
  // 「审查开了、驳回也落账」就是那条抢跑（审查实测在偏移 -2 复现）。直接打消费点、用计数
  // handler 代替真正起审，偏移覆盖两侧各自走完全程所需的微任务数。
  const tick = async (count: number) => { for (let i = 0; i < count; i++) await Promise.resolve(); };
  for (let offset = -40; offset <= 40; offset++) {
    const id = `g-race-${offset + 40}`;
    await seed(id);
    await reserveAsUser(id);
    const reservation = await readFreeReviewReservation(id);
    let dispatched = false;
    const [disputed] = await Promise.all([
      tick(Math.max(0, -offset)).then(() => dispute(id)).then(() => true, () => false),
      tick(Math.max(0, offset)).then(() => startReservedFreeReview(id, reservation, {
        // 真实下游会把审查链切进 reviewing，之后的驳回按「最近一轮没停在未通过」迟到拒收。
        continueRun: async () => { dispatched = true; },
        startNew: async () => {
          dispatched = true;
          await db.update(freeReviewRuns).set({ status: "reviewing" }).where(eq(freeReviewRuns.id, `${id}-run`));
        },
      })),
    ]);
    assert.equal(disputed, !!(await openDisputeOf(id)), `偏移 ${offset}：驳回说落账了，库里就得有它`);
    assert.ok(!(dispatched && disputed), `偏移 ${offset}：驳回落账了就不许开审（裁定还没做）`);
    assert.ok(dispatched || disputed, `偏移 ${offset}：两者总得有一个成立`);
    if (!dispatched) assert.equal((await slotOf(id))?.reviewArmed, true, `偏移 ${offset}：没开审时预约原样留着`);
  }

  // ── ⑤ 旧驳回不许被更新的审查链遮住（第 1 轮审查问题 2） ──
  // 一条更新的工作区审查链（这里直接造一条失败的，现场 GraLv8AC2dKx 就是这个形态）压在
  // 未裁定的驳回上面：判据是任务级的，闸照样挡，裁定入口照样找得到它。
  const shadow = await seed("g-shadow");
  await dispute("g-shadow");
  const later = new Date(Date.now() + 1_000).toISOString();
  await db.insert(freeReviewRuns).values({
    id: "g-shadow-newer", taskId: "g-shadow", reviewerId: "reviewer", reviewerName: "逻辑审查者", agentType: "codex",
    executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1,
    status: "failed", createdAt: later, updatedAt: later, finishedAt: later,
  });
  assert.equal((await openDisputeOf("g-shadow"))?.round.id, shadow.roundId, "更新的审查链遮不住还没裁定的旧驳回");
  await reserveAsUser("g-shadow");
  await settleTurn("g-shadow");
  assert.equal((await runsOf("g-shadow")).length, 2, "被遮住的旧驳回照样挡住预约");
  assert.equal((await slotOf("g-shadow"))?.reviewArmed, true);
  await resolveFreeReviewDispute("g-shadow", "withdrawn");
  assert.equal(await openDisputeOf("g-shadow"), null, "裁定入口找得到被遮住的那条，裁完就了结");

  // 用户自己派一轮新的工作区审查 = 显式取代：不挡这次派审，但记一笔、写时间线，驳回不再等裁定。
  const superseded = await seed("g-superseded");
  await dispute("g-superseded");
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "g-superseded"));
  await startFreeReview("g-superseded", { reviewerId: "reviewer", checkMode: "logic", retryLimit: 1 });
  const supersededRound = (await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.id, superseded.roundId)))[0];
  assert.ok(supersededRound?.disputeSupersededAt, "用户新派的审查把旧驳回记成「被取代」");
  assert.equal(supersededRound?.disputeResolution, null, "取代不是裁定：不替用户签任何一档");
  assert.equal(await openDisputeOf("g-superseded"), null, "被取代之后不再等裁定");
  assert.match(timeline("g-superseded"), /驳回还没裁定，你派了新一轮审查：这条驳回不再等裁定/, "取代必须写进时间线，不能静默");

  // 派审 / 重跑 / 修复投递占着的 dispatch 身份不是执行回合：此刻送达的驳回只能是迟到的调用。
  await createTasks([{
    id: "g-dispatch-role", projectId: "p", title: "g-dispatch-role", body: "test", mode: "single", status: "done",
    agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free", useWorktree: false, createdAt: at, updatedAt: at,
  }]);
  await db.insert(freeReviewRuns).values({
    id: "g-dispatch-role-run", taskId: "g-dispatch-role", reviewerId: "reviewer", reviewerName: "逻辑审查者",
    agentType: "codex", executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1,
    status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
  });
  await db.insert(freeReviewRounds).values({
    id: "g-dispatch-role-round", runId: "g-dispatch-role-run", round: 1, status: "failed", conclusion: "verify_failed",
    startedAt: at, endedAt: at,
  });
  assert.equal(claimTurn("g-dispatch-role", "dispatch"), true);
  await assert.rejects(() => dispute("g-dispatch-role"), /审查正在派发/, "dispatch 占位身份下的驳回一律拒收");

  // 来源回填没跑成的老行（armed、来源为空）：读侧按回填的同一条规则补，老的自动续轮照样被驳回撤掉。
  const legacy = await seed("g-legacy-null-source");
  await writeSlot("g-legacy-null-source", null, legacy.runId);
  assert.equal((await readFreeReviewReservation("g-legacy-null-source"))?.source, "follow_up");
  await dispute("g-legacy-null-source");
  assert.equal((await slotOf("g-legacy-null-source"))?.reviewArmed, false, "来源为空的老续轮也按续轮撤");

  console.log("✓ 预约各写入点记下来源；驳回按来源撤自动续轮、留用户手存");
  console.log("✓ 驳回未裁定时任意来源的预约都不开审，原样保留并在时间线留痕");
  console.log("✓ 裁定落地后预约照常触发；既有触发、回滚、执行失败路径不变");
  console.log("✓ 驳回与执行结算任意交错都不抢跑；旧驳回不被更新的链遮住，用户新派审查显式取代");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
