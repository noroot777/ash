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
  const { agents, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { freeWorkflowState, handleFreeWorkflowSettlement, reportFreeReviewConclusion, reserveFreeReview } = await import("../src/free-workflow.js");
  const { freeReviewReportPath } = await import("../src/free-review-files.js");
  const { claimTurn, confirmDone, markStopped } = await import("../src/runs.js");
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
    role?: "single" | "reviewer";
    reserve?: boolean;
    reviewConclusion?: "verified" | "verify_failed" | null;
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
    if (options.reserve !== false) {
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
      if (options.reviewConclusion) {
        const report = freeReviewReportPath(id, runId, 1);
        mkdirSync(dirname(report), { recursive: true });
        writeFileSync(report, "审查证据已核实。\n");
        await reportFreeReviewConclusion(id, options.reviewConclusion);
      }
    }
    if (options.confirmed === "persisted") {
      await db.update(tasks).set({ completeConfirmedAt: at }).where(eq(tasks.id, id));
    } else if (options.confirmed) confirmDone(id);
    if (options.stopped) markStopped(id, options.stopped);
    const path = sessionTranscriptPath(id, sessId);
    mkdirSync(dirname(path), { recursive: true });
    const out = createWriteStream(path, { flags: "a" });
    const closed = once(out, "close");
    const handle: RunHandle = {
      sessionId: "", commandLine: "fixture", kill() {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "text", text: "本轮输出。" };
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
    { truncated: true, confirmed: true, stopped: "canceled" as const },
    { role: "reviewer" as const },
  ]) {
    const id = `blocked-${++blockedCase}`;
    const result = await runTurn(id, { followUp: true, ...options });
    assert.equal(result.state.reviewReservation.armed, true, JSON.stringify(options));
    assert.equal(result.state.reviews.length, 0, JSON.stringify(options));
    if (options.stopped || options.exitStatus) assert.match(result.transcript, /预约审查仍在等待/);
  }

  const noReservation = await runTurn("no-reservation", { followUp: true, reserve: false });
  assert.equal(noReservation.state.reviews.length, 0, "没有用户预约不自动开审");
  const confirmed = await runTurn("confirmed", { confirmed: true });
  assert.equal(confirmed.task.status, "done");
  assert.equal(confirmed.state.reviews.length, 1);
  const prompt = FOLLOW_UP_REMINDER("free", "done", false, false, "", true);
  assert.match(prompt, /已预约的审查会在执行回合正常结束后独立触发/);
  assert.doesNotMatch(prompt, /不确认它们就一直停在原地/);
  console.log("✓ 真实单任务收流：漏确认仍派预约审查，完成协议不变；中断、等待、原生命令与审查回合不消费预约");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
