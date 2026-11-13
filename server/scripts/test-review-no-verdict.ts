// 一轮审查没给出结论时，ash 说的那句话和写进轮次的那份原因（review-channel-gap.ts 的
// noteReviewerChannelGap + review-no-verdict.ts）。
//
// 现场（2026-11-13，任务 EhQtqns9fnG2 第 1 轮）：codex 审查者产出过正文和工具之后，模型上游开始回
// 503，重连 5 次放弃、exit 1，report.md 没写。ash 说的却是「报告可能已经写完了，只是结论没能上报，
// 最可能是手上没有 report_stage（自查：codex mcp list --json…）」—— 三处全错。
//
// 覆盖：
//   1. 回合中途断了（非零退出、诊断原因是上游 503）：说上游与状态码、说报告没写、不提 report_stage
//      和 MCP 自查；结构化原因是 interrupted；原话里网关错误页的 504 不被当成状态码
//   2. 回合正常收尾却没上报：报告在 → 通道那套说法并说写完了；报告不在 → 不说写完
//   3. 被停掉的、没产出过正文的：不说话，并把那一列清掉
//   4. 状态接口只在这一轮仍是「error 且没结论」时带出 noVerdict
//   5. 单飞收尾把「这一回合自己异常结束」的事实交进来（接线）
//
// 跑：npm -w server run test:review-no-verdict
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-review-no-verdict-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;
process.env.ASH_RUNS_DIR = join(stage, "runs");

// 现场那份诊断原文的形状（截过）：前半句是 codex 的错误，后面夹着一段网关错误页，里头还有个 504。
const UPSTREAM_503 = "unexpected status 503 Service Unavailable: auth_unavailable: no auth available "
  + "(providers=codex, model=gpt-6.1-sol; last upstream error: <html>\n  <head>\n"
  + "    <li>Error reference number: 504</li>), url: https://example.invalid/v1/responses";

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  await ensureSchema();
  const { freeReviewRounds, freeReviewRuns, projects, sessions } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { createTasks } = await import("../src/task-store.js");
  const { appendSessionTrace, runTracePaths, sessionTranscriptPath } = await import("../src/transcript.js");
  const { RUNS_DIR } = await import("../src/paths.js");
  const { freeReviewReportPath } = await import("../src/free-review-files.js");
  const { noteReviewerChannelGap } = await import("../src/review-channel-gap.js");
  const { interruptionOf, upstreamStatus } = await import("../src/review-no-verdict.js");
  const { freeWorkflowState } = await import("../src/free-workflow-state.js");

  const at = "2026-11-13T11:15:00.155Z";
  const repo = join(stage, "repo");
  mkdirSync(repo, { recursive: true });
  await db.insert(projects).values({ id: "p", name: "p", repoPath: repo, createdAt: at, updatedAt: at });

  let n = 0;
  /** 造一轮落了 error、没结论的审查，外加审查者那一回合留在盘上的东西。 */
  const scene = async (o: {
    work?: boolean;
    report?: boolean;
    diagnostics?: Record<string, unknown>;
    status?: string;
    conclusion?: string | null;
  } = {}) => {
    const taskId = `t${++n}`;
    const runId = `${taskId}-run`;
    const sessId = `${taskId}-rev`;
    await createTasks([{
      id: taskId, projectId: "p", title: taskId, body: "test", mode: "single", status: "done",
      agentType: "codex", executorId: null, autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.insert(sessions).values({
      id: sessId, taskId, role: "reviewer", agentType: "codex", executor: "codex", cwd: repo,
      startedAt: at, turnStartedAt: at, activeMs: 0, sideTurn: true,
    } as typeof sessions.$inferInsert);
    await db.insert(freeReviewRuns).values({
      id: runId, taskId, reviewerName: "codex 审查", agentType: "codex", checkMode: "standard",
      status: "failed", currentRound: 1, retryLimit: 1, createdAt: at, updatedAt: at,
    } as typeof freeReviewRuns.$inferInsert);
    await db.insert(freeReviewRounds).values({
      id: `${runId}-1`, runId, round: 1, status: o.status ?? "error", conclusion: o.conclusion ?? null, startedAt: at, endedAt: at,
    } as typeof freeReviewRounds.$inferInsert);
    if (o.work !== false) {
      appendSessionTrace(taskId, sessId, at, { kind: "text", text: "先读 diff。", at } as never);
      appendSessionTrace(taskId, sessId, at, { kind: "tool", name: "shell", input: "npm run build", at } as never);
    }
    mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
    if (o.diagnostics) {
      writeFileSync(runTracePaths(join(RUNS_DIR, taskId), sessId, at).diagnosticsPath, JSON.stringify({ version: 1, ...o.diagnostics }));
    }
    if (o.report) {
      const path = freeReviewReportPath(taskId, runId, 1);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "# 第 1 轮审查\n\n结论：通过。\n");
    }
    const timeline = () => {
      const path = sessionTranscriptPath(taskId, sessId);
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    const cause = async () => (await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.runId, runId)))[0]!.noVerdict;
    const note = (extra: Partial<Parameters<typeof noteReviewerChannelGap>[0]> = {}) => noteReviewerChannelGap({
      taskId, sessId, turnStart: at, agentType: "codex", stopped: false, review: { run: runId, round: 1 }, failure: null, ...extra,
    });
    return { taskId, runId, timeline, cause, note };
  };

  // ── 1. 回合中途断了：上游 503 ─────────────────────────────────────────────
  {
    assert.equal(upstreamStatus([UPSTREAM_503]), 503, "取紧跟 status 的那个码，不取错误页里的 504");
    const s = await scene({ diagnostics: { failureKind: "nonzero_exit", failureReason: UPSTREAM_503, exitSignal: null } });
    const said = await s.note({ failure: { exitStatus: 1, verdict: null, lastError: null } });
    assert.equal(said, true, "中途断了也要说");
    const text = s.timeline();
    assert.match(text, /模型上游连不上（状态码 503）/, "说上游与状态码");
    assert.match(text, /exit 1/, "说执行器怎么退的");
    assert.match(text, /执行器的原话：「unexpected status 503 Service Unavailable: auth_unavailable: no auth available」/, "带上执行器原话，截到错误页之前");
    assert.doesNotMatch(text, /<html|Error reference/, "网关错误页不贴进来");
    assert.match(text, /报告还没写/, "看文件：报告没写就说没写");
    assert.doesNotMatch(text, /报告可能已经写完|报告已经写/, "不说报告写完了");
    assert.doesNotMatch(text, /report_stage|mcp list|MCP/i, "不推断上报通道，也不给 MCP 自查");
    assert.match(text, /等上游恢复后点「继续本轮审查」/, "下一步：上游恢复后继续本轮审查");
    assert.match(text, /"kind":"review\.no_verdict"/, "时间线那条带结构化 kind，展示端不认文字");
    assert.deepEqual(await s.cause(), { kind: "interrupted", reason: "模型上游连不上（503）" }, "写进轮次的原因是「回合中断」那一类");

    // 没有诊断文件（claude 这类执行器）：靠回合里报的执行故障原文。
    const claude = await scene();
    await claude.note({ failure: { exitStatus: 0, verdict: null, lastError: "API Error: 529 {\"type\":\"overloaded_error\"}" } });
    assert.deepEqual(await claude.cause(), { kind: "interrupted", reason: "模型上游连不上（529）" });
    // 看门狗熔断：整段只收到重试类错误，没有状态码也是上游。
    const tripped = await scene();
    await tripped.note({ failure: { exitStatus: 0, verdict: { kind: "tripped", reason: "15 分钟里只收到重试类错误" }, lastError: null } });
    assert.deepEqual(await tripped.cause(), { kind: "interrupted", reason: "模型上游连不上" });
    // 不是上游的崩溃：按退出码说，不冒充上游。
    const crash = await scene();
    await crash.note({ failure: { exitStatus: 137, verdict: null, lastError: null } });
    assert.deepEqual(await crash.cause(), { kind: "interrupted", reason: "执行器异常退出（exit 137）" });
    assert.doesNotMatch(crash.timeline(), /等上游恢复/, "不是上游的就别叫人等上游");
    assert.equal(interruptionOf({ exitStatus: 1, verdict: null, lastError: null }, { failureReason: null, exitSignal: "SIGKILL" }).reason,
      "执行器进程被 SIGKILL 结束");
  }

  // ── 2. 回合正常收尾却没上报 ────────────────────────────────────────────────
  {
    const written = await scene({ report: true });
    assert.equal(await written.note(), true);
    assert.match(written.timeline(), /审查报告已经写完了，只是结论没能上报到 ash/, "报告在：说写完了");
    assert.match(written.timeline(), /report_stage/, "仍是通道那套说法");
    assert.deepEqual(await written.cause(), { kind: "unreported", reason: "报告写完了，结论没报上来" });

    const missing = await scene();
    assert.equal(await missing.note(), true);
    assert.doesNotMatch(missing.timeline(), /写完|写得完整/, "报告不在：不说写完");
    assert.match(missing.timeline(), /报告还没写/);
    assert.match(missing.timeline(), /report_stage/, "通道那套推断照旧");
    assert.deepEqual(await missing.cause(), { kind: "unreported", reason: "回合收尾了，结论没报上来" });
  }

  // ── 3. 被停、没产出过：不说话，清掉那一列 ───────────────────────────────────
  {
    const stopped = await scene();
    await db.update(freeReviewRounds).set({ noVerdict: { kind: "interrupted", reason: "旧的" } }).where(eq(freeReviewRounds.runId, stopped.runId));
    assert.equal(await stopped.note({ stopped: true, failure: { exitStatus: 1, verdict: null, lastError: UPSTREAM_503 } }), false);
    assert.equal(stopped.timeline(), "", "被停的不说话");
    assert.equal(await stopped.cause(), null, "上一回合的原因不再挂在这一轮上");

    const idle = await scene({ work: false });
    assert.equal(await idle.note({ failure: { exitStatus: 1, verdict: null, lastError: UPSTREAM_503 } }), false);
    assert.equal(idle.timeline(), "", "没产出过正文的不说话");
    assert.equal(await idle.cause(), null);

    const concluded = await scene({ status: "done", conclusion: "verified" });
    assert.equal(await concluded.note({ failure: { exitStatus: 1, verdict: null, lastError: UPSTREAM_503 } }), false, "出了结论的轮次不归这里");
  }

  // ── 4. 状态接口 ──────────────────────────────────────────────────────────
  {
    const s = await scene({ diagnostics: { failureReason: UPSTREAM_503, exitSignal: null } });
    await s.note({ failure: { exitStatus: 1, verdict: null, lastError: null } });
    const round = (await freeWorkflowState(s.taskId)).reviews[0]!.rounds[0]!;
    assert.deepEqual(round.noVerdict, { kind: "interrupted", reason: "模型上游连不上（503）" }, "error 且没结论：带出原因");
    // 续过之后这一轮出了结论：旧原因不再作数，哪怕那一列还没被下一回合改写。
    await db.update(freeReviewRounds).set({ status: "done", conclusion: "verified" }).where(eq(freeReviewRounds.runId, s.runId));
    assert.equal((await freeWorkflowState(s.taskId)).reviews[0]!.rounds[0]!.noVerdict, undefined);
  }

  // ── 5. 接线 ───────────────────────────────────────────────────────────────
  {
    const run = readFileSync(new URL("../src/single-run.ts", import.meta.url), "utf8");
    assert.match(run, /const failure = executionFailed \? \{ exitStatus, verdict: watchdogFailure, lastError: lastExecutionError \} : null;/,
      "单飞收尾按「这一回合自己异常结束」交事实：退出码、看门狗判决、最后一条执行故障");
    assert.match(run, /noteReviewerChannelGap\(\{[^}]*failure \}\)/, "交进说明里");
    assert.match(run, /sawExecutionError = true; lastExecutionError = emittedEvent\.message;/, "执行故障原文跟着那一位一起记");
  }

  console.log("✅ 审查没结论：中途断了说怎么断的、没上报才说通道、报告写没写看文件、原因按结构进轮次");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
