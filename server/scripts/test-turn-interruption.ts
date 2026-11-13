// 普通回合异常结束以后，给页面的那份「怎么断的」（turn-interruption.ts → session_turns.interruption →
// Session.turnInterruption；直播那一路跟着 done 事件播出去）。
//
// 现场（2026-11-13）：续聊回合、自由工作流的自动修复回合崩了，任务停在已完成，会话里那句「这一轮
// 异常结束」点开只有「执行异常结束 · exit 1」—— 看不出出了什么错。审查回合早就会说怎么断的
// （review-no-verdict.ts），这里盯普通回合用的是同一套判法、同一份结构，并且跟着回合走。
//
// 覆盖：
//   1. 续聊回合非零退出、codex 诊断原因是上游 503：会话行上是「模型上游连不上（503）」，带执行器原话
//   2. 没有诊断文件、只有退出码：「执行器异常退出（exit N）」
//   3. 被手动停止的、正常结束的：不给原因（就算调用方塞了一份也不落）；老记录（那一列为空）也没有
//   4. 收过口的回合不被改写：后到的收尾不把原因改掉
//   5. 接线：单飞收尾只在结局是 failed 时判，同一份既落回合、也跟着 done 播出去
//
// 跑：npm -w server run test:turn-interruption
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-turn-interruption-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;
process.env.ASH_RUNS_DIR = join(stage, "runs");

// 现场那份诊断原文的形状（截过）：前半句是 codex 的错误，后面夹着一段网关错误页。
const UPSTREAM_503 = "unexpected status 503 Service Unavailable: auth_unavailable: no auth available "
  + "(providers=codex, model=gpt-6.1-sol; last upstream error: <html>\n  <head>\n"
  + "    <li>Error reference number: 504</li>), url: https://example.invalid/v1/responses";

try {
  const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
  await ensureSchema();
  const { projects, sessions } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { runTracePaths } = await import("../src/transcript.js");
  const { RUNS_DIR } = await import("../src/paths.js");
  const { openTurn, recordTurnSpan } = await import("../src/session-turns.js");
  const { turnInterruptionOf } = await import("../src/turn-interruption.js");
  const { sessionsForTask } = await import("../src/task-session-routes.js");

  const at = "2026-11-13T12:00:00.000Z";
  const end = "2026-11-13T12:03:00.000Z";
  const repo = join(stage, "repo");
  mkdirSync(repo, { recursive: true });
  await db.insert(projects).values({ id: "p", name: "p", repoPath: repo, createdAt: at, updatedAt: at });

  let n = 0;
  /** 一条已完成任务上的一次续聊回合：开了回合，盘上可选落一份 codex 诊断。 */
  const scene = async (o: { agentType?: string; diagnostics?: Record<string, unknown> } = {}) => {
    const taskId = `t${++n}`;
    const sessId = `${taskId}-s`;
    const agentType = o.agentType ?? "codex";
    await createTasks([{
      id: taskId, projectId: "p", title: taskId, body: "test", mode: "single", status: "done",
      agentType, executorId: null, autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.insert(sessions).values({
      id: sessId, taskId, role: "single", agentType, executor: agentType, cwd: repo,
      startedAt: at, turnStartedAt: at, endedAt: end, exitStatus: 1, activeMs: 0,
    } as typeof sessions.$inferInsert);
    await openTurn({ sessionId: sessId, taskId, cwd: repo, startedAt: at });
    mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
    if (o.diagnostics) {
      writeFileSync(runTracePaths(join(RUNS_DIR, taskId), sessId, at).diagnosticsPath, JSON.stringify({ version: 1, ...o.diagnostics }));
    }
    const close = (outcome: "failed" | "stopped" | "completed", interruption: ReturnType<typeof turnInterruptionOf> | null) =>
      recordTurnSpan({ sessionId: sessId, taskId, cwd: repo, startedAt: at, endedAt: end, outcome, interruption });
    const session = async () => (await sessionsForTask(taskId)).find((row) => row.id === sessId)!;
    return { taskId, sessId, close, session };
  };

  // ── 1. 上游 503（codex 诊断文件） ───────────────────────────────────────────
  {
    const s = await scene({ diagnostics: { failureKind: "nonzero_exit", failureReason: UPSTREAM_503, exitSignal: null } });
    const interruption = turnInterruptionOf(s.taskId, s.sessId, at, { exitStatus: 1, verdict: null, lastError: null });
    await s.close("failed", interruption);
    const got = (await s.session()).turnInterruption;
    assert.equal(got?.reason, "模型上游连不上（503）", "页面上那半句是上游那一类，带状态码");
    assert.match(got!.detail, /执行器的原话：「unexpected status 503 Service Unavailable: auth_unavailable: no auth available」/,
      "点开看的经过带执行器原话，截到错误页之前");
    assert.doesNotMatch(got!.detail, /<html|Error reference/, "网关错误页不贴进来");
    assert.equal((await s.session()).turnOutcome, "failed", "结局那一位照旧，形状没动");
  }

  // ── 2. 没有诊断文件，只有退出码 ───────────────────────────────────────────
  {
    const s = await scene({ agentType: "claude" });
    await s.close("failed", turnInterruptionOf(s.taskId, s.sessId, at, { exitStatus: 2, verdict: null, lastError: null }));
    assert.deepEqual((await s.session()).turnInterruption, { reason: "执行器异常退出（exit 2）", detail: "执行器异常退出（exit 2）" });
    // 回合里报过的执行故障（claude 的 API Error）照样认得出上游。
    const claude = await scene({ agentType: "claude" });
    await claude.close("failed", turnInterruptionOf(claude.taskId, claude.sessId, at,
      { exitStatus: 1, verdict: null, lastError: "API Error: 529 {\"type\":\"overloaded_error\"}" }));
    assert.equal((await claude.session()).turnInterruption?.reason, "模型上游连不上（529）");
    // 看门狗判「后台跑完了却没开始整理」：说那件事，不冒充执行故障。
    const wrapup = await scene({ agentType: "claude" });
    await wrapup.close("failed", turnInterruptionOf(wrapup.taskId, wrapup.sessId, at,
      { exitStatus: 0, verdict: { kind: "wrapup_missing", reason: "后台都跑完了" }, lastError: null }));
    assert.equal((await wrapup.session()).turnInterruption?.reason, "后台工作跑完了，智能体没开始整理结果");
  }

  // ── 3. 停止的、正常结束的、老记录：没有原因 ─────────────────────────────────
  {
    const fake = { reason: "不该出现", detail: "不该出现" };
    const stopped = await scene();
    await stopped.close("stopped", fake);
    assert.equal((await stopped.session()).turnInterruption, null, "手动停止的回合不给原因");
    const completed = await scene();
    await completed.close("completed", fake);
    assert.equal((await completed.session()).turnInterruption, null, "正常结束的回合不给原因");
    const legacy = await scene();
    await legacy.close("failed", null);
    const old = await legacy.session();
    assert.equal(old.turnOutcome, "failed");
    assert.equal(old.turnInterruption, null, "老记录（那一列为空）：没有原因，结局照旧是失败");
    // 那一格被写坏了：当没有，不把整条会话读挂。
    await dbClient.execute({ sql: "UPDATE session_turns SET interruption = '{oops' WHERE session_id = :sid", args: { sid: legacy.sessId } });
    assert.equal((await legacy.session()).turnInterruption, null);
  }

  // ── 4. 收过口的不改写 ─────────────────────────────────────────────────────
  {
    const s = await scene({ agentType: "claude" });
    await s.close("failed", { reason: "执行器异常退出（exit 1）", detail: "执行器异常退出（exit 1）" });
    await s.close("failed", { reason: "后来的", detail: "后来的" });
    assert.equal((await s.session()).turnInterruption?.reason, "执行器异常退出（exit 1）", "认第一次收口");
  }

  // ── 5. 接线 ───────────────────────────────────────────────────────────────
  {
    const run = readFileSync(new URL("../src/single-run.ts", import.meta.url), "utf8");
    assert.match(run, /const interruption = failure && turnOutcome === "failed" \? turnInterruptionOf\(taskId, sessId, a\.turnStart, failure\) : null;/,
      "只在这一回合自己的结局是 failed 时判（停止、引导都不判）");
    assert.match(run, /recordTurnSpan\(\{[^}]*outcome: turnOutcome,\s*interruption,\s*\}\)/, "跟结局一起落在回合上");
    assert.match(run, /const done = \{ \.\.\.doneEvent, turnOutcome, \.\.\.\(interruption \? \{ interruption \} : \{\}\) \};/,
      "同一份跟着结尾事件播出去（直播那一路）");
  }

  console.log("✅ 普通回合怎么断的：上游带状态码与原话、只有退出码按退出码说、停止/正常/老记录不给、跟着回合与 done 走");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
