// 审查进行中调整这条审查链的轮数上限（free-review-rounds.ts）以及结算按落笔时的上限判定。
//
// 用户要的那件事：最后一轮审查跑着时把轮数加上去，这一轮没通过就得把意见交给执行者修复、
// 挂上修完自动续审——而不是按派审时定死的上限判成「用完」停下来。走的是真实的审查回合收流
// （consumeSingleRun → handleFreeWorkflowSettlement → 收尾排空），不是直接调判定函数。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import type { AgentExecutor, RunHandle } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-review-rounds-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_LAX_DONE;

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { freeWorkflowState, reportFreeReviewConclusion } = await import("../src/free-workflow.js");
  const { adjustFreeReviewRounds } = await import("../src/free-review-rounds.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  const { claimTurn } = await import("../src/runs.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "review rounds", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  /** 一条停在「第 round 轮审查中」的任务：执行者已完成，审查旁路回合占着 turn。 */
  async function reviewingTask(id: string, opts: { retryLimit: number; round?: number; targetKind?: "workspace" | "accepted_merge" }) {
    const round = opts.round ?? 1;
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    const runId = `${id}-review`;
    await db.insert(freeReviewRuns).values({
      id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
      executorId: "ex", checkMode: "logic", retryLimit: opts.retryLimit, currentRound: round, status: "reviewing",
      targetKind: opts.targetKind ?? "workspace", createdAt: at, updatedAt: at,
    });
    for (let index = 1; index < round; index++) {
      await db.insert(freeReviewRounds).values({
        id: `${runId}-round-${index}`, runId, round: index, status: "failed", conclusion: "verify_failed", startedAt: at, endedAt: at,
      });
    }
    await db.insert(freeReviewRounds).values({ id: `${runId}-round-${round}`, runId, round, status: "reviewing", startedAt: at });
    const sessId = `${id}-reviewer-session`;
    await db.insert(sessions).values({
      id: sessId, taskId: id, role: "reviewer", agentType: "codex", executor: "test", cwd: root, startedAt: at, turnStartedAt: at,
    });
    assert.equal(claimTurn(id, "reviewer"), true);
    await evidenceState(id, freeReviewEvidenceDir(id, runId, round), (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!);
    return { runId, sessId, round };
  }

  /** 审查者交卷（报告 + 结论）后正常退出，走真实收流与结算。 */
  async function finishReview(id: string, sessId: string, runId: string, round: number, conclusion: "verified" | "verify_failed") {
    const report = freeReviewReportPath(id, runId, round);
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, "审查证据已核实。\n");
    await reportFreeReviewConclusion(id, conclusion);
    const path = sessionTranscriptPath(id, sessId);
    mkdirSync(dirname(path), { recursive: true });
    const out = createWriteStream(path, { flags: "a" });
    const closed = once(out, "close");
    const handle: RunHandle = {
      sessionId: "", commandLine: "fixture", kill() {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "text", text: "审查完毕。" };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
    const executor: AgentExecutor = {
      type: "codex", label: "fixture", run: () => handle,
      resumeCommand: () => "", resumeFields: () => ({ resumeCommand: "", resumeEnv: null, resumeArgs: null }),
    };
    await consumeSingleRun({
      taskId: id, sessId, agentType: "codex", ex: executor, cwd: root, handle, out,
      turnStart: at, cliSessionId: "", autoTitle: false, role: "reviewer",
    });
    await closed;
  }

  const repairMessages = async (id: string) => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, id)))
    .filter((row) => row.origin?.startsWith("review-settlement:"));

  // ① 最后一轮跑着时加一轮：这一轮没通过 → 意见交给执行者（待发送队列里有修复指令）+ 挂续审。
  {
    const id = "last-round-extended";
    const { runId, sessId, round } = await reviewingTask(id, { retryLimit: 0 });
    const state = await adjustFreeReviewRounds(id, { runId, retryLimit: 1 });
    assert.equal(state.reviews[0]?.retryLimit, 1, "调整后的快照立刻反映新上限");
    await finishReview(id, sessId, runId, round, "verify_failed");
    const after = await freeWorkflowState(id);
    assert.equal(after.reviews[0]?.status, "stopped", "加了轮数的最后一轮未通过应转修复，不判用完");
    assert.equal(after.reviewReservation.armed, true, "修完自动续审的预约必须挂上");
    assert.equal(after.reviewReservation.runId, runId, "续审接在同一条链上");
    assert.equal(after.reviewReservation.retryLimit, 1, "续轮预约记下的是新上限");
    assert.equal((await repairMessages(id)).length, 1, "修复指令必须进待发送队列，执行者才会被叫起来");
  }

  // ② 对照：不调整，最后一轮未通过 → 用完，不叫执行者。
  {
    const id = "last-round-untouched";
    const { runId, sessId, round } = await reviewingTask(id, { retryLimit: 0 });
    await finishReview(id, sessId, runId, round, "verify_failed");
    const after = await freeWorkflowState(id);
    assert.equal(after.reviews[0]?.status, "stopped");
    assert.equal(after.reviewReservation.armed, false, "轮数用完不挂续审");
    assert.equal((await repairMessages(id)).length, 0, "轮数用完不自动投递修复");
  }

  // ③ 往下调到「这一轮就是最后一轮」：未通过 → 用完。
  {
    const id = "rounds-reduced";
    const { runId, sessId, round } = await reviewingTask(id, { retryLimit: 2, round: 2 });
    await adjustFreeReviewRounds(id, { runId, retryLimit: 1 });
    await finishReview(id, sessId, runId, round, "verify_failed");
    const after = await freeWorkflowState(id);
    assert.equal(after.reviewReservation.armed, false, "调成最后一轮后未通过就该停下");
    assert.equal((await repairMessages(id)).length, 0);
  }

  // ④ 入参与状态门禁。
  {
    const id = "rounds-guards";
    const { runId, sessId, round } = await reviewingTask(id, { retryLimit: 3, round: 3 });
    await assert.rejects(adjustFreeReviewRounds(id, { runId, retryLimit: 1 }), /不能少于 3/, "上限不能低于正在跑的那一轮");
    await assert.rejects(adjustFreeReviewRounds(id, { runId, retryLimit: 99 }), /0-20/, "越过全局上限按同一条校验拒");
    await assert.rejects(adjustFreeReviewRounds(id, { runId: "nope", retryLimit: 3 }), /审查记录不存在/);
    await assert.rejects(adjustFreeReviewRounds("last-round-extended", { runId, retryLimit: 3 }), /审查记录不存在/, "别的任务的 run 不认");
    await finishReview(id, sessId, runId, round, "verified");
    await assert.rejects(adjustFreeReviewRounds(id, { runId, retryLimit: 5 }), /已经结束/, "结算之后改不上，如实拒掉");
    const merge = await reviewingTask("rounds-merge", { retryLimit: 0, targetKind: "accepted_merge" });
    await assert.rejects(adjustFreeReviewRounds("rounds-merge", { runId: merge.runId, retryLimit: 1 }), /合并结果审查/);
  }

  console.log("✓ 审查进行中调整轮数：最后一轮加轮后未通过转修复并挂续审，不加/减到最后一轮则停下；越界、他人 run、已结算、合并审查一律拒");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
