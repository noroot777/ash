// 「执行者驳回审查意见 → 用户裁定 / 让双方辩论」这条支线的回归。
//
// 这条链的价值全在**它停在哪儿**：驳回之后既不自动复审、也不算完成，链必须停在
// 「等用户裁定」；用户采纳执行者时审查结论本身不许被改写成通过。所以断言盯的是状态，
// 不是措辞。
//
// 全程**一直占着回合**：辩论段是靠 `continueWhenIdle` 起的，回合占着它就只排队不起跑
// （测试隔离环境本来也禁止真起执行器）。要换发言方身份的那几段，改成另起一个任务 +
// 直接种好该段的库状态，而不是释放回合——释放会把排着的起跑一次性放出去。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-review-dispute-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const {
    agents, freeReviewDebateTurns, freeReviewDebates, freeReviewRounds, freeReviewRuns,
    freeWorkflowStates, projects, reviewerProfiles, tasks,
  } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { claimTurn } = await import("../src/runs.js");
  const {
    disputeFreeReview, disputeReasonOf, disputeResolutionOf, openDisputeOf, resolveFreeReviewDispute,
  } = await import("../src/free-review-dispute.js");
  const {
    activeDebateOf, debateOfRound, debateView, exchangesOf, reconcileFreeReviewDebates,
    settleDebateTurn, sideOfSeq, startFreeReviewDebate, submitDebateStatement, totalSegments,
  } = await import("../src/free-review-debate.js");
  const { freeWorkflowState } = await import("../src/free-workflow.js");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "dispute", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "codex@test", type: "codex", model: "gpt-test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "语法审查者", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  /** 造一个「最近一轮审查未通过、停在等处理」的自由任务。 */
  async function seedStoppedReview(id: string, opts: {
    conclusion?: "verified" | "verify_failed";
    runStatus?: "stopped" | "passed";
    reservation?: { runId: string | null };
  } = {}): Promise<{ runId: string; roundId: string }> {
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    const runId = `${id}-run`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "语法审查者", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1,
      status: opts.runStatus ?? "stopped", createdAt: at, updatedAt: at, finishedAt: at,
    });
    const roundId = `${runId}-round`;
    await db.insert(freeReviewRounds).values({
      id: roundId, runId, round: 1,
      status: opts.conclusion === "verified" ? "passed" : "failed",
      conclusion: opts.conclusion ?? "verify_failed",
      reportMarkdown: "第 3 行的 null 检查缺失", startedAt: at, endedAt: at,
    });
    if (opts.reservation) {
      await db.insert(freeWorkflowStates).values({
        taskId: id, selectedReviewerId: "reviewer", reviewArmed: true, reviewCheckMode: "logic",
        reviewRetryLimit: 1, reviewRunId: opts.reservation.runId, updatedAt: at,
      });
    }
    return { runId, roundId };
  }

  const roundRow = (roundId: string) => db.select().from(freeReviewRounds)
    .where(eq(freeReviewRounds.id, roundId)).then((rows) => rows[0]!);
  const rejects = async (fn: () => Promise<unknown>, needle: string, message: string) => {
    await assert.rejects(fn, (error: Error) => {
      assert.ok(error.message.includes(needle), `${message}（实际：${error.message}）`);
      return true;
    }, message);
  };

  // ── 入参 ──
  assert.throws(() => disputeReasonOf("   "), /必须写明理由/, "空理由的驳回必须被拒");
  assert.equal(disputeReasonOf("  报告读错了行号  "), "报告读错了行号", "理由两端空白要去掉");
  assert.throws(() => disputeResolutionOf("passed"), /只能是 upheld/, "裁定只有两种");
  assert.throws(() => exchangesOf(0), /1 到/, "来回数下界");
  assert.throws(() => exchangesOf(4), /1 到/, "来回数上界");
  assert.equal(totalSegments(2), 5, "两个来回 = 5 段发言");
  assert.equal(sideOfSeq(1), "reviewer", "奇数段是审查者");
  assert.equal(sideOfSeq(2), "executor", "偶数段是执行者");

  // ── ① 驳回的门禁 ──
  const noTurn = await seedStoppedReview("d-no-turn");
  await rejects(() => disputeFreeReview("d-no-turn", "不成立"), "没有正在进行的执行回合",
    "没有回合在跑时的驳回必须拒收（迟到/误投的调用不落账）");
  assert.equal((await roundRow(noTurn.roundId)).disputeReason, null, "被拒的驳回不许落库");

  await seedStoppedReview("d-reviewer-turn");
  assert.equal(claimTurn("d-reviewer-turn", "reviewer"), true);
  await rejects(() => disputeFreeReview("d-reviewer-turn", "我自己不认自己"), "审查回合不能驳回自己的结论",
    "审查旁路回合不能替执行者驳回");

  const passed = await seedStoppedReview("d-passed", { conclusion: "verified", runStatus: "passed" });
  assert.equal(claimTurn("d-passed", "single"), true);
  await rejects(() => disputeFreeReview("d-passed", "这条我不认"), "没有停在未通过状态",
    "通过的审查没有可驳回的意见");
  assert.equal((await roundRow(passed.roundId)).disputeReason, null, "通过轮不许被写上驳回");

  // ── ② 驳回落账 + 自动复审预约撤销 ──
  const auto = await seedStoppedReview("d-auto", { reservation: { runId: "d-auto-run" } });
  assert.equal(claimTurn("d-auto", "single"), true);
  const disputed = await disputeFreeReview("d-auto", disputeReasonOf("  报告说的第 3 行是生成代码，不在本次改动里  "));
  assert.equal(disputed.round, 1, "驳回回报的是被驳的那一轮");
  const autoRound = await roundRow(auto.roundId);
  assert.equal(autoRound.disputeReason, "报告说的第 3 行是生成代码，不在本次改动里", "驳回理由落库且去空白");
  assert.ok(autoRound.disputeAt, "驳回时间要落库");
  assert.equal(autoRound.disputeResolution, null, "刚驳回时还没有裁定");
  const autoReservation = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "d-auto"))).at(0);
  assert.equal(autoReservation?.reviewArmed, false,
    "驳回必须撤掉自动复审预约：没改代码就复审只会拿到同一份报告，还会把「等你裁定」冲掉");
  await rejects(() => disputeFreeReview("d-auto", "再说一遍"), "已经驳回过了", "一轮意见只能驳一次");

  const open = await openDisputeOf("d-auto");
  assert.equal(open?.round.id, auto.roundId, "openDisputeOf 认得这条待裁定的驳回");

  // 用户自己手存的预约（runId 空）是他明确的意思，驳回一个字都不能动。
  const manual = await seedStoppedReview("d-manual", { reservation: { runId: null } });
  assert.equal(claimTurn("d-manual", "single"), true);
  await disputeFreeReview("d-manual", "这条意见看错了文件");
  const manualReservation = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "d-manual"))).at(0);
  assert.equal(manualReservation?.reviewArmed, true, "用户手存的预约不因驳回被撤");
  assert.equal((await roundRow(manual.roundId)).disputeResolution, null, "手存预约那条仍在等裁定");

  // 状态快照要把驳回带出去（界面上那张卡全靠它）。
  const state = await freeWorkflowState("d-auto");
  const stateRound = state.reviews.find((run) => run.id === auto.runId)?.rounds.at(0);
  assert.equal(stateRound?.dispute?.reason, "报告说的第 3 行是生成代码，不在本次改动里",
    "状态快照必须带上驳回理由");
  assert.equal(stateRound?.dispute?.resolution, null, "快照里的裁定此刻为空");
  assert.equal(stateRound?.dispute?.debate, null, "还没开过辩论");

  // ── ③ 用户裁定 ──
  // 采纳执行者：意见作废，但**审查结论本身不许被改写成通过**（那是伪造审查者的结论）。
  const withdrawn = await resolveFreeReviewDispute("d-auto", "withdrawn");
  assert.equal(withdrawn.resolution, "withdrawn");
  assert.equal(withdrawn.repairError, null, "采纳执行者不发起修复");
  assert.equal((await roundRow(auto.roundId)).disputeResolution, "withdrawn", "裁定落库");
  const autoRun = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, auto.runId))).at(0);
  assert.equal(autoRun?.status, "stopped", "采纳执行者不把审查链改写成通过");
  assert.equal(await openDisputeOf("d-auto"), null, "裁定之后不再是「待裁定」");
  await rejects(() => resolveFreeReviewDispute("d-auto", "upheld"), "没有等待裁定的驳回", "裁过的不能再裁");

  // 维持意见：顺带发起修复；这里回合被占着，修复必然投不出去——裁定**仍然落账**，
  // 只把投递失败如实回报（裁定是用户的决定，投递失败是另一件事）。
  const upheld = await resolveFreeReviewDispute("d-manual", "upheld");
  assert.equal(upheld.resolution, "upheld");
  assert.ok(upheld.repairError, "回合被占时修复投不出去，要如实回报");
  assert.equal((await roundRow(manual.roundId)).disputeResolution, "upheld", "修复投递失败不回滚裁定");

  // ── ④ 辩论：起一轮、交卷、换人说 ──
  const debated = await seedStoppedReview("d-debate");
  assert.equal(claimTurn("d-debate", "reviewer"), true);
  // 回合被占着，先造出驳回：直接写库（驳回本身的门禁已在 ① ② 验过）。
  await db.update(freeReviewRounds).set({ disputeReason: "第 2 条我不认：那是有意为之", disputeAt: at })
    .where(eq(freeReviewRounds.id, debated.roundId));
  const started = await startFreeReviewDebate("d-debate", { exchanges: 1 });
  assert.equal(started.exchanges, 1);
  const debate = await activeDebateOf("d-debate");
  assert.equal(debate?.currentSeq, 1, "第 1 段轮到审查者");
  assert.equal((await db.select().from(freeReviewDebateTurns)
    .where(eq(freeReviewDebateTurns.debateId, debate!.id))).length, 1, "起手只排一段");

  await rejects(() => submitDebateStatement("d-debate", { statement: "  " }), "发言不能为空", "空发言拒收");
  const first = await submitDebateStatement("d-debate", {
    statement: "报告第 2 条依据是 foo.ts:12，那一行确实没有空值检查。", verdict: "upheld",
  });
  assert.equal(first.seq, 1);
  assert.equal(first.final, false, "1 个来回共 3 段，第 1 段不是收尾");
  assert.equal(first.verdictIgnored, true, "非收尾段给的立场要明确告诉它被忽略了");
  assert.equal((await db.select().from(freeReviewDebates)
    .where(eq(freeReviewDebates.id, debate!.id))).at(0)?.verdict, null, "非收尾段不许写下立场");
  await rejects(() => submitDebateStatement("d-debate", { statement: "再说一句" }), "已经交过卷",
    "一段只能交一次卷");

  assert.equal(await settleDebateTurn("d-debate", true), true, "辩论段的结算由辩论自己收");
  const afterFirst = await activeDebateOf("d-debate");
  assert.equal(afterFirst?.currentSeq, 2, "收完第 1 段就换执行者说");
  // 身份按「这一段轮到谁」核对：现在占着的是 reviewer 回合，它不能替执行者发言。
  await rejects(() => submitDebateStatement("d-debate", { statement: "我替执行者说" }),
    "轮到执行者发言", "审查回合不能冒充执行者交卷");

  // 那一段没人交卷（崩了 / agent 忘了调）→ 整场辩论中止，驳回仍挂着等裁定。
  assert.equal(await settleDebateTurn("d-debate", true), true);
  const failed = await debateOfRound(debated.roundId);
  assert.equal(failed?.status, "failed", "没交卷的一段让辩论中止");
  assert.ok((await openDisputeOf("d-debate")), "辩论中止不影响「还在等你裁定」");
  await rejects(() => startFreeReviewDebate("d-debate", { exchanges: 1 }), "已经辩过一次了",
    "同一轮意见不许挂两条辩论记录");

  // ── ⑤ 收尾段：必须给立场，给了之后辩论结束，但**不改写任何结论** ──
  const closing = await seedStoppedReview("d-closing");
  assert.equal(claimTurn("d-closing", "reviewer"), true);
  await db.update(freeReviewRounds).set({ disputeReason: "这条意见的依据不可复现", disputeAt: at })
    .where(eq(freeReviewRounds.id, closing.roundId));
  await db.insert(freeReviewDebates).values({
    id: "closing-debate", roundId: closing.roundId, taskId: "d-closing", runId: closing.runId, round: 1,
    status: "running", exchanges: 1, currentSeq: 3, verdict: null, startedAt: at, updatedAt: at,
  });
  for (const seq of [1, 2, 3]) {
    await db.insert(freeReviewDebateTurns).values({
      id: `closing-turn-${seq}`, debateId: "closing-debate", seq, side: sideOfSeq(seq),
      statement: seq === 3 ? null : `第 ${seq} 段`, status: seq === 3 ? "speaking" : "done",
      startedAt: at, endedAt: seq === 3 ? null : at,
    });
  }
  await rejects(() => submitDebateStatement("d-closing", { statement: "就这样吧" }), "必须给出 verdict",
    "收尾段必须表明立场");
  const final = await submitDebateStatement("d-closing", {
    statement: "复现步骤我补在报告末尾了，但第 1 条我撤回。", verdict: "partial",
  });
  assert.equal(final.final, true);
  assert.equal(await settleDebateTurn("d-closing", true), true);
  const finished = await debateOfRound(closing.roundId);
  assert.equal(finished?.status, "finished", "收尾段收完辩论结束");
  assert.equal(finished?.verdict, "partial", "审查者的自述立场落库");
  assert.ok(await openDisputeOf("d-closing"),
    "辩论结束不等于裁定：驳回仍在等用户（审查者的立场不是签字）");
  await rejects(() => startFreeReviewDebate("d-closing", { exchanges: 1 }), "已经辩过一次了", "一轮只辩一次");

  const view = await debateView(closing.roundId);
  assert.equal(view?.turns.length, 3, "回放要带全部段落");
  assert.equal(view?.currentSide, null, "结束的辩论没有「正在发言的一方」");
  assert.equal(view?.turns.at(0)?.side, "reviewer");
  assert.equal(view?.turns.at(1)?.side, "executor");

  // 辩论进行中不许裁定（否则用户按下的那一刻，下一段还在往里写）。
  const midway = await seedStoppedReview("d-midway");
  assert.equal(claimTurn("d-midway", "reviewer"), true);
  await db.update(freeReviewRounds).set({ disputeReason: "有话说", disputeAt: at })
    .where(eq(freeReviewRounds.id, midway.roundId));
  await startFreeReviewDebate("d-midway", { exchanges: 1 });
  await rejects(() => resolveFreeReviewDispute("d-midway", "withdrawn"), "辩论正在进行", "辩论中不许裁定");

  // ── ⑥ 重启对账：running 是持久状态，推进它的投递链只活在内存里 ──
  // 这里种一条「没有任何回合在跑」的辩论（进程死在两段之间就是这个样子）。d-midway 那条
  // 回合还占着，对账必须放过它——所以顺带验了「活着的不碰」。
  const orphan = await seedStoppedReview("d-orphan");
  await db.update(freeReviewRounds).set({ disputeReason: "重启前驳的", disputeAt: at })
    .where(eq(freeReviewRounds.id, orphan.roundId));
  await db.insert(freeReviewDebates).values({
    id: "orphan-debate", roundId: orphan.roundId, taskId: "d-orphan", runId: orphan.runId, round: 1,
    status: "running", exchanges: 1, currentSeq: 1, verdict: null, startedAt: at, updatedAt: at,
  });
  await db.insert(freeReviewDebateTurns).values({
    id: "orphan-turn-1", debateId: "orphan-debate", seq: 1, side: "reviewer", statement: null,
    status: "speaking", startedAt: at, endedAt: null,
  });
  await reconcileFreeReviewDebates();
  assert.equal((await debateOfRound(orphan.roundId))?.status, "failed",
    "重启后没有回合在跑的辩论要收成中止，否则裁定和再开辩论会被永久 409 挡住");
  assert.equal((await db.select().from(freeReviewDebateTurns)
    .where(eq(freeReviewDebateTurns.id, "orphan-turn-1"))).at(0)?.status, "error",
    "没说完的那一段记成 error，不能留着 speaking 让界面一直转圈");
  assert.ok(await openDisputeOf("d-orphan"), "对账收掉辩论后仍然等着用户裁定");
  assert.equal((await debateOfRound(midway.roundId))?.status, "running",
    "回合还占着的辩论对账不许碰——那是活的，让它自己收尾");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "d-orphan"))).at(0)?.status, "done",
    "辩论是旁路回合：收不收得掉都不动任务自己的终态");

  console.log("free review dispute ok");
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
