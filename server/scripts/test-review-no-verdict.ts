// 一轮审查没给出结论时，ash 说的那句话和写进轮次的那份原因（review-channel-gap.ts 的
// noteReviewerChannelGap + review-no-verdict.ts）。
//
// 现场（2026-11-13，任务 EhQtqns9fnG2 第 1 轮）：codex 审查者产出过正文和工具之后，模型上游开始回
// 503，重连 5 次放弃、exit 1，report.md 没写。ash 说的却是「报告可能已经写完了，只是结论没能上报，
// 最可能是手上没有 report_stage（自查：codex mcp list --json…）」—— 三处全错。
//
// 覆盖：
//   0. 执行器归一层：只有认得出来源的模型 API 失败才挂类型（codex 回合错误、claude 的 result 带
//      api_error_status），400 超长 / 请求无效 / 认证 / 限流 / 暂时不可用各归各类；进程 stderr 不挂
//   1. 回合中途断了（非零退出、模型 API 503）：说上游与状态码、说报告没写、不提 report_stage
//      和 MCP 自查；结构化原因是 interrupted；原话里网关错误页的 504 不被当成状态码。对话超长
//      不说「等上游恢复」；来源不明的报错里带个 403 也不说成模型认证（第 1 轮审查第 1 条）
//   2. 回合正常收尾却没上报：报告在 → 通道那套说法并说写完了；报告不在、是目录、是链接 → 不说
//      写完（跟页面读报告同一个入口，第 1 轮审查 N1）
//   3. 被停掉的、没产出过正文的：不说话，并把那一列清掉
//   4. 状态接口只在这一轮仍是「error 且没结论」时带出 noVerdict；合并结果审查的尾注带 source=merge
//   5. 单飞收尾把「这一回合自己异常结束」的事实交进来（接线）
//
// 跑：npm -w server run test:review-no-verdict
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
  const { interruptionOf } = await import("../src/review-no-verdict.js");
  const { codexErrorEvent } = await import("../src/executors/codex-error-event.js");
  const { codexTurnError, modelFailureOf } = await import("../src/executors/model-failure.js");
  const { parseClaudeStream } = await import("../src/executors/claude.js");
  const { freeWorkflowState } = await import("../src/free-workflow-state.js");

  const at = "2026-11-13T11:15:00.155Z";
  const repo = join(stage, "repo");
  mkdirSync(repo, { recursive: true });
  await db.insert(projects).values({ id: "p", name: "p", repoPath: repo, createdAt: at, updatedAt: at });

  let n = 0;
  /** 造一轮落了 error、没结论的审查，外加审查者那一回合留在盘上的东西。 */
  const scene = async (o: {
    work?: boolean;
    report?: boolean | "dir" | "link";
    target?: "accepted_merge";
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
      ...(o.target ? { targetKind: o.target, targetBranch: "main", targetBaseCommit: "b0", targetCommit: "m1" } : {}),
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
      if (o.report === "dir") mkdirSync(path);
      else if (o.report === "link") {
        const outside = join(stage, `${taskId}-outside.md`);
        writeFileSync(outside, "# 证据目录外的一份\n");
        symlinkSync(outside, path);
      } else writeFileSync(path, "# 第 1 轮审查\n\n结论：通过。\n");
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

  // ── 0. 执行器归一层 ─────────────────────────────────────────────────────
  {
    assert.deepEqual(codexErrorEvent({ error: { message: UPSTREAM_503 } })?.event.model, { kind: "unavailable", status: 503 },
      "codex 重试完了还是错：按 codex 自己写状态码的位置取 503，不取错误页里的 504");
    const retrying = codexErrorEvent({ willRetry: true, error: { message: UPSTREAM_503 } })!;
    assert.equal(retrying.counted, false, "重试中的不算执行故障");
    assert.deepEqual(retrying.event, { kind: "error", message: UPSTREAM_503, level: "notice", affectsTurn: false, model: { kind: "unavailable", status: 503 } },
      "重试提示也挂类型：看门狗熔断时据它说状态码（第 2 轮审查 N1）");
    assert.deepEqual(codexTurnError("exceeded retry limit, last status: 429 Too Many Requests").model, { kind: "rate_limit", status: 429 });
    assert.deepEqual(codexTurnError("stream disconnected before completion: error sending request").model, { kind: "unavailable", status: null });
    assert.deepEqual(codexTurnError("Codex ran out of room in the model's context window.").model, { kind: "context_overflow", status: null });
    assert.equal(codexTurnError("Codex 当前回合被意外中断").model, undefined, "认不出来就不挂");
    assert.deepEqual(modelFailureOf("prompt is too long: 210000 tokens > 200000 maximum", 400), { kind: "context_overflow", status: 400 });
    assert.deepEqual(modelFailureOf("invalid_request_error: tools.0.name is invalid", 400), { kind: "invalid_request", status: 400 });
    assert.deepEqual(modelFailureOf("invalid x-api-key", 401), { kind: "auth", status: 401 });
    // 额度 / 余额用完了：要用户去处理，不归到「等一会儿就好」的限流（第 2 轮审查第 1 条）。
    const quota = "You exceeded your current quota, please check your plan and billing details. (insufficient_quota)";
    assert.deepEqual(modelFailureOf(quota, 429), { kind: "quota_exhausted", status: 429 }, "429 insufficient_quota 是额度，不是限流");
    assert.deepEqual(codexTurnError(`exceeded retry limit, last status: 429 Too Many Requests: ${quota}`).model, { kind: "quota_exhausted", status: 429 });
    assert.deepEqual(modelFailureOf("payment required", 402), { kind: "quota_exhausted", status: 402 });
    assert.deepEqual(modelFailureOf("Your credit balance is too low to access the Anthropic API.", 400), { kind: "quota_exhausted", status: 400 });
    assert.deepEqual(modelFailureOf("RESOURCE_EXHAUSTED: Quota exceeded for quota metric", null), { kind: "quota_exhausted", status: null });
    assert.deepEqual(modelFailureOf("You've hit your usage limit. Upgrade to Pro or try again later.", null), { kind: "quota_exhausted", status: null });
    assert.deepEqual(modelFailureOf("Rate limit reached for requests per min. Please try again in 20s.", 429), { kind: "rate_limit", status: 429 }, "纯限流仍是限流");
    assert.deepEqual(modelFailureOf("rate_limit_error: too many requests", null), { kind: "rate_limit", status: null });

    // claude：真解析器，result 带 api_error_status 的才挂；进程 stderr 里的 403（本机 MCP 回的）不挂。
    const stub = join(stage, "claude-stub.mjs");
    const claudeErrors = async (lines: unknown[], stderr = "", code = 0) => {
      writeFileSync(stub, lines.map((line) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(line)}\n`)});`).join("\n")
        + `\nprocess.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};`);
      const child = spawn(process.execPath, [stub], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin?.end();
      const events: { kind: string; model?: unknown; message?: string }[] = [];
      for await (const event of parseClaudeStream(child as never)) events.push(event as never);
      return events.filter((event) => event.kind === "error");
    };
    const overflow = await claudeErrors([{ type: "system", session_id: "c1" },
      { type: "result", subtype: "success", is_error: true, api_error_status: 400, session_id: "c1", result: "Prompt is too long" }]);
    assert.deepEqual(overflow[0]?.model, { kind: "context_overflow", status: 400 }, "claude 超长：带来源与类型");
    const overloaded = await claudeErrors([{ type: "system", session_id: "c2" },
      { type: "result", subtype: "success", is_error: true, session_id: "c2", result: "API Error: 529 {\"type\":\"overloaded_error\"}" }]);
    assert.deepEqual(overloaded[0]?.model, { kind: "unavailable", status: 529 }, "claude CLI 写成 API Error: N 的也认");
    const mcp = await claudeErrors([{ type: "system", session_id: "c3" }], "MCP server \"linear\" failed: HTTP 403 Forbidden", 1);
    assert.ok(mcp.length && mcp.every((event) => event.model === undefined), "进程 stderr 来源不明，不挂模型类型");
    const claudeRetry = await claudeErrors([{ type: "system", session_id: "c4" },
      { type: "system", subtype: "api_retry", session_id: "c4", attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 529, error: "overloaded_error" }]);
    assert.deepEqual(claudeRetry[0]?.model, { kind: "unavailable", status: 529 }, "claude 的重试提示也挂类型（第 2 轮审查 N1）");
  }

  // ── 1. 回合中途断了 ─────────────────────────────────────────────────────────
  {
    const s = await scene({ diagnostics: { failureKind: "nonzero_exit", failureReason: UPSTREAM_503, exitSignal: null } });
    const said = await s.note({ failure: { exitStatus: 1, verdict: null, error: codexErrorEvent({ error: { message: UPSTREAM_503 } })!.event } });
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
    assert.match(text, /"source":"free"/, "工作区审查的尾注带 source=free");
    assert.deepEqual(await s.cause(), { kind: "interrupted", reason: "模型上游连不上（503）" }, "写进轮次的原因是「回合中断」那一类");

    // 对话超出长度上限：原样续还会撞上，不叫人等上游（第 1 轮审查第 1 条）。
    const overflow = await scene();
    await overflow.note({ failure: { exitStatus: 0, verdict: null,
      error: { message: "HTTP 400: prompt is too long: 210000 tokens > 200000 maximum", model: { kind: "context_overflow", status: 400 } } } });
    assert.deepEqual(await overflow.cause(), { kind: "interrupted", reason: "对话超出模型长度上限" });
    assert.doesNotMatch(overflow.timeline(), /上游连不上|等上游恢复/, "超长不是上游的事");
    assert.match(overflow.timeline(), /原样「继续本轮审查」还会撞上同一个上限/, "下一步说清原样续不行");
    const invalid = await scene();
    await invalid.note({ failure: { exitStatus: 1, verdict: null, error: { message: "HTTP 400: bad tool schema", model: { kind: "invalid_request", status: 400 } } } });
    assert.deepEqual(await invalid.cause(), { kind: "interrupted", reason: "模型拒收了这次请求（400）" });
    const auth = await scene();
    await auth.note({ failure: { exitStatus: 1, verdict: null, error: { message: "HTTP 401: invalid x-api-key", model: { kind: "auth", status: 401 } } } });
    assert.deepEqual(await auth.cause(), { kind: "interrupted", reason: "模型认证失败（401）" });
    assert.match(auth.timeline(), /先把这个执行器的模型凭据修好/);
    const quota = await scene();
    await quota.note({ failure: { exitStatus: 1, verdict: null, error: codexTurnError(`exceeded retry limit, last status: 429 Too Many Requests: You exceeded your current quota (insufficient_quota)`) } });
    assert.deepEqual(await quota.cause(), { kind: "interrupted", reason: "模型账户额度用完了（429）" });
    assert.doesNotMatch(quota.timeline(), /限流|等上游恢复|等.{0,4}过去/, "额度用完了不叫人等");
    assert.match(quota.timeline(), /等下去不会自己好：先去看这个执行器的模型账户/);
    // 来源不明的报错（MCP、进程 stderr）里带个状态码：不归到模型，照实说执行器异常退出。
    const unknown = await scene();
    await unknown.note({ failure: { exitStatus: 1, verdict: null, error: { message: "MCP server \"linear\" failed: HTTP 403 Forbidden" } } });
    assert.deepEqual(await unknown.cause(), { kind: "interrupted", reason: "执行器异常退出（exit 1）" });
    assert.doesNotMatch(unknown.timeline(), /上游|认证/, "不替来源不明的报错归因");
    // 看门狗熔断：整段只收到上游的重试类错误，没有状态码也是连不上。
    const tripped = await scene();
    await tripped.note({ failure: { exitStatus: 0, verdict: { kind: "tripped", reason: "15 分钟里只收到重试类错误" }, error: null } });
    assert.deepEqual(await tripped.cause(), { kind: "interrupted", reason: "模型上游连不上" });
    // 熔断前那几次重试带了状态码：按它说（第 2 轮审查 N1）；重试撞的是额度，就说额度。
    const trippedCode = await scene();
    await trippedCode.note({ failure: { exitStatus: 0, verdict: { kind: "tripped", reason: "15 分钟里只收到重试类错误" }, error: null,
      retrying: codexErrorEvent({ willRetry: true, error: { message: UPSTREAM_503 } })!.event.model } });
    assert.deepEqual(await trippedCode.cause(), { kind: "interrupted", reason: "模型上游连不上（503）" });
    assert.equal(interruptionOf({ exitStatus: 0, verdict: { kind: "tripped", reason: "" }, error: null, retrying: { kind: "quota_exhausted", status: 429 } }, null).reason,
      "模型账户额度用完了（429）");
    // 不是上游的崩溃：按退出码说，不冒充上游。
    const crash = await scene();
    await crash.note({ failure: { exitStatus: 137, verdict: null, error: null } });
    assert.deepEqual(await crash.cause(), { kind: "interrupted", reason: "执行器异常退出（exit 137）" });
    assert.doesNotMatch(crash.timeline(), /等上游恢复/, "不是上游的就别叫人等上游");
    assert.equal(interruptionOf({ exitStatus: 1, verdict: null, error: null }, { failureReason: null, exitSignal: "SIGKILL" }).reason,
      "执行器进程被 SIGKILL 结束");
    // 合并结果审查：尾注里那一轮叫「合并结果审查」（第 1 轮审查 N2）。
    const merge = await scene({ target: "accepted_merge" });
    await merge.note({ failure: { exitStatus: 1, verdict: null, error: codexErrorEvent({ error: { message: UPSTREAM_503 } })!.event } });
    assert.match(merge.timeline(), /"source":"merge"/);
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

    // 页面读不出来的报告（目录、指到证据目录外的链接）不算写了：两边同一个入口。
    for (const shape of ["dir", "link"] as const) {
      const odd = await scene({ report: shape });
      assert.equal(await odd.note(), true);
      assert.doesNotMatch(odd.timeline(), /写完|写得完整|写好了/, `报告是${shape}：不说写完`);
      assert.deepEqual(await odd.cause(), { kind: "unreported", reason: "回合收尾了，结论没报上来" });
    }
  }

  // ── 3. 被停、没产出过：不说话，清掉那一列 ───────────────────────────────────
  {
    const stopped = await scene();
    await db.update(freeReviewRounds).set({ noVerdict: { kind: "interrupted", reason: "旧的" } }).where(eq(freeReviewRounds.runId, stopped.runId));
    assert.equal(await stopped.note({ stopped: true, failure: { exitStatus: 1, verdict: null, error: { message: UPSTREAM_503 } } }), false);
    assert.equal(stopped.timeline(), "", "被停的不说话");
    assert.equal(await stopped.cause(), null, "上一回合的原因不再挂在这一轮上");

    const idle = await scene({ work: false });
    assert.equal(await idle.note({ failure: { exitStatus: 1, verdict: null, error: { message: UPSTREAM_503 } } }), false);
    assert.equal(idle.timeline(), "", "没产出过正文的不说话");
    assert.equal(await idle.cause(), null);

    const concluded = await scene({ status: "done", conclusion: "verified" });
    assert.equal(await concluded.note({ failure: { exitStatus: 1, verdict: null, error: { message: UPSTREAM_503 } } }), false, "出了结论的轮次不归这里");
  }

  // ── 4. 状态接口 ──────────────────────────────────────────────────────────
  {
    const s = await scene();
    await s.note({ failure: { exitStatus: 1, verdict: null, error: codexErrorEvent({ error: { message: UPSTREAM_503 } })!.event } });
    const round = (await freeWorkflowState(s.taskId)).reviews[0]!.rounds[0]!;
    assert.deepEqual(round.noVerdict, { kind: "interrupted", reason: "模型上游连不上（503）" }, "error 且没结论：带出原因");
    // 续过之后这一轮出了结论：旧原因不再作数，哪怕那一列还没被下一回合改写。
    await db.update(freeReviewRounds).set({ status: "done", conclusion: "verified" }).where(eq(freeReviewRounds.runId, s.runId));
    assert.equal((await freeWorkflowState(s.taskId)).reviews[0]!.rounds[0]!.noVerdict, undefined);
  }

  // ── 5. 接线 ───────────────────────────────────────────────────────────────
  {
    const run = readFileSync(new URL("../src/single-run.ts", import.meta.url), "utf8");
    assert.match(run, /const failure = executionFailed\s*\? \{ exitStatus, verdict: watchdogFailure, error: lastExecutionError, retrying: lastRetryModel \}\s*: null;/,
      "单飞收尾按「这一回合自己异常结束」交事实：退出码、看门狗判决、那条执行故障、重试提示撞的类型");
    assert.match(run, /if \(emittedEvent\.kind === "error" && emittedEvent\.model && isExecutionNotice\(emittedEvent\)\) lastRetryModel = emittedEvent\.model;/,
      "重试提示上的类型记下来");
    assert.match(run, /noteReviewerChannelGap\(\{[^}]*failure \}\)/, "交进说明里");
    assert.match(run, /sawExecutionError = true; if \(!lastExecutionError\?\.model \|\| emittedEvent\.model\) lastExecutionError = emittedEvent;/,
      "带模型类型的那条不被后面的执行诊断汇总盖掉");
  }

  console.log("✅ 审查没结论：中途断了说怎么断的、没上报才说通道、报告写没写看文件、原因按结构进轮次");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
