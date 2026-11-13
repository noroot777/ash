// 「审查未通过 → 执行者开始修」中间那段等待。
//
// 现场(用户 2026-11-13 截图):时间线上已经写了「第 2 轮审查未通过,1 条意见」,托盘里那条
// 【自由工作流审查未通过】却挂着「等待当前一轮结束」迟迟不动。库里的时间戳说得很清楚:
// 修复指令的 sent_at 全部落在 30 秒兜底 tick 的相位上,入队到送达平均 15 秒、最长 30 秒。
//
// 根因:排队消息的「任务空下来」触发源挂在**落状态那一刻**(status.ts 的钩子),而修复指令是
// 结算钩子(afterSettlement → 审查收尾)在那之后才入队的 —— 那次扫描看不到它,回合锁放开时
// 又没有任何人登记过「放开了就送」。
//
// 走的是真实收流(consumeSingleRun)加上跟 orchestrator 一样的「收流完再放锁」,而且**全程
// 不起 scheduler**:这里能送出去,只可能是结算那一刻登记的唤醒。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import type { AgentExecutor, RunHandle, RunOpts } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-repair-wake-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_LAX_DONE;
delete process.env.ASH_ALLOW_REAL_AGENT;

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { freeWorkflowState, reportFreeReviewConclusion } = await import("../src/free-workflow.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  const { claimOwnTurn, isTurnClaimed, releaseTurn } = await import("../src/runs.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { ClaudeExecutor } = await import("../src/executors/claude.js");
  const { CodexExecutor } = await import("../src/executors/codex.js");
  await ensureSchema();

  // 修复回合由生产的投递链路(dispatchPendingMessage → continueTask)自己拉起,这里只换掉
  // 「真的起一个 CLI」那一步,并记下它拿到的输入。退出码 1 = 修复回合异常结束:自动复审随之
  // 取消,这条链就停在这儿,不再往下开第 2 轮。
  const delivered: string[] = [];
  const run = (opts: RunOpts): RunHandle => {
    delivered.push(opts.prompt);
    return {
      sessionId: "repair-wake-test", commandLine: "fixture repair", kill() {},
      events: (async function* (): AsyncGenerator<AgentEvent> { yield { kind: "done", exitStatus: 1 }; })(),
    };
  };
  for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
    executor.run = run;
    executor.runSteerable = run;
  }

  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "repair wake", repoPath: root, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "codex", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "reviewer", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(message);
  };

  const id = "repair-wake";
  await createTasks([{
    id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
    agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
    useWorktree: false, createdAt: at, updatedAt: at,
  }]);
  // 执行者那条会话早就结束了(修复指令要续的就是它);审查旁路回合正占着 turn。
  await db.insert(sessions).values({
    id: `${id}-single`, taskId: id, role: "single", agentType: "codex", executor: "test",
    cwd: root, startedAt: at, turnStartedAt: at, endedAt: at,
  });
  const runId = `${id}-review`;
  await db.insert(freeReviewRuns).values({
    id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "reviewer", agentType: "codex",
    executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: at, updatedAt: at,
  });
  await db.insert(freeReviewRounds).values({ id: `${runId}-round-1`, runId, round: 1, status: "reviewing", startedAt: at });
  const sessId = `${id}-reviewer`;
  await db.insert(sessions).values({
    id: sessId, taskId: id, role: "reviewer", agentType: "codex", executor: "test", cwd: root, startedAt: at, turnStartedAt: at,
  });
  const turn = claimOwnTurn(id, "reviewer", { run: runId, round: 1 });
  assert.ok(turn, "测试自身前提:审查旁路回合应该占得到锁");
  await evidenceState(id, freeReviewEvidenceDir(id, runId, 1), (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!);

  // 审查者交卷(报告 + 未通过)后正常退出。
  const report = freeReviewReportPath(id, runId, 1);
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "# 审查报告\n\n1. 保存后列表没刷新。\n");
  await reportFreeReviewConclusion(id, "verify_failed");
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
  const reviewer: AgentExecutor = {
    type: "codex", label: "fixture", run: () => handle,
    resumeCommand: () => "", resumeFields: () => ({ resumeCommand: "", resumeEnv: null, resumeArgs: null }),
  };
  await consumeSingleRun({
    taskId: id, sessId, agentType: "codex", ex: reviewer, cwd: root, handle, out,
    turnStart: at, cliSessionId: "", autoTitle: false, role: "reviewer",
  });
  await closed;

  const repair = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, id)))
    .find((row) => row.origin?.startsWith("review-settlement:"));
  assert.equal((await repair())?.status, "pending", "审查未通过:修复指令应已进待发送队列");
  assert.equal((await freeWorkflowState(id)).reviews[0]?.status, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(delivered.length, 0, "审查回合的锁还占着,修复不许抢跑");

  // orchestrator 在 consumeSingleRun 返回之后才放锁(continueTask 的 finally)。
  releaseTurn(id, turn);
  await waitFor(() => delivered.length === 1,
    "审查回合的锁一放,修复指令就该送进执行者会话 —— 没人登记唤醒的话它要干等 30 秒兜底 tick");
  assert.match(delivered[0]!, /【自由工作流审查未通过 · 第 1 轮】/, "送进去的就是那条修复指令");
  await waitFor(async () => (await repair())?.status === "sent", "送进会话之后这一行应标 sent");
  await waitFor(async () => {
    const status = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!.status;
    return status !== "running" && status !== "queued" && !isTurnClaimed(id);
  }, "修复回合没有结算");
  assert.equal(delivered.length, 1, "修复指令只送一次");
  console.log("✓ 审查未通过:修复指令在审查回合放锁那一刻送达执行者,不等兜底 tick");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
