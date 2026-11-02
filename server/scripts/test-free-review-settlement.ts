import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import type { AgentExecutor, RunHandle } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-review-settlement-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_LAX_DONE;

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, monitors, projects, reviewerProfiles, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { pendingMessageRow } = await import("../src/pending-messages.js");
  const { freeWorkflowState, handleFreeWorkflowSettlement, reconcileFreeReviews, reportFreeReviewConclusion,
    reserveFreeReview } = await import("../src/free-workflow.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  const { claimTurn, markStopped, releaseTurn } = await import("../src/runs.js");
  const { confirmDone } = await import("../src/task-confirmation.js");
  const { writeResumePrompt } = await import("../src/task-resume-prompt.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { FOLLOW_UP_REMINDER } = await import("../src/run-prompts.js");
  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "review settlement", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  async function runTurn(id: string, options: {
    followUp?: boolean;
    confirmed?: boolean | "persisted";
    exitStatus?: number;
    stopped?: "canceled" | "paused";
    question?: string;
    resumePrompt?: string;
    native?: boolean;
    truncated?: boolean;
    executionError?: { message: string; affectsTurn?: false };
    role?: "single" | "reviewer";
    reserve?: boolean;
    autoFollowUp?: boolean;
    /** 托盘里排着的待发送消息（结算时要给它让路）。 */
    pending?: { mode: "queued" | "timed"; sendAt?: string };
    reviewConclusion?: "verified" | "verify_failed" | null;
    /** 交卷之后、结算之前,**执行者**自己挂下的一段检查点(走生产 writer,带上它的连带写入)。 */
    checkpointDuringReview?: string;
    /** 审查**自己**以 pause_task 收尾挂下的那一段(auto=false):这一份才是「审查在等续跑」。 */
    reviewerPause?: string;
    /** 审查**自己**那一轮被系统代写的检查点(auto=true,名下还有没了结的哨兵)。它跟上一条
     *  一样是「审查在等续跑」—— 区别只在落笔的是系统还是 agent 自己。 */
    reviewerAutoCheckpoint?: string;
  } = {}) {
    const role = options.role ?? "single";
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.update(tasks).set({
      followUpFrom: options.followUp ? "done" : null,
      question: options.question ?? null, resumePrompt: options.resumePrompt ?? null,
      nativeTurn: options.native ?? false,
    }).where(eq(tasks.id, id));
    const sessId = `${id}-session`;
    await db.insert(sessions).values({
      id: sessId, taskId: id, role, agentType: "codex", executor: "test",
      cwd: root, startedAt: at, turnStartedAt: at,
    });
    assert.equal(claimTurn(id, role), true);
    if (options.pending) {
      await db.insert(scheduledMessages).values(pendingMessageRow({
        taskId: id, text: "再补一句", mode: options.pending.mode,
        ...(options.pending.sendAt ? { sendAt: new Date(options.pending.sendAt) } : {}),
      }));
    }
    if (options.autoFollowUp) {
      const runId = `${id}-auto-review`;
      await db.insert(freeReviewRuns).values({
        id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
        executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "stopped",
        createdAt: at, updatedAt: at, finishedAt: at,
      });
      await db.insert(freeReviewRounds).values({
        id: `${runId}-round`, runId, round: 1, status: "failed", conclusion: "verify_failed",
        startedAt: at, endedAt: at,
      });
      await db.insert(freeWorkflowStates).values({
        taskId: id, selectedReviewerId: "reviewer", reviewArmed: true,
        reviewCheckMode: "logic", reviewRetryLimit: 1, reviewRunId: runId, updatedAt: at,
      });
    } else if (options.reserve !== false) {
      await reserveFreeReview(id, { reviewerId: "reviewer", checkMode: "logic", retryLimit: 1 });
    }
    if (options.reviewConclusion !== undefined) {
      const runId = `${id}-review`;
      await db.insert(freeReviewRuns).values({
        id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
        executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
        createdAt: at, updatedAt: at,
      });
      await db.insert(freeReviewRounds).values({
        id: `${runId}-round`, runId, round: 1, status: "reviewing", startedAt: at,
      });
      await evidenceState(id, freeReviewEvidenceDir(id, runId, 1), (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!);
      if (options.reviewConclusion) {
        const report = freeReviewReportPath(id, runId, 1);
        mkdirSync(dirname(report), { recursive: true });
        writeFileSync(report, "审查证据已核实。\n");
        await reportFreeReviewConclusion(id, options.reviewConclusion);
      }
    }
    // 执行者在审查窗口里挂检查点:走生产 writer,连带的 recordReviewWait 原样发生
    // (它会把审查的 continuation 相位按「有人在等」翻成 waiting —— D6 的现场就是这一下)。
    //
    // **必须按执行者那一轮的身份落笔**:这一格的归属按「哪个回合写的」记账
    // (task-wait-ownership.ts 的 reviewOwnsAutoCheckpoint),拿审查的占位去写执行者的那一格,
    // 这条用例测的就不再是它要测的那件事了。真实时序本来也是这样:执行者那一轮先结算,审查
    // 回合之后才起跑。
    if (options.checkpointDuringReview) {
      releaseTurn(id);
      assert.equal(claimTurn(id, "single"), true);
      assert.equal(await writeResumePrompt(id, options.checkpointDuringReview, true), true);
      releaseTurn(id);
      assert.equal(claimTurn(id, role), true);
    }
    // 审查自己 pause_task 收尾:同一格、同一个回合,只差 auto —— 两种都是「审查在等续跑」。
    if (options.reviewerPause) {
      assert.equal(await writeResumePrompt(id, options.reviewerPause, false), true);
    }
    // 审查自己那一轮被系统代写的检查点(哨兵还在盯着):落笔的回合就是这一轮审查,所以它
    // 同样算「审查在等续跑」—— 拿 auto 当「执行者的」用,审查就会被提前记成异常结束。
    if (options.reviewerAutoCheckpoint) {
      assert.equal(await writeResumePrompt(id, options.reviewerAutoCheckpoint, true), true);
    }
    if (options.confirmed === "persisted") {
      await db.update(tasks).set({ completeConfirmedAt: at }).where(eq(tasks.id, id));
    } else if (options.confirmed) {
      // 内存那张票带着它属于的那一代（task-confirmation.ts）：结算只认当下这一代的那张。
      const epoch = (await db
        .select({ epoch: tasks.directionEpoch }).from(tasks).where(eq(tasks.id, id))).at(0)!.epoch;
      confirmDone(id, epoch);
    }
    if (options.stopped) markStopped(id, options.stopped);
    const path = sessionTranscriptPath(id, sessId);
    mkdirSync(dirname(path), { recursive: true });
    const out = createWriteStream(path, { flags: "a" });
    const closed = once(out, "close");
    const handle: RunHandle = {
      sessionId: "", commandLine: "fixture", kill() {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "text", text: "本轮输出。" };
        if (options.executionError) yield { kind: "error", ...options.executionError };
        if (!options.truncated) yield { kind: "done", exitStatus: options.exitStatus ?? 0 };
      })(),
    };
    const executor: AgentExecutor = {
      type: "codex", label: "fixture", run: () => handle,
      resumeCommand: () => "", resumeFields: () => ({ resumeCommand: "", resumeEnv: null, resumeArgs: null }),
    };
    await consumeSingleRun({
      taskId: id, sessId, agentType: "codex", ex: executor, cwd: root, handle, out,
      turnStart: at, cliSessionId: "", autoTitle: false, role,
    });
    await closed;
    const task = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const state = await freeWorkflowState(id);
    return { task, state, transcript: readFileSync(path, "utf8") };
  }

  for (const followUp of [false, true]) {
    for (const confirmed of [true, "persisted"] as const) {
      const result = await runTurn(`confirmed-truncated-${followUp}-${confirmed}`, { followUp, confirmed, truncated: true });
      assert.equal(result.task.status, "done");
      assert.equal(result.state.reviewReservation.armed, false, "已交卷但缺退出事件仍消费预约");
      assert.equal(result.state.reviews.length, 1);
    }
  }

  for (const conclusion of ["verified", "verify_failed", null] as const) {
    const result = await runTurn(`review-truncated-${conclusion}`, {
      followUp: true, role: "reviewer", reserve: false, truncated: true, reviewConclusion: conclusion,
    });
    const review = result.state.reviews[0]!;
    assert.equal(review.status, conclusion === "verified" ? "passed" : conclusion === "verify_failed" ? "stopped" : "failed");
    assert.equal(review.rounds[0]?.status, conclusion === "verified" ? "passed" : conclusion === "verify_failed" ? "failed" : "error");
    assert.equal(review.rounds[0]?.conclusion, conclusion);
    assert.equal(result.state.reviewReservation.armed, conclusion === "verify_failed", "已交失败结论的审查仍挂自动复审预约");
  }
  for (const stopped of [false, true]) {
    for (const conclusion of ["verified", "verify_failed"] as const) {
      const result = await runTurn(`review-interrupted-${stopped}-${conclusion}`, {
        followUp: true, role: "reviewer", reserve: false, reviewConclusion: conclusion,
        ...(stopped ? { stopped: "canceled", truncated: true } : { exitStatus: 1 }),
      });
      assert.equal(result.state.reviews[0]?.status, "failed", "真实停止或异常不能被已交结论掩盖");
      assert.equal(result.state.reviewReservation.armed, false);
    }
  }

  for (const followUp of [false, true]) {
    const id = followUp ? "follow-up" : "fresh";
    const result = await runTurn(id, { followUp });
    assert.equal(result.task.status, followUp ? "done" : "failed", "审查启动不代替任务完成确认");
    assert.equal(result.task.completeConfirmedAt, null);
    assert.equal(result.state.reviewReservation.armed, false);
    assert.equal(result.state.reviews.length, 1, "实际收流路径在漏调完成工具时仍消费预约");
    assert.equal(result.state.reviews[0]?.status, "reviewing");
    assert.match(result.transcript, /未确认任务完成/);
    await handleFreeWorkflowSettlement(id, result.task.status, false, true);
    assert.equal((await freeWorkflowState(id)).reviews.length, 1, "重复结算不双开审查");
  }

  let blockedCase = 0;
  for (const options of [
    { stopped: "canceled" as const },
    { stopped: "paused" as const },
    { exitStatus: 1 },
    { stopped: "canceled" as const, confirmed: true },
    { exitStatus: 1, confirmed: true },
    { question: "选择哪个方案？" },
    { resumePrompt: "等依赖完成" },
    { native: true },
    { truncated: true },
    { executionError: { message: "API Error: 503 service unavailable" } },
    { truncated: true, confirmed: true, stopped: "canceled" as const },
    { role: "reviewer" as const },
  ]) {
    const id = `blocked-${++blockedCase}`;
    const result = await runTurn(id, { followUp: true, ...options });
    assert.equal(result.state.reviewReservation.armed, true, JSON.stringify(options));
    assert.equal(result.state.reviews.length, 0, JSON.stringify(options));
    if (options.stopped || options.exitStatus) assert.match(result.transcript, /预约审查仍在等待/);
  }

  const autoFailed = await runTurn("auto-follow-up-execution-error", {
    followUp: true,
    reserve: false,
    autoFollowUp: true,
    executionError: { message: "API Error: 503 service unavailable: no available accounts" },
  });
  assert.equal(autoFailed.state.reviewReservation.armed, false, "修复执行异常后必须取消自动续轮预约");
  assert.equal(autoFailed.state.reviews.length, 1, "执行异常不得启动下一轮审查");
  assert.equal(autoFailed.state.reviews[0]?.status, "stopped");
  assert.equal(autoFailed.state.reviews[0]?.currentRound, 1);
  assert.equal(autoFailed.state.executions.at(-1)?.status, "failed", "exit 0 但带 error 事件的执行应记为失败");
  assert.match(autoFailed.transcript, /自动复审已取消/);

  const compactFailed = await runTurn("auto-follow-up-compact-error", {
    followUp: true,
    reserve: false,
    autoFollowUp: true,
    executionError: {
      message: "上下文压缩失败，会话大小原地不动：API Error: 503 upstream connect error",
      affectsTurn: false,
    },
  });
  assert.equal(compactFailed.state.reviewReservation.armed, false, "修复成功后应消费自动续轮预约");
  assert.equal(compactFailed.state.reviews.length, 1);
  assert.equal(compactFailed.state.reviews[0]?.status, "reviewing", "展示用压缩错误不得阻止下一轮审查");
  assert.equal(compactFailed.state.reviews[0]?.currentRound, 2);
  assert.equal(compactFailed.state.executions.at(-1)?.status, "completed", "展示用压缩错误不得把执行记为失败");

  const reviewedWithCompactError = await runTurn("review-conclusion-with-compact-error", {
    followUp: true,
    role: "reviewer",
    reserve: false,
    reviewConclusion: "verify_failed",
    executionError: {
      message: "上下文压缩失败，会话大小原地不动：API Error: 503 upstream connect error",
      affectsTurn: false,
    },
  });
  assert.equal(reviewedWithCompactError.state.reviews[0]?.status, "stopped", "展示用压缩错误不得覆盖已交审查结论");
  assert.equal(reviewedWithCompactError.state.reviewReservation.armed, true, "未通过结论仍应挂起修复后的自动复审");

  // ── 排队消息优先于预约审查 ──
  // 用户排在托盘里的那几句是给实现会话的后续指令，审查该看的是它们都说完之后的工作区。
  const queued = await runTurn("pending-queued", { followUp: true, pending: { mode: "queued" } });
  assert.equal(queued.state.reviewReservation.armed, true, "有排队消息时预约必须原样留在槽里");
  assert.equal(queued.state.reviews.length, 0, "排队消息还没发完就不能开审");
  assert.match(queued.transcript, /预约审查仍在等待：还有排队消息/);
  // 消息真进了会话之后的那一轮结算：托盘空了，预约照常兑现 —— 让过一次不等于丢掉。
  await db.update(scheduledMessages).set({ status: "sent", sentAt: at })
    .where(eq(scheduledMessages.taskId, "pending-queued"));
  await handleFreeWorkflowSettlement("pending-queued", queued.task.status, false, true);
  const afterSent = await freeWorkflowState("pending-queued");
  assert.equal(afterSent.reviewReservation.armed, false, "消息发完后预约必须被消费");
  assert.equal(afterSent.reviews.length, 1, "消息发完后审查照常开跑");

  // 定时消息只有到点了才算「该发的」：定在一小时后的那条不能把审查挡一小时。
  const future = await runTurn("pending-timed-future", {
    followUp: true, pending: { mode: "timed", sendAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(future.state.reviews.length, 1, "没到钟点的定时消息不挡审查");
  assert.equal(future.state.reviewReservation.armed, false);
  const due = await runTurn("pending-timed-due", { followUp: true, pending: { mode: "timed", sendAt: at } });
  assert.equal(due.state.reviews.length, 0, "已经到点的定时消息同样要先发完");
  assert.equal(due.state.reviewReservation.armed, true);

  // ── 交卷之后不许被「有人在等」挡住结算(D6 现场) ──
  // 现场:执行者挂哨兵、pause_task 收尾,预约审查随即起跑;审查写完报告与结论、正常退出。
  // 结算这一拍读到「owner 还挂着检查点 + continuation 相位是 waiting」,判成「审查在等续跑」,
  // 于是 round 永远挂 reviewing —— 验收 409、自动复审不开、修复交接不发,只有重启能救。
  // 判据:**结论已经写在 round 上、这一轮的 reviewer 回合已经死了**,那就只能往前结算;
  // 「在等」只保护审查**自己**挂的那一份(下一条用例),别人的等待不归它管。
  for (const conclusion of ["verified", "verify_failed"] as const) {
    const id = `stalled-${conclusion}`;
    const stalled = await runTurn(id, {
      followUp: true, role: "reviewer", reserve: false, reviewConclusion: conclusion,
      checkpointDuringReview: "继续:收哨兵结果再往下做",
    });
    const review = stalled.state.reviews[0]!;
    assert.equal(review.rounds[0]?.status, conclusion === "verified" ? "passed" : "failed",
      "执行者的检查点不许把一轮已交卷的审查永久挂在 reviewing");
    assert.equal(review.rounds[0]?.conclusion, conclusion);
    assert.equal(review.status, conclusion === "verified" ? "passed" : "stopped");
    assert.equal(stalled.task.resumePrompt, "继续:收哨兵结果再往下做", "结算不许动执行者那一格");
    assert.equal(stalled.state.reviewReservation.armed, conclusion === "verify_failed",
      "未通过的结论照常挂自动复审预约");
  }

  // 反面:审查**自己**以 pause_task 收尾、还没给结论 —— 这一份等待照旧挡住结算,round 留在
  // reviewing 等它续跑回来交卷。丢掉这一条,审查刚挂起就会被判成异常结束。
  const pausedReview = await runTurn("review-paused-no-conclusion", {
    followUp: true, role: "reviewer", reserve: false, reviewConclusion: null,
    reviewerPause: "继续:把第 3 条意见核完再交卷",
  });
  assert.equal(pausedReview.state.reviews[0]?.rounds[0]?.status, "reviewing",
    "审查自己挂的检查点必须挡住结算(它会续跑回来交卷)");
  assert.equal(pausedReview.state.reviews[0]?.status, "reviewing");
  assert.equal(pausedReview.task.resumePrompt, "继续:把第 3 条意见核完再交卷");

  // 同一个反面,只差**落笔的是系统**:审查挂了哨兵等后台构建,交卷之前这一轮被
  // `beginTerminalLanding` 代写成检查点暂停(auto=true)。拿 auto 当「执行者的」用时,结算读成
  // 「没有人在等」,round 以 status:"error"、conclusion:null 提前结账,而构建结果还没回来 ——
  // 第 2 轮自由审查 F3 用真实 beginTerminalLanding + handleFreeWorkflowSettlement 实测复现。
  // 归属按**哪个回合写的**判之后,这一份照旧挡得住。
  const autoPausedReview = await runTurn("review-auto-checkpoint-no-conclusion", {
    followUp: true, role: "reviewer", reserve: false, reviewConclusion: null,
    reviewerAutoCheckpoint: "继续:哨兵把构建结果送来之后再交卷",
  });
  assert.equal(autoPausedReview.task.resumePromptAuto, true, "这一格确实是系统代写的");
  assert.equal(autoPausedReview.state.reviews[0]?.rounds[0]?.status, "reviewing",
    "审查自己那一轮的等待不许被提前结算 —— 构建结果还没回来");
  assert.equal(autoPausedReview.state.reviews[0]?.rounds[0]?.conclusion, null);
  assert.equal(autoPausedReview.state.reviews[0]?.status, "reviewing");
  assert.equal(autoPausedReview.task.resumePrompt, "继续:哨兵把构建结果送来之后再交卷",
    "它自己那一格也不许被这一轮结算作废掉");

  // ── 运行时自愈:conclusion 已写、round 挂 reviewing、reviewer 回合早死(D6 ②)──
  // 现场的 owner 一直 running:哨兵结果把执行者叫醒去跑**实现回合**。旧判据按「任务忙」一路
  // 跳过,于是只有重启那一次对账能救,链挂了一整天。判据改成读**回合身份**:在跑的不是
  // reviewer 自己那一轮,就说明没人会来替它收尾。
  // 自愈只能判「异常结束」——这一轮没有持久保存的真实退出结果,不许凭已有结论推定正常退出
  // (regression-settlement.ts 那条时间线原话)。要点是链不再挂死:验收能过、用户可再派一轮。
  async function stuckRound(id: string): Promise<string> {
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    const runId = `${id}-review`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
      createdAt: at, updatedAt: at,
    });
    await db.insert(freeReviewRounds).values({
      id: `${runId}-round`, runId, round: 1, status: "reviewing", conclusion: "verify_failed", startedAt: at,
    });
    await evidenceState(id, freeReviewEvidenceDir(id, runId, 1), (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!);
    // 执行者那一格是在审查窗口里写下的(系统代写,auto=true),归属推断正是在这里把它记到审查
    // 头上 —— 但落笔的回合是**执行者**那一轮,所以这一格不归这一轮审查管。
    assert.equal(claimTurn(id, "single"), true);
    assert.equal(await writeResumePrompt(id, "继续:收哨兵结果再往下做", true), true);
    releaseTurn(id);
    return runId;
  }

  const healId = "stuck-executor-running";
  await stuckRound(healId);
  assert.equal(claimTurn(healId, "single"), true); // 执行者正在跑实现回合
  await reconcileFreeReviews(healId);
  releaseTurn(healId);
  const healed = await freeWorkflowState(healId);
  assert.equal(healed.reviews[0]?.rounds[0]?.status, "error", "执行者在跑实现回合不等于审查还活着");
  assert.equal(healed.reviews[0]?.status, "failed");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, healId)))[0]?.resumePrompt,
    "继续:收哨兵结果再往下做", "自愈不许动执行者那一格");

  const liveId = "stuck-reviewer-alive";
  const liveRun = await stuckRound(liveId);
  assert.equal(claimTurn(liveId, "reviewer", { run: liveRun, round: 1 }), true); // reattach 把审查回合接回来了
  await reconcileFreeReviews(liveId);
  releaseTurn(liveId);
  assert.equal((await freeWorkflowState(liveId)).reviews[0]?.rounds[0]?.status, "reviewing",
    "reviewer 自己那一轮还活着,不许替它补结算(错误结论将再也撤不掉)");

  // ── 同一个反面的**跨版本**形态(第 2 轮自由审查 F3)──
  // 升级前那一代写下的等待身上没有 `writer`,「哪个回合写的」这一问在存量行上答不上来。把
  // 「答不上来」折成「不是审查的」,升级那一刻库里每一条还在等哨兵结果的审查都会被对账整批
  // 提前结账 —— 审查者跨版本实测 VERSION legacy / NEW_REVIEW_WAIT false /
  // ROUND_AFTER_RECOVERY status:"error",而那条哨兵仍然 running、结果再也没人接。
  //
  // 所以 unknown 这一档要去问一件**独立于那个字段**的运行时事实:这一轮审查自己挂的哨兵还
  // 在跑吗(`monitors.source_review_run/round`,创建时就落库)。两种现场都得钉住,因为这一档
  // 往两边倒都有代价:一律当成「不是审查的」= 上面那条提前结账;一律当成「是审查的」= 退回
  // D6 之前「执行者遗留的那一格把审查交卷永久挡住」。
  //
  // ── 同一个入口的**第三轮**形态(第 3 轮自由审查 F2)──
  // 「这一轮审查还欠着哨兵结果吗」上一版问成了「它的哨兵进程还在跑吗」。进程结束推不出等待
  // 结束:真实收尾是先把结果入待发送托盘(origin=`monitor:<id>`)、哨兵行随后才落 exited,
  // 中间还有一档「结局已写定、通知还没入队」(`result_handoff_at` 还挂着)。于是哨兵一 exited
  // 这一问就答「不欠了」,round 落 error、来源审查失效,那条排着的结果随即被作废 —— 审查者实
  // 测 WRITER_PENDING origin="monitor:m" → SOURCE_ACTIVE false → PENDING_AFTER_RECOVERY
  // status="canceled"。改成跟完成闸同一份三类责任集合(在跑 / 已排队未消费 / 待交接),所以这
  // 四种「欠着」的形态都得钉住,外加一个「一格等待都没留下」的旁路入口。
  type Owed = "running" | "none" | "pending-result" | "message-only" | "handoff" | "crashed-pending";

  async function legacyWaitRound(id: string, owed: Owed): Promise<string> {
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    const runId = `${id}-review`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
      createdAt: at, updatedAt: at,
    });
    // 还没交卷(conclusion 为空):交卷之后那一档由 hasConclusion 直接放行,不走归属这一问。
    await db.insert(freeReviewRounds).values({
      id: `${runId}-round`, runId, round: 1, status: "reviewing", startedAt: at,
    });
    await evidenceState(id, freeReviewEvidenceDir(id, runId, 1), (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!);
    // 这一格是**审查自己那一轮**被系统代写的(哨兵还在盯),所以先按审查的回合身份落笔 ——
    // 走的是生产 writer,连带写入原样发生。
    assert.equal(claimTurn(id, "reviewer", { run: runId, round: 1 }), true);
    assert.equal(await writeResumePrompt(id, "继续:哨兵把构建结果送来之后再交卷", true), true);
    releaseTurn(id);
    // 然后把 `writer` 抹掉 = 升级前那一代写下来的样子(那一代压根没有这个字段)。归属
    // (origin/generation)照旧在 —— 旧版本记得「这一格属于这一轮」,只是不记得是谁落的笔。
    const row = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
    const checkpoint = row.waitOwnership?.checkpoint;
    assert.ok(checkpoint?.writer, "夹具前提:生产 writer 本来是记下了落笔回合的");
    await db.update(tasks).set({ waitOwnership: { ...row.waitOwnership,
      checkpoint: { generation: checkpoint.generation, origin: checkpoint.origin } } }).where(eq(tasks.id, id));
    const sentinel = `${id}-sentinel`;
    const sentinelRow = {
      id: sentinel, taskId: id, command: "npm run build", cwd: root,
      logPath: join(root, `${sentinel}.log`), startedAt: at,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      sourceReviewRun: runId, sourceReviewRound: 1,
    };
    // 结果已经排进待发送托盘的那两种:消息自己也带着来源身份(入队时从哨兵行抄下来),所以
    // **哨兵行还在**(pending-result)和**哨兵行已经被清掉**(message-only)都得认出来。
    const queueResult = async () => {
      await db.insert(scheduledMessages).values(pendingMessageRow({
        taskId: id, text: "BUILD OK", origin: `monitor:${sentinel}`,
        turnSource: { role: "reviewer", review: { run: runId, round: 1 } },
      }));
    };
    if (owed === "running") await db.insert(monitors).values({ ...sentinelRow, status: "running" });
    if (owed === "pending-result" || owed === "handoff") await db.insert(monitors).values({
      ...sentinelRow, status: "exited", endedAt: at, endedReason: "exited",
      // handoff:结局写定、【哨兵结束】还没入队那一瞬 —— 凭证跟终态是同一条 UPDATE 落的。
      ...(owed === "handoff" ? { resultHandoffAt: at } : {}),
    });
    if (owed === "pending-result" || owed === "message-only") await queueResult();
    // 旁路入口:回合直接死了(崩溃/被杀),landCheckpoint 那一笔没落成,一格等待都没留下,
    // 而结果仍确凿地排在托盘里。三格归属全空,只有责任集合这一问答得上来。
    if (owed === "crashed-pending") {
      await queueResult();
      const held = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
      await db.update(tasks).set({ resumePrompt: null, resumePromptAuto: false,
        waitOwnership: { ...held.waitOwnership, checkpoint: undefined } }).where(eq(tasks.id, id));
    }
    // 执行者正在跑实现回合:对账据此判定「在跑的不是 reviewer 自己那一轮」,于是往下走到
    // 归属这一问 —— 跟上面 D6 ② 同一个入口。
    assert.equal(claimTurn(id, "single"), true);
    await reconcileFreeReviews(id);
    releaseTurn(id);
    return runId;
  }

  const legacyWatchedId = "legacy-wait-still-watched";
  await legacyWaitRound(legacyWatchedId, "running");
  const legacyWatched = await freeWorkflowState(legacyWatchedId);
  assert.equal(legacyWatched.reviews[0]?.rounds[0]?.status, "reviewing",
    "旧行没记下是谁落的笔,而这一轮自己的哨兵还在盯 —— 不许提前结账");
  assert.equal(legacyWatched.reviews[0]?.rounds[0]?.conclusion, null);
  assert.equal(legacyWatched.reviews[0]?.status, "reviewing");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, legacyWatchedId)))[0]?.resumePrompt,
    "继续:哨兵把构建结果送来之后再交卷", "它自己那一格也不许被作废掉");

  const legacyDoneId = "legacy-wait-no-sentinel";
  await legacyWaitRound(legacyDoneId, "none");
  assert.equal((await freeWorkflowState(legacyDoneId)).reviews[0]?.rounds[0]?.status, "error",
    "同样一张来路不明的旧行,这一轮名下一条在盯的哨兵都没有 —— 没有任何事实支持「审查还在等」,照旧结账(D6)");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, legacyDoneId)))[0]?.resumePrompt,
    "继续:哨兵把构建结果送来之后再交卷", "结算照旧不许作废这一格 —— 不知道是谁的就别动它");

  // 欠着结果的另外四种形态:**进程都已经不在跑了**,一条都不许据此提前结账。
  for (const [owed, why] of [
    ["pending-result", "命令跑完了,结果还排在待发送托盘里 —— 审查者一个字都没看到"],
    ["message-only", "哨兵行已经被清掉,只有那条排着的消息自己记着是哪一轮的 —— 行没了责任还在"],
    ["handoff", "结局已写定、【哨兵结束】还没入队那一瞬(交接凭证还挂着)"],
    ["crashed-pending", "回合直接死了没留下任何等待格,而结果仍排在托盘里"],
  ] as [Owed, string][]) {
    const owedId = `legacy-wait-${owed}`;
    await legacyWaitRound(owedId, owed);
    const state = await freeWorkflowState(owedId);
    assert.equal(state.reviews[0]?.rounds[0]?.status, "reviewing", `${why} —— 不许提前结账`);
    assert.equal(state.reviews[0]?.rounds[0]?.conclusion, null, `${owed}:也不许凭空给它一个结论`);
    assert.equal(state.reviews[0]?.status, "reviewing", `${owed}:来源审查不许失效 —— 失效之后那条结果就被作废了`);
    const queued = await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, owedId));
    for (const message of queued) {
      assert.equal(message.status, "pending", `${owed}:排着的那条结果必须原样留着`);
    }
  }

  const noReservation = await runTurn("no-reservation", { followUp: true, reserve: false });
  assert.equal(noReservation.state.reviews.length, 0, "没有用户预约不自动开审");
  const confirmed = await runTurn("confirmed", { confirmed: true });
  assert.equal(confirmed.task.status, "done");
  assert.equal(confirmed.state.reviews.length, 1);
  const prompt = FOLLOW_UP_REMINDER("free", "done", false, false, "", true);
  assert.match(prompt, /已预约的审查会在执行回合正常结束后独立触发/);
  assert.doesNotMatch(prompt, /不确认它们就一直停在原地/);
  console.log("✓ 真实单任务收流：漏确认仍派预约审查，完成协议不变；排队消息先发完再开审；中断、等待、原生命令与审查回合不消费预约；交卷后不被他人的等待挡住结算，reviewer 回合死掉的 round 由对账自愈");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
