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
    disputeFreeReview, disputeReasonOf, disputeResolutionNoteOf, disputeResolutionOf,
    disputeBriefOf, disputeInputOf, disputeTimelineNote, openDisputeOf, plainSummaryOf,
    resolveFreeReviewDispute,
  } = await import("../src/free-review-dispute.js");
  const {
    activeDebateOf, debateClosingOf, debateOfRound, debateViews, debatesOfRound, exchangesOf,
    reconcileFreeReviewDebates, settleDebateTurn, sideOfSeq, startFreeReviewDebate,
    submitDebateStatement, totalSegments,
  } = await import("../src/free-review-debate.js");
  const { freeManualRepairPrompt, freeRepairPrompt } = await import("../src/free-review-prompts.js");
  const {
    CLASS_PROBLEM_BOUNDARY, DEFER_BOUNDARY_CRITERION, DEFER_REASON_FIELD_GUIDE,
    MAX_PLAIN_SUMMARY_LEN, PLAIN_SUMMARY_EXAMPLE, PLAIN_SUMMARY_GUIDE,
  } = await import("@ash/shared/free-workflow");
  const { freeWorkflowState, startManualFreeReviewRepair } = await import("../src/free-workflow.js");

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
  // 「写给用户的那一句话」必填：可选的那一版等于没有——执行者手里的默认稿一直是写给
  // 审查者看的辩护书（真实样本 1000~3500 字、满篇路径行号），缺了它用户只能对着那堵墙
  // 拍板（用户 2026-10-20：「一大篇文字都看不懂」）。
  assert.throws(() => disputeInputOf({ reason: "这条不成立" }), /summary 必填/,
    "没写人话摘要的驳回必须被拒：用户要靠它拍板");
  assert.throws(() => disputeInputOf({ reason: "这条不成立", summary: "   " }), /summary 必填/,
    "只有空白的摘要等于没写");
  assert.ok(
    (() => { try { disputeInputOf({ reason: "x" }); return ""; } catch (e) { return (e as Error).message; } })()
      .includes(PLAIN_SUMMARY_GUIDE),
    "摘要的报错必须原样带上写法规范——否则 agent 补一次还是写成技术摘要",
  );
  assert.equal(
    plainSummaryOf("  报告读错了代码，\n这条我不认  ", "summary", "x"),
    "报告读错了代码， 这条我不认",
    "摘要压成一行：它要摆在界面首屏当一行结论，顺手堵掉「在摘要栏里塞一份小报告」",
  );
  assert.equal(plainSummaryOf("摘".repeat(900), "summary", "x").length, MAX_PLAIN_SUMMARY_LEN,
    "超长摘要截到上限：200 字塞不进路径行号和测试条数，限额本身就是「说人话」这条规范");
  assert.throws(() => disputeReasonOf("   "), /必须写明理由/, "空理由的驳回必须被拒");
  assert.equal(disputeReasonOf("  报告读错了行号  "), "报告读错了行号", "理由两端空白要去掉");
  assert.throws(() => disputeResolutionOf("passed"), /只能是 upheld/, "裁定只有两种");
  assert.equal(disputeResolutionNoteOf("  按辩论里的方案做  "), "按辩论里的方案做", "裁定要点两端空白要去掉");
  assert.equal(disputeResolutionNoteOf("   "), null, "只有空白的要点当成没写");
  assert.equal(disputeResolutionNoteOf(undefined), null, "没传要点就是没写");
  assert.equal(disputeResolutionNoteOf("x".repeat(9_000))?.length, 4_000, "超长要点要截断，不能灌进库");
  assert.throws(() => exchangesOf(0), /1 到/, "来回数下界");
  assert.throws(() => exchangesOf(4), /1 到/, "来回数上界");
  assert.equal(totalSegments(2), 5, "两个来回 = 5 段发言");
  assert.equal(sideOfSeq(1), "reviewer", "奇数段是审查者");
  assert.equal(sideOfSeq(2), "executor", "偶数段是执行者");

  // ── ① 驳回的门禁 ──
  const noTurn = await seedStoppedReview("d-no-turn");
  await rejects(() => disputeFreeReview("d-no-turn", { summary: "我不认这条", reason: "不成立", deferReason: null }), "没有正在进行的执行回合",
    "没有回合在跑时的驳回必须拒收（迟到/误投的调用不落账）");
  assert.equal((await roundRow(noTurn.roundId)).disputeReason, null, "被拒的驳回不许落库");

  await seedStoppedReview("d-reviewer-turn");
  assert.equal(claimTurn("d-reviewer-turn", "reviewer"), true);
  await rejects(() => disputeFreeReview("d-reviewer-turn", { summary: "我不认", reason: "我自己不认自己", deferReason: null }), "审查回合不能驳回自己的结论",
    "审查旁路回合不能替执行者驳回");

  const passed = await seedStoppedReview("d-passed", { conclusion: "verified", runStatus: "passed" });
  assert.equal(claimTurn("d-passed", "single"), true);
  await rejects(() => disputeFreeReview("d-passed", { summary: "我不认", reason: "这条我不认", deferReason: null }), "没有停在未通过状态",
    "通过的审查没有可驳回的意见");
  assert.equal((await roundRow(passed.roundId)).disputeReason, null, "通过轮不许被写上驳回");

  // ── ② 驳回落账 + 自动复审预约撤销 ──
  const auto = await seedStoppedReview("d-auto", { reservation: { runId: "d-auto-run" } });
  assert.equal(claimTurn("d-auto", "single"), true);
  const disputed = await disputeFreeReview("d-auto", disputeInputOf({
    summary: "  报告挑的那一行是生成出来的，\n不是我写的，这条我不认。  ",
    reason: "  报告说的第 3 行是生成代码，不在本次改动里  ",
  }));
  assert.equal(disputed.round, 1, "驳回回报的是被驳的那一轮");
  const autoRound = await roundRow(auto.roundId);
  assert.equal(autoRound.disputeReason, "报告说的第 3 行是生成代码，不在本次改动里", "驳回理由落库且去空白");
  assert.equal(autoRound.disputeSummary, "报告挑的那一行是生成出来的， 不是我写的，这条我不认。",
    "那一句人话也要落库：裁定屏的第一行字、时间线旁注都读它");
  assert.ok(autoRound.disputeAt, "驳回时间要落库");
  assert.equal(autoRound.disputeResolution, null, "刚驳回时还没有裁定");
  const autoReservation = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "d-auto"))).at(0);
  assert.equal(autoReservation?.reviewArmed, false,
    "驳回必须撤掉自动复审预约：没改代码就复审只会拿到同一份报告，还会把「等你裁定」冲掉");
  await rejects(() => disputeFreeReview("d-auto", { summary: "再说一次", reason: "再说一遍", deferReason: null }), "已经驳回过了", "一轮意见只能驳一次");

  const open = await openDisputeOf("d-auto");
  assert.equal(open?.round.id, auto.roundId, "openDisputeOf 认得这条待裁定的驳回");

  // 用户自己手存的预约（runId 空）是他明确的意思，驳回一个字都不能动。
  const manual = await seedStoppedReview("d-manual", { reservation: { runId: null } });
  assert.equal(claimTurn("d-manual", "single"), true);
  await disputeFreeReview("d-manual", { summary: "它看错了文件", reason: "这条意见看错了文件", deferReason: null });
  const manualReservation = (await db.select().from(freeWorkflowStates)
    .where(eq(freeWorkflowStates.taskId, "d-manual"))).at(0);
  assert.equal(manualReservation?.reviewArmed, true, "用户手存的预约不因驳回被撤");
  assert.equal((await roundRow(manual.roundId)).disputeResolution, null, "手存预约那条仍在等裁定");

  // 状态快照要把驳回带出去（界面上那张卡全靠它）。
  const state = await freeWorkflowState("d-auto");
  const stateRound = state.reviews.find((run) => run.id === auto.runId)?.rounds.at(0);
  assert.equal(stateRound?.dispute?.reason, "报告说的第 3 行是生成代码，不在本次改动里",
    "状态快照必须带上驳回理由");
  assert.equal(stateRound?.dispute?.summary, "报告挑的那一行是生成出来的， 不是我写的，这条我不认。",
    "快照必须带上那一句人话：界面首屏摆的是它，不是那几千字依据");
  assert.equal(stateRound?.dispute?.resolution, null, "快照里的裁定此刻为空");
  assert.deepEqual(stateRound?.dispute?.debates, [], "还没开过辩论");

  // ── ③ 用户裁定 ──
  // 采纳执行者：意见作废，但**审查结论本身不许被改写成通过**（那是伪造审查者的结论）。
  const withdrawn = await resolveFreeReviewDispute("d-auto", "withdrawn", "第 3 行确实是生成代码，这条我按执行者说的作废。");
  assert.equal(withdrawn.resolution, "withdrawn");
  assert.equal(withdrawn.repairError, null, "采纳执行者不发起修复");
  assert.equal((await roundRow(auto.roundId)).disputeResolution, "withdrawn", "裁定落库");
  assert.equal((await roundRow(auto.roundId)).disputeResolutionNote,
    "第 3 行确实是生成代码，这条我按执行者说的作废。",
    "采纳执行者这一档不发消息，裁定理由必须留在库里——否则它只剩时间线上那句摘要");
  const autoRun = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, auto.runId))).at(0);
  assert.equal(autoRun?.status, "stopped", "采纳执行者不把审查链改写成通过");
  assert.equal(await openDisputeOf("d-auto"), null, "裁定之后不再是「待裁定」");
  await rejects(() => resolveFreeReviewDispute("d-auto", "upheld"), "没有等待裁定的驳回", "裁过的不能再裁");
  // 采纳执行者之后，**修复入口必须跟着关掉**：确认框写的是「执行者不再按它修改」，
  // 还能照旧报告修一遍的话，用户点一下就把自己刚下的裁定推翻了（第 1 轮审查实测）。
  await rejects(() => startManualFreeReviewRepair("d-auto"), "已被你裁定作废",
    "已作废的意见不能再发起修复（后端挡，不只是前端藏按钮）");

  // 维持意见：顺带发起修复；这里回合被占着，修复必然投不出去——裁定**仍然落账**，
  // 只把投递失败如实回报（裁定是用户的决定，投递失败是另一件事）。
  const upheld = await resolveFreeReviewDispute("d-manual", "upheld", "第 2 条按摘要内部折叠做，别按报告里的降档方案。");
  assert.equal(upheld.resolution, "upheld");
  assert.ok(upheld.repairError, "回合被占时修复投不出去，要如实回报");
  assert.equal((await roundRow(manual.roundId)).disputeResolution, "upheld", "修复投递失败不回滚裁定");
  assert.equal((await roundRow(manual.roundId)).disputeResolutionNote,
    "第 2 条按摘要内部折叠做，别按报告里的降档方案。", "裁定要点跟裁定一起落账，投递失败也不回滚");

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

  await rejects(() => submitDebateStatement("d-debate", { statement: "  ", summary: "随便" }),
    "发言不能为空", "空发言拒收");
  // 发言的那一句人话同样必填：七段加起来上万字，用户开辩论是为了裁定，不是为了读完。
  await rejects(() => submitDebateStatement("d-debate", { statement: "有话说" }), "summary 必填",
    "没写人话摘要的发言必须被拒");
  const first = await submitDebateStatement("d-debate", {
    summary: "我还是认为那处少了一道空值检查。",
    statement: "报告第 2 条依据是 foo.ts:12，那一行确实没有空值检查。", verdict: "upheld",
  });
  assert.equal(first.seq, 1);
  assert.equal(first.final, false, "1 个来回共 3 段，第 1 段不是收尾");
  assert.equal(first.verdictIgnored, true, "非收尾段给的立场要明确告诉它被忽略了");
  assert.equal((await db.select().from(freeReviewDebates)
    .where(eq(freeReviewDebates.id, debate!.id))).at(0)?.verdict, null, "非收尾段不许写下立场");
  await rejects(() => submitDebateStatement("d-debate", { statement: "再说一句", summary: "补一句" }),
    "已经交过卷", "一段只能交一次卷");

  assert.equal(await settleDebateTurn("d-debate", true), true, "辩论段的结算由辩论自己收");
  const afterFirst = await activeDebateOf("d-debate");
  assert.equal(afterFirst?.currentSeq, 2, "收完第 1 段就换执行者说");
  // 身份按「这一段轮到谁」核对：现在占着的是 reviewer 回合，它不能替执行者发言。
  await rejects(() => submitDebateStatement("d-debate", { statement: "我替执行者说", summary: "替它说" }),
    "轮到执行者发言", "审查回合不能冒充执行者交卷");

  // 那一段没人交卷（崩了 / agent 忘了调）→ 整场辩论中止，驳回仍挂着等裁定。
  assert.equal(await settleDebateTurn("d-debate", true), true);
  const failed = await debateOfRound(debated.roundId);
  assert.equal(failed?.status, "failed", "没交卷的一段让辩论中止");
  assert.ok((await openDisputeOf("d-debate")), "辩论中止不影响「还在等你裁定」");
  // 中断的辩论可以重开：那一段是系统没让人说完，把用户的出路一起关掉等于拿自己的
  // 失败惩罚他。历史那条原样留着，不被覆盖。
  const reopened = await startFreeReviewDebate("d-debate", { exchanges: 1 });
  assert.notEqual(reopened.debateId, debate!.id, "重开的是新的一场，不是把旧记录改回 running");
  assert.equal((await debatesOfRound(debated.roundId)).length, 2, "中断那场的发言记录仍然留着");
  assert.equal((await activeDebateOf("d-debate"))?.id, reopened.debateId, "重开后轮到新那场在跑");
  await rejects(() => startFreeReviewDebate("d-debate", { exchanges: 1 }), "已经有一轮辩论正在进行",
    "同时只许有一场辩论");

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
  await rejects(() => submitDebateStatement("d-closing", { statement: "就这样吧", summary: "收尾" }),
    "必须给出 verdict", "收尾段必须表明立场");
  const final = await submitDebateStatement("d-closing", {
    summary: "第 1 条我撤回，其余两条我坚持，复现步骤我补齐了。",
    statement: "复现步骤我补在报告末尾了，但第 1 条我撤回。", verdict: "partial",
  });
  assert.equal(final.final, true);
  assert.equal(await settleDebateTurn("d-closing", true), true);
  const finished = await debateOfRound(closing.roundId);
  assert.equal(finished?.status, "finished", "收尾段收完辩论结束");
  assert.equal(finished?.verdict, "partial", "审查者的自述立场落库");
  assert.ok(await openDisputeOf("d-closing"),
    "辩论结束不等于裁定：驳回仍在等用户（审查者的立场不是签字）");
  await rejects(() => startFreeReviewDebate("d-closing", { exchanges: 1 }), "已经辩完了",
    "好好辩完的那场挡住再辩：该裁定了，或者再派一轮审查");

  const views = await debateViews(closing.roundId);
  assert.equal(views.length, 1, "这一轮只辩过一场");
  assert.equal(views[0]?.turns.length, 3, "回放要带全部段落");
  assert.equal(views[0]?.currentSide, null, "结束的辩论没有「正在发言的一方」");
  assert.equal(views[0]?.turns.at(0)?.side, "reviewer");
  assert.equal(views[0]?.turns.at(1)?.side, "executor");
  assert.equal(views[0]?.turns.at(2)?.summary, "第 1 条我撤回，其余两条我坚持，复现步骤我补齐了。",
    "每段那一句人话要进回放：界面逐段摆它，完整发言折在下面");
  assert.equal(views[0]?.turns.at(0)?.summary, null,
    "加这个字段之前落的老发言没有摘要，回放要如实给 null（界面据此把正文摊开）");

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

  // ── ⑦ 辩论与裁定真的流进修复指令 ──
  // 这条链最容易出的漏子是「辩完了，然后什么也没发生」：辩论的收尾发言只进时间线和
  // 界面，用户的裁定只有三档枚举，于是用户点完「让它接着改」，执行者收到的仍然是
  // 一句「照 report.md 改」——双方刚辩出来的结论对真正动手的那一方等于不存在。
  const closingRun = (await db.select().from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, closing.runId))).at(0)!;
  const readClosing = await debateClosingOf(closing.roundId);
  assert.equal(readClosing?.seq, 3, "收尾是最后一段");
  assert.equal(readClosing?.total, 3, "1 个来回共 3 段");
  assert.equal(readClosing?.verdictLabel, "部分成立", "自述立场要带上中文标签");
  assert.equal(readClosing?.statement, "复现步骤我补在报告末尾了，但第 1 条我撤回。", "收尾发言原文");
  assert.equal(await debateClosingOf(debated.roundId), null,
    "中断的那场没说到收尾，不能把半截发言当成收尾塞进修复指令");

  const repairPrompt = await freeManualRepairPrompt("d-closing", closingRun, {
    disputeUpheld: true,
    resolutionNote: "第 2 条按摘要内部折叠做，别按报告里的降档方案。",
    debateClosing: readClosing,
  });
  assert.ok(repairPrompt.includes("复现步骤我补在报告末尾了，但第 1 条我撤回。"),
    "审查者的收尾发言必须整段进修复指令：段序决定了执行者的会话里结构上没有这一段");
  assert.ok(repairPrompt.includes("你的会话里没有它"), "要告诉执行者这段它没见过，别当成重复信息跳过");
  assert.ok(repairPrompt.includes("部分成立"), "收尾立场要标出来");
  assert.ok(repairPrompt.includes("**不是结论**"),
    "收尾发言是被驳回一方的立场，不是结论——裁定权只在用户手上");
  assert.ok(repairPrompt.includes("第 2 条按摘要内部折叠做，别按报告里的降档方案。"),
    "用户的裁定要点必须进修复指令，否则三档裁定表达不了的结论只能靠用户事后手打");
  assert.ok(repairPrompt.includes("以它为准"),
    "必须写明裁定要点压过报告：两份打架的要求让执行者自己挑，挑错了没人会发现");

  // 没辩过、也没写要点时，措辞一个字都不多——那两段是条件性的，不是模板里的常驻噪音。
  const bare = await freeManualRepairPrompt("d-closing", closingRun, { disputeUpheld: true });
  assert.ok(!bare.includes("辩论收尾发言"), "没辩过就不该出现收尾那一节");
  assert.ok(!bare.includes("裁定时写给你的要点"), "没写要点就不该出现要点那一节");

  // ── 转出那条出路的判据：这里**必须**按措辞断言，不是按状态 ────────────────────
  //
  // 判据是用户 2026-09-24 的原话「如果偏离了主任务的内容的话就开启一个新的任务」，可它
  // 最初只落了「衍生问题」一种形态（建任务那一步被换成了当时手里唯一的实例），之后一路
  // 忠实复制，直到 2026-10-14 撞上真实案例：执行者面前是一条「基线上就有、落在两个与
  // 任务无关的脚本里」的意见，`deferReason` 的格子要它填「是哪一轮的哪次改动引入的」，
  // 它填不进去，于是照改。这一步不会有任何运行期行为报错：链照跑、报告照落盘，只是那
  // 一型意见永远转不出去——所以判据只能靠措辞钉。
  //
  // 钉的是**那一份共享源原样出现**，不是几个同名词碰巧都在：各自手写时就漂过一次。
  //
  // 但「原样出现在两个表面」这条做法本身已经退役（2026-10-27）：同一段判据在一条修复
  // 消息里要出现两三遍，而驳回这条支线的实际发生率只有约 6%（9-23 以来 1162 轮里 68 次）
  // ——那是在为一个低频分支按每轮付费。现在改成**单源 + 指针**：判据全文只住在
  // `dispute_review` 的工具说明里（它本来就随工具清单常驻每个回合），交接消息只负责
  // 「这条路存在、默认仍是照改、判据去哪看」。所以这里改钉三件事：
  //   ① 全文确实在那个唯一的落脚处；② 交接消息指得到它；③ 交接消息里没有第二份拷贝。
  // 「全局只有这一处」由 `test-prompt-budget.ts` 的 PLACEMENT 表在渲染结果上兜底。
  const toolConfig = await (async () => {
    const { registerTaskTurnTools } = await import("../../mcp/src/tools/task-turn.js");
    const registered = new Map<string, { description?: string; inputSchema?: Record<string, { description?: string }> }>();
    registerTaskTurnTools({
      registerTool(name: string, configuration: never) { registered.set(name, configuration); },
    } as never);
    const found = registered.get("dispute_review");
    assert.ok(found, "dispute_review 必须真的注册出来——元数据断言只有拿到注册结果才算数");
    return found;
  })();
  // ① 判据全文的唯一落脚处：真正注册给执行者的那份工具说明。
  assert.ok(
    (toolConfig.description ?? "").includes(DEFER_BOUNDARY_CRITERION),
    "dispute_review 工具说明必须原样带上那份共享判据（三种形态 + 反向误读防线），不是碰巧出现几个同名词",
  );
  const repairSurfaces = [
    ["自动修复交接", await freeRepairPrompt("d-closing", closingRun)],
    ["轮数用尽后的手动修复交接", await freeManualRepairPrompt("d-closing", closingRun)],
  ] as const;
  for (const [source, text] of repairSurfaces) {
    // ② 指得到：三条出路、deferReason 填法、summary 写法都在工具说明里，这句话不能丢
    //    ——丢了就只剩「可以驳回」而没有「按什么判据驳」，等于把判据删掉。
    assert.ok(
      text.includes("dispute_review") && /判据与各字段写法见该工具说明/.test(text),
      `${source} 必须把判据的去处指出来：只说「可以驳回」而不说按什么判据，等于判据不存在`,
    );
    // ③ 没有第二份拷贝。
    for (const [name, full] of [
      ["越界判据", DEFER_BOUNDARY_CRITERION],
      ["deferReason 填法", DEFER_REASON_FIELD_GUIDE],
    ] as const) {
      assert.ok(!text.includes(full),
        `${source} 里不该再内联一份${name}全文：它住在工具说明里，两处同文就是按轮次重复付费`);
    }
    // 类问题边界是**例外**：它归修复交接（预设/旧验证那条线共用，那边没有 dispute_review），
    // 所以这里要的是原样出现，而工具说明里反过来不许有。
    assert.ok(
      text.includes(CLASS_PROBLEM_BOUNDARY),
      `${source} 必须原样带上类问题的边界口径，否则「类问题」标签会替掉内容判断`,
    );
    for (const stale of ["为什么越界(是哪一轮的哪次改动引入的)", "多半是本轮修复引入的衍生问题"]) {
      assert.ok(!text.includes(stale), `${source} 不许残留旧的单一形态措辞「${stale}」`);
    }
  }
  assert.ok(
    !(toolConfig.description ?? "").includes(CLASS_PROBLEM_BOUNDARY),
    "类问题边界住在修复交接里，工具说明只留一句指针——两处同文时它在一条消息里会出现两遍",
  );
  // 工具的 deferReason 字段说明同样走共享源：字段说明是执行者填那个格子时离得最近的一句。
  assert.ok(
    (toolConfig.inputSchema?.deferReason?.description ?? "").includes(DEFER_REASON_FIELD_GUIDE),
    "dispute_review 的 deferReason 字段说明必须原样带上共享填法",
  );
  // 「根因本身也在界外」这一型要能读出来：只豁免「无关模块的同类实例」时，整条落在别人
  // 管线里的类问题仍会被判成界内（第 1 轮审查 F2）。
  assert.match(
    CLASS_PROBLEM_BOUNDARY,
    /根因\*\*本身\*\*也落在[^\n]*无关模块[^]*?整条意见都不属于本任务/,
    "类问题口径必须覆盖「根因本身也在界外 → 整条转出」，不能只豁免外围实例",
  );
  // 这段口径被预设/旧验证那条线共用，那边没有 dispute_review —— 不许写死 free 的出口
  // （第 1 轮审查 N1）。
  for (const exit of ["dispute_review", "deferReason", "ask_question"]) {
    assert.ok(
      !CLASS_PROBLEM_BOUNDARY.includes(exit),
      `共享的类问题口径里不许写死出口「${exit}」：它被没有这个出口的回合共用，会变成一句指不到东西的话`,
    );
  }
  // 用户已经裁定「维持审查意见、接着改」那一趟不给这条出路——这是现有语义，顺带钉住，
  // 免得上面那圈断言被人改成「所有修复提示都得带三种形态」。
  assert.ok(!bare.includes(DEFER_BOUNDARY_CRITERION), "裁定维持原意见后不再提供转出口径");

  // ── ⑧ 「说人话」这条规范同样有两个运行时表面，和判据一样只能靠措辞钉 ──
  //
  // 执行者写出来的默认稿是给审查者看的辩护书；要它多写一句人话，只有**交接提示**和
  // **MCP 工具说明**两处能开口，而执行者两边都读得到。少一处就等于这一句可有可无
  //（用户 2026-10-20：「让用户裁定时要说人话，现在一大篇文字都看不懂」）。
  const replyConfig = await (async () => {
    const { registerTaskTurnTools } = await import("../../mcp/src/tools/task-turn.js");
    const registered = new Map<string, { description?: string; inputSchema?: Record<string, { description?: string }> }>();
    registerTaskTurnTools({
      registerTool(name: string, configuration: never) { registered.set(name, configuration); },
    } as never);
    return registered.get("debate_reply")!;
  })();
  // 规范本体只挂**两个 summary 字段说明**——执行者真要动手填那个格子时离得最近的一句；
  // 正反示范（比规范本体还长、只在「第一次写」那一刻有用）更进一步，只挂 dispute_review
  // 那一处。消息那几处改为指针：少一处指针等于这一句可有可无，多一份全文等于按轮次付费。
  for (const [source, text] of [
    ["dispute_review 的 summary 字段说明", toolConfig.inputSchema?.summary?.description ?? ""],
    ["debate_reply 的 summary 字段说明", replyConfig.inputSchema?.summary?.description ?? ""],
  ] as const) {
    assert.ok(text.includes(PLAIN_SUMMARY_GUIDE),
      `${source} 必须原样带上「写给用户的那一句话」该怎么写——两处各写一份必然漂成两套规范`);
  }
  assert.ok((toolConfig.inputSchema?.summary?.description ?? "").includes(PLAIN_SUMMARY_EXAMPLE),
    "正反示范挂在 dispute_review 的 summary 字段上：那是执行者第一次写这一句时离得最近的地方");
  assert.ok(!(replyConfig.inputSchema?.summary?.description ?? "").includes(PLAIN_SUMMARY_EXAMPLE),
    "示范只挂一处：七个表面各带一份，等于为一次性的示范付七份常驻上下文");
  // 辩论每一段的开场白也要带（审查者那几段同样是给用户看的）。
  const debateRow = (await db.select().from(freeReviewDebates)
    .where(eq(freeReviewDebates.id, "closing-debate"))).at(0)!;
  const debateTurnRow = (await db.select().from(freeReviewDebateTurns)
    .where(eq(freeReviewDebateTurns.id, "closing-turn-1"))).at(0)!;
  const { debatePrompt } = await import("../src/free-review-prompts.js");
  const segmentPrompt = debatePrompt({
    task: (await db.select().from(tasks).where(eq(tasks.id, "d-closing"))).at(0)!,
    run: closingRun, debate: debateRow, turn: debateTurnRow,
    disputeReason: "这条意见的依据不可复现", previous: [], repoPath: root,
  });
  assert.ok(!segmentPrompt.includes(PLAIN_SUMMARY_GUIDE),
    "开场白不再内联写法规范：它随 debate_reply 的字段说明常驻，内联就是每一段各付一份");
  assert.match(segmentPrompt, /\*\*summary 必填\*\*[^\n]*写法见该字段说明/,
    "但必须指得到：少了这句指针，那一句人话就成了可有可无的东西");
  assert.ok(segmentPrompt.includes("summary"), "开场白里的调用示例要把 summary 摆出来");

  // 发给双方的那份「执行者到底说了什么」必须三段都带。只取 disputeReason 的话，「只提
  // 转出」那种形态（话全在 deferReason 里）会把 null 发出去，审查者对着一条空驳回答辩。
  const deferOnlyRound = {
    disputeSummary: "这两条我认，但该另开任务做。",
    disputeReason: null,
    disputeDeferReason: "第 2、3 条都是上一轮照意见改出来的。",
  } as never;
  const brief = disputeBriefOf(deferOnlyRound);
  assert.ok(!brief.includes("null"), "只提转出时不许把 null 当成驳回正文发给双方");
  assert.ok(brief.includes("第 2、3 条都是上一轮照意见改出来的。"), "转出那一段也是「它说过的话」，必须带上");
  assert.ok(brief.includes("这两条我认，但该另开任务做。"), "那一句人话同样要带：它是双方对齐争点最省力的一句");
  const bothBrief = disputeBriefOf({
    disputeSummary: "一条不认，一条该另开任务。", disputeReason: "第 1 条读错了行号",
    disputeDeferReason: "第 4 条越界",
  } as never);
  assert.ok(bothBrief.includes("第 1 条读错了行号") && bothBrief.includes("第 4 条越界"),
    "两段都给时一段都不许掉");

  // ── ⑨ 时间线旁注：拍板前最常先看到的那一眼 ──
  const note = disputeTimelineNote({
    round: 2, reviewerName: "顶级审查", summary: "报告挑的那一行是生成出来的，这条我不认。",
    hasReason: true, hasDefer: false, canceledAuto: true,
  });
  assert.ok(note.includes("报告挑的那一行是生成出来的，这条我不认。"),
    "旁注第二行放的是那一句人话，不是正文前 60 字（截出来的多半是「已修复并提交 ceed925…」那种噪音）");
  assert.ok(note.includes("执行者不认这一轮审查意见"), "第一行先说清谁不认谁");
  assert.ok(/现在由你裁定[：:]/.test(note),
    "「现在由你裁定：」这个前缀不能改字：前端靠它在时间线里认出这一行并挂上「去裁定」");
  assert.ok(note.includes("让它接着改") && note.includes("这一轮不用改了"),
    "旁注要把能点的几档说出来，别只说「去裁定」");
  assert.ok(!note.includes("把那几条转成独立任务"), "没提转出就不许列那一档——点不到的选项是假承诺");
  assert.ok(note.includes("自动复审已取消"), "自动复审被撤这件事必须说，否则用户在等一轮永远不会来的复审");
  const deferNote = disputeTimelineNote({
    round: 3, reviewerName: "顶级审查", summary: "这两条我认，但它们不在这个任务的范围里。",
    hasReason: false, hasDefer: true, canceledAuto: false,
  });
  assert.ok(deferNote.includes("认可这一轮意见，但说该另开一个任务去改"),
    "只提转出时第一行不能写成「驳回了意见」：它说的恰恰是「报告是对的，只是不该在这儿修」");
  assert.ok(deferNote.includes("把那几条转成独立任务"), "提了转出就要把那一档列出来");

  console.log("free review dispute ok");} catch (error) {
  failure = error;
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
