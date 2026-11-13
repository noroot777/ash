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
//   5. 看门狗熔断的原因取自熔断判据的同一批事件：穿过子智能体包装、只认最后那条、恢复过就不沿用
//      （第 3 轮审查第 1 条）；判决没类型时不说成「上游连不上」
//   6. 单飞收尾把「这一回合自己异常结束」的事实交进来（接线）
//   7. 那份记录上线之前断掉、没存过原因的轮次：状态接口按盘上的事实现算（诊断文件、原始事件、会话
//      与回合行、报告在不在）；原话进结构，类型只认执行器归一层重放出来的；什么都读不到就不带
//
// 跑：npm -w server run test:review-no-verdict
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
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
  const { freeReviewRounds, freeReviewRuns, projects, sessions, sessionTurns } = await import("../src/db/schema.js");
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
    const stored = async () => (await db.select().from(freeReviewRounds).where(eq(freeReviewRounds.runId, runId)))[0]!.noVerdict;
    // 类别和那半句（原话另有断言）。
    const cause = async () => {
      const value = await stored();
      return value ? { kind: value.kind, reason: value.reason } : value;
    };
    const api = async () => (await freeWorkflowState(taskId)).reviews[0]!.rounds[0]!.noVerdict;
    const note = (extra: Partial<Parameters<typeof noteReviewerChannelGap>[0]> = {}) => noteReviewerChannelGap({
      taskId, sessId, turnStart: at, agentType: "codex", stopped: false, review: { run: runId, round: 1 }, failure: null, ...extra,
    });
    return { taskId, runId, sessId, timeline, cause, stored, api, note };
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
    assert.deepEqual(await s.stored(), { kind: "interrupted", reason: "模型上游连不上（503）",
      said: "unexpected status 503 Service Unavailable: auth_unavailable: no auth available" }, "原话跟着进结构，类型明确就不标笼统");

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
    assert.deepEqual(await unknown.stored(), { kind: "interrupted", reason: "执行器异常退出（exit 1）",
      said: "MCP server \"linear\" failed: HTTP 403 Forbidden", vague: true }, "只说得出退出码：标笼统，原话就是要看的");
    assert.doesNotMatch(unknown.timeline(), /上游|认证/, "不替来源不明的报错归因");
    // 看门狗熔断、判决没带类型：不知道卡在什么上，就不说成「上游连不上、等等就好」（第 3 轮审查第 1 条）。
    const tripped = await scene();
    await tripped.note({ failure: { exitStatus: 0, verdict: { kind: "tripped", reason: "15 分钟里只收到重试类错误" }, error: null } });
    assert.deepEqual(await tripped.cause(), { kind: "interrupted", reason: "回合长时间没有进展，被自动终止" });
    assert.doesNotMatch(tripped.timeline(), /上游连不上|等上游恢复|限流/, "类型缺了不替它编一个会自己恢复的原因");
    assert.match(tripped.timeline(), /先看上面的原话弄清卡在哪里/);
    // 判决带了类型（看门狗按熔断的同一批错误取的）：按它说，带状态码（第 2 轮审查 N1）。
    const trippedCode = await scene();
    await trippedCode.note({ failure: { exitStatus: 0, error: null,
      verdict: { kind: "tripped", reason: "15 分钟里只收到重试类错误", model: codexErrorEvent({ willRetry: true, error: { message: UPSTREAM_503 } })!.event.model } } });
    assert.deepEqual(await trippedCode.cause(), { kind: "interrupted", reason: "模型上游连不上（503）" });
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
    assert.deepEqual(round.noVerdict, { kind: "interrupted", reason: "模型上游连不上（503）",
      said: "unexpected status 503 Service Unavailable: auth_unavailable: no auth available" }, "error 且没结论：带出原因和原话");
    // 续过之后这一轮出了结论：旧原因不再作数，哪怕那一列还没被下一回合改写。
    await db.update(freeReviewRounds).set({ status: "done", conclusion: "verified" }).where(eq(freeReviewRounds.runId, s.runId));
    assert.equal((await freeWorkflowState(s.taskId)).reviews[0]!.rounds[0]!.noVerdict, undefined);
  }

  // ── 5. 熔断的原因与熔断判据是同一批事件（第 3 轮审查第 1 条）──────────────────
  // 看门狗穿过子智能体包装计错误、据此熔断；原因也必须从这同一批里取 —— 另收一份「重试类型」的
  // 那一版只看顶层，子线程一直报额度用完、父回合被熔断，页面却说「上游连不上，等恢复」。
  {
    const { ClaudeChildActivity, CodexChildActivity } = await import("../src/executors/native-agent-activity.js");
    const { trackTurnStall, __resetTurnStalls } = await import("../src/turn-stall.js");
    const { stallFailure, __resetStallFailures } = await import("../src/turn-stall-verdict.js");
    process.env.ASH_STALL_WARN_ERRORS = "0";
    process.env.ASH_STALL_WARN_MS = "0";
    process.env.ASH_STALL_TRIP_MS = "30";
    process.env.ASH_STALL_TRIP_GRACE_MS = "0";
    const TURN = "2026-11-13T12:00:00.000Z";
    const actions = { taskId: "t-stall", warn() {}, trip() {}, resolve() {}, project: async () => true };
    /** 按顺序喂进看门狗；`gap` 之前停一下，让停滞时长越过熔断阈值。 */
    const feed = async (sessionId: string, batches: AgentEvent[][]) => {
      const owner = {};
      for (const [i, batch] of batches.entries()) {
        if (i) await new Promise((resolve) => setTimeout(resolve, 60));
        for (const event of batch) trackTurnStall(sessionId, owner, TURN, event, actions);
      }
      return stallFailure(sessionId, TURN);
    };
    const tripReason = (verdict: ReturnType<typeof stallFailure>) =>
      interruptionOf({ exitStatus: 0, verdict, error: null }, null).reason;
    const QUOTA = "You exceeded your current quota, please check your plan and billing details (insufficient_quota)";

    // claude 子线程的重试：带上类型（与主线程同一份归一），熔断判决随之带上。
    const claudeChild = new ClaudeChildActivity();
    const claudeRetry = () => claudeChild.message({ type: "system", subtype: "api_retry", parent_tool_use_id: "tu-1",
      attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: QUOTA });
    assert.deepEqual((claudeRetry()[0] as { nativeWork?: { event?: { model?: unknown } } }).nativeWork?.event?.model,
      { kind: "quota_exhausted", status: 429 }, "claude 子线程的重试提示挂类型");
    const claudeVerdict = await feed("s-claude-child", [claudeRetry(), claudeRetry()]);
    assert.equal(claudeVerdict?.kind, "tripped", "子线程一直重试，父回合被熔断");
    assert.deepEqual(claudeVerdict?.model, { kind: "quota_exhausted", status: 429 }, "判决带着卡住它的那条错误的类型");
    assert.equal(tripReason(claudeVerdict), "模型账户额度用完了（429）");

    // codex 子线程：重试中的与子线程回合终局错误都走同一份归一。
    const codexChild = new CodexChildActivity();
    const codexRetry = () => codexChild.notification("error",
      { threadId: "th-1", willRetry: true, error: { message: `unexpected status 429 Too Many Requests: ${QUOTA}` } });
    const codexVerdict = await feed("s-codex-child", [codexRetry(), codexRetry()]);
    assert.deepEqual(codexVerdict?.model, { kind: "quota_exhausted", status: 429 });
    assert.equal(tripReason(codexVerdict), "模型账户额度用完了（429）");
    const childEnd = codexChild.notification("turn/completed", { threadId: "th-1", turn: { error: { message: "unexpected status 503 Service Unavailable" } } });
    assert.deepEqual((childEnd[0] as { nativeWork?: { event?: { model?: unknown } } }).nativeWork?.event?.model, { kind: "unavailable", status: 503 });

    // 恢复过之后再卡住：旧那次的类型不带到新一次里；同一次里最后那条没类型，也不沿用前面的。
    const typed: AgentEvent = { kind: "error", message: "上游返回 503", level: "notice", affectsTurn: false, model: { kind: "unavailable", status: 503 } };
    const untyped: AgentEvent = { kind: "error", message: "上游没有响应，正在重试", level: "notice", affectsTurn: false };
    const recovered = await feed("s-recovered", [[typed], [{ kind: "text", text: "接着干" }, untyped], [untyped]]);
    assert.equal(recovered?.kind, "tripped");
    assert.equal(recovered?.model ?? null, null, "恢复前那次的类型不算这次的原因");
    assert.equal(tripReason(recovered), "回合长时间没有进展，被自动终止");
    const lastUntyped = await feed("s-last-untyped", [[typed], [untyped]]);
    assert.equal(lastUntyped?.model ?? null, null, "卡住它的是最后那条");

    // 判决跨重启：类型跟着落盘，装回来还在；旧记录没有、坏的不认。
    const { readStallJournal, pendingStallVerdicts } = await import("../src/turn-stall-journal.js");
    const { loadStallFailures } = await import("../src/turn-stall-verdict.js");
    const journaled = pendingStallVerdicts(readStallJournal()).find((record) => record.sessionId === "s-claude-child");
    assert.deepEqual(journaled?.model, { kind: "quota_exhausted", status: 429 }, "落盘的判决带着类型");
    __resetStallFailures();
    loadStallFailures([journaled!, { ...journaled!, sessionId: "s-old", model: undefined }, { ...journaled!, sessionId: "s-bad", model: "429" as never }]);
    assert.equal(tripReason(stallFailure("s-claude-child", TURN)), "模型账户额度用完了（429）", "重启装回来照样说额度");
    assert.equal(stallFailure("s-old", TURN)?.model, null);
    assert.equal(stallFailure("s-bad", TURN)?.model, null);
    __resetTurnStalls();
    __resetStallFailures();
  }

  // ── 6. 接线 ───────────────────────────────────────────────────────────────
  {
    const run = readFileSync(new URL("../src/single-run.ts", import.meta.url), "utf8");
    assert.match(run, /const failure = executionFailed \? \{ exitStatus, verdict: watchdogFailure, error: lastExecutionError \} : null;/,
      "单飞收尾按「这一回合自己异常结束」交事实：退出码、看门狗判决（带熔断那条错误的类型）、那条执行故障");
    assert.doesNotMatch(run, /lastRetryModel/, "熔断原因不另收一份：只认看门狗判决里的");
    assert.match(run, /noteReviewerChannelGap\(\{[^}]*failure \}\)/, "交进说明里");
    assert.match(run, /sawExecutionError = true; if \(!lastExecutionError\?\.model \|\| emittedEvent\.model\) lastExecutionError = emittedEvent;/,
      "带模型类型的那条不被后面的执行诊断汇总盖掉");
  }

  // ── 7. 没存过原因的老轮次：按盘上的事实现算 ────────────────────────────────────
  {
    const end = "2026-11-13T11:17:45.288Z";
    // EhQtqns9fnG2 那份诊断文件的形状：非零退出、原话是 codex 的 503 加一段网关错误页。
    const LIVE_DIAGNOSTICS = {
      recordedAt: end, terminationKind: "nonzero_exit", failureKind: "nonzero_exit", failureReason: UPSTREAM_503,
      sessionPoisonedReason: null, exitStatus: 1, exitSignal: null, stopRequested: false, turnCompleted: true, turnFailed: false,
      agentMessageCount: 2, lastEventType: "thread/archived", lastEventSummary: null, stderrTail: "", structuredErrors: [UPSTREAM_503],
      traceWriteError: null, eventsPath: null, stderrPath: null,
    };
    /** 审查者那一回合在库里的样子：回合行的结局、会话行的退出码。 */
    const settle = async (s: Awaited<ReturnType<typeof scene>>, outcome: string | null, exitStatus: number | null, stoppedAs: string | null = null) => {
      await db.update(sessions).set({ endedAt: end, exitStatus, stoppedAs }).where(eq(sessions.id, s.sessId));
      if (outcome) {
        await db.insert(sessionTurns).values({ id: `${s.sessId}-turn`, sessionId: s.sessId, taskId: s.taskId, startedAt: at, endedAt: end, outcome } as typeof sessionTurns.$inferInsert);
      }
    };
    const EXPECTED_SAID = "unexpected status 503 Service Unavailable: auth_unavailable: no auth available";

    // 只有诊断文件：说不出类型，照实说退出码，原话摆出来（不从原文里找 503）。
    const legacy = await scene({ diagnostics: LIVE_DIAGNOSTICS });
    await settle(legacy, "failed", 1);
    assert.equal(await legacy.stored(), null, "库里那一列没有，也不去补写");
    const derived = await legacy.api();
    assert.deepEqual(derived, { kind: "interrupted", reason: "执行器异常退出（exit 1）", said: EXPECTED_SAID, vague: true },
      "没存过原因的 error 轮次：带出「回合中断」那一类和执行器原话");
    assert.match(derived!.said!, /503/);
    assert.match(derived!.said!, /auth_unavailable/);
    assert.equal(await legacy.stored(), null, "现算，不写库");

    // 原始事件还在：按 codex 执行器当时的同一套归一重放，类型跟新代码当场判的一样。
    const replay = await scene({ diagnostics: LIVE_DIAGNOSTICS });
    await settle(replay, "failed", 1);
    const events = [
      { method: "error", params: { willRetry: true, error: { message: "Reconnecting... 5/5", additionalDetails: UPSTREAM_503 } } },
      { method: "error", params: { willRetry: false, error: { message: UPSTREAM_503 } } },
      { method: "turn/completed", params: { turn: { status: "failed", error: { message: UPSTREAM_503 } } } },
      "坏了的一行",
      { method: "thread/archived", params: {} },
    ].map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n");
    writeFileSync(runTracePaths(join(RUNS_DIR, replay.taskId), replay.sessId, at).eventsPath, `${events}\n`);
    assert.deepEqual(await replay.api(), { kind: "interrupted", reason: "模型上游连不上（503）", said: EXPECTED_SAID },
      "重放执行器归一层：跟新断的轮次同一句");

    // 盘上什么都没有（会话行没退出码、没有回合行、没有诊断）：不带，跟原来一样。
    const bare = await scene();
    assert.equal(await bare.api(), undefined, "什么都读不到：不带");
    // 被停的：不替它编原因。
    const stopped = await scene({ diagnostics: LIVE_DIAGNOSTICS });
    await settle(stopped, "stopped", 143, "canceled");
    assert.equal(await stopped.api(), undefined, "你停的那一回合不补原因");
    // 正常收尾却没上报的老轮次：同那一类（报告在不在看文件）。
    const quiet = await scene({ report: true });
    await settle(quiet, "completed", 0);
    assert.deepEqual(await quiet.api(), { kind: "unreported", reason: "报告写完了，结论没报上来" });

    // 上一版写进库的（没有原话）：类别和那半句照库里的，原话从盘上补上。
    const older = await scene({ diagnostics: LIVE_DIAGNOSTICS });
    await settle(older, "failed", 1);
    await db.update(freeReviewRounds).set({ noVerdict: { kind: "interrupted", reason: "模型上游连不上（503）" } }).where(eq(freeReviewRounds.runId, older.runId));
    assert.deepEqual(await older.api(), { kind: "interrupted", reason: "模型上游连不上（503）", said: EXPECTED_SAID });
    // 存过的「没上报」那一类原样给（第 2 节那几种不受影响）。
    const unreported = await scene({ diagnostics: LIVE_DIAGNOSTICS });
    await settle(unreported, "failed", 1);
    await db.update(freeReviewRounds).set({ noVerdict: { kind: "unreported", reason: "回合收尾了，结论没报上来" } }).where(eq(freeReviewRounds.runId, unreported.runId));
    assert.deepEqual(await unreported.api(), { kind: "unreported", reason: "回合收尾了，结论没报上来" });
    // 出了结论的轮次：不现算。
    const concluded = await scene({ diagnostics: LIVE_DIAGNOSTICS, status: "done", conclusion: "verified" });
    await settle(concluded, "failed", 1);
    assert.equal(await concluded.api(), undefined);
  }

  console.log("✅ 审查没结论：中途断了说怎么断的、没上报才说通道、报告写没写看文件、原因按结构进轮次、老轮次按盘上的事实现算");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
