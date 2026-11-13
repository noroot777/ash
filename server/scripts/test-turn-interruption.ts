// 普通回合异常结束以后，给页面的那份「怎么断的」（turn-interruption.ts → session_turns.interruption →
// Session.turnInterruptions；直播那一路跟着 done 事件播出去）。
//
// 现场（2026-11-13）：续聊回合、自由工作流的自动修复回合崩了，任务停在已完成，会话里那句「这一轮
// 异常结束」点开只有「执行异常结束 · exit 1」—— 看不出出了什么错。审查回合早就会说怎么断的
// （review-no-verdict.ts），这里盯普通回合用的是同一套判法、同一份结构，并且跟着回合走。
//
// 覆盖：
//   1. 续聊回合非零退出、执行器归一层报的是模型上游 503：会话行上是「模型上游连不上（503）」，带执行器原话
//   2. 没有模型类型、只有退出码：「执行器异常退出（exit N）」；原话里的 HTTP 数字不冒充模型故障
//      （本机工具的 403、没带类型的 400），归一层报了「对话超长」就照它说（第 1 轮审查第 2 条）
//   3. 被手动停止的、正常结束的：不给原因（就算调用方塞了一份也不落）；老记录（那一列为空）也没有
//   4. 收过口的回合不被改写：后到的收尾不把原因改掉
//   5. 刷新跨过结算：会话行与回合行**同一个原子批**写、同一个原子批读，收口前后读到的都是同一刻的两边，
//      exit 0 却判失败的那一轮也一样；批写失败时会话行那一笔单独补上（第 1、2 轮审查第 1 条）
//   5'. 同一条会话重试成功以后：前一回合的原因按回合还带着（第 2 轮审查第 2 条）
//   6. 诊断文件字段类型坏了：不抛，照退出码说（第 1 轮审查 N1）
//   7. 接线：单飞收尾只在结局是 failed 时判，同一份既落回合、也跟着 done 播出去；单飞、duet、团队调度台
//      三条收尾路的会话行都跟回合收口同批落
//   8. 团队调度台被接管以后：旧台晚到的会话行写入（原批、批失败后的补写、单独的更新）按持有者代次落空，
//      不把新台那一行标成已退出、不抹掉它的恢复凭据；旧台自己的回合照落（第 3 轮审查第 2 条）
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
  const { eq } = await import("drizzle-orm");
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
    /** 这一回合（起点 `at`）的原因：页面按回合认的那一份。 */
    const cause = async () => (await session()).turnInterruptions?.[at] ?? null;
    return { taskId, sessId, close, session, cause };
  };

  // ── 1. 上游 503（执行器归一层带了类型） ─────────────────────────────────────
  {
    const s = await scene({ diagnostics: { failureKind: "nonzero_exit", failureReason: UPSTREAM_503, exitSignal: null } });
    const interruption = turnInterruptionOf(s.taskId, s.sessId, at,
      { exitStatus: 1, verdict: null, error: { message: UPSTREAM_503, model: { kind: "unavailable", status: 503 } } });
    await s.close("failed", interruption);
    const got = await s.cause();
    assert.equal(got?.reason, "模型上游连不上（503）", "页面上那半句是上游那一类，带状态码");
    assert.match(got!.detail, /执行器的原话：「unexpected status 503 Service Unavailable: auth_unavailable: no auth available」/,
      "点开看的经过带执行器原话，截到错误页之前");
    assert.doesNotMatch(got!.detail, /<html|Error reference/, "网关错误页不贴进来");
    assert.equal((await s.session()).turnOutcome, "failed", "结局那一位照旧，形状没动");
  }

  // ── 2. 没有诊断文件，只有退出码 ───────────────────────────────────────────
  {
    const s = await scene({ agentType: "claude" });
    await s.close("failed", turnInterruptionOf(s.taskId, s.sessId, at, { exitStatus: 2, verdict: null, error: null }));
    assert.deepEqual(await s.cause(), { reason: "执行器异常退出（exit 2）", detail: "执行器异常退出（exit 2）" });
    // 原话里有 HTTP 数字、却没带模型类型：来源不明，不归成模型故障。
    for (const message of ["MCP tool failed: HTTP 403 Forbidden from local tool server", "API Error: 400 bad thing"]) {
      const odd = await scene({ agentType: "claude" });
      await odd.close("failed", turnInterruptionOf(odd.taskId, odd.sessId, at, { exitStatus: 1, verdict: null, error: { message, model: undefined } }));
      const got = (await odd.cause())!;
      assert.equal(got.reason, "执行器异常退出（exit 1）", `「${message}」不冒充模型故障`);
      assert.match(got.detail, /执行器的原话/, "原话照样带上");
    }
    // 归一层报的是对话超长：照它说，不说「连不上」。
    const overflow = await scene({ agentType: "claude" });
    await overflow.close("failed", turnInterruptionOf(overflow.taskId, overflow.sessId, at, {
      exitStatus: 1, verdict: null,
      error: { message: "API Error: 400 {\"error\":{\"message\":\"context window exceeded\"}}", model: { kind: "context_overflow", status: 400 } },
    }));
    assert.equal((await overflow.cause())?.reason, "对话超出模型长度上限");
    // 看门狗判「后台跑完了却没开始整理」：说那件事，不冒充执行故障。
    const wrapup = await scene({ agentType: "claude" });
    await wrapup.close("failed", turnInterruptionOf(wrapup.taskId, wrapup.sessId, at,
      { exitStatus: 0, verdict: { kind: "wrapup_missing", reason: "后台都跑完了" }, error: null }));
    assert.equal((await wrapup.cause())?.reason, "后台工作跑完了，智能体没开始整理结果");
  }

  // ── 3. 停止的、正常结束的、老记录：没有原因 ─────────────────────────────────
  {
    const fake = { reason: "不该出现", detail: "不该出现" };
    const stopped = await scene();
    await stopped.close("stopped", fake);
    assert.equal(await stopped.cause(), null, "手动停止的回合不给原因");
    const completed = await scene();
    await completed.close("completed", fake);
    assert.equal(await completed.cause(), null, "正常结束的回合不给原因");
    const legacy = await scene();
    await legacy.close("failed", null);
    const old = await legacy.session();
    assert.equal(old.turnOutcome, "failed");
    assert.deepEqual(old.turnInterruptions, {}, "老记录（那一列为空）：没有原因，结局照旧是失败");
    // 那一格被写坏了：当没有，不把整条会话读挂。
    await dbClient.execute({ sql: "UPDATE session_turns SET interruption = '{oops' WHERE session_id = :sid", args: { sid: legacy.sessId } });
    assert.equal(await legacy.cause(), null);
  }

  // ── 4. 收过口的不改写 ─────────────────────────────────────────────────────
  {
    const s = await scene({ agentType: "claude" });
    await s.close("failed", { reason: "执行器异常退出（exit 1）", detail: "执行器异常退出（exit 1）" });
    await s.close("failed", { reason: "后来的", detail: "后来的" });
    assert.equal((await s.cause())?.reason, "执行器异常退出（exit 1）", "认第一次收口");
  }

  // ── 5. 刷新跨过结算 ───────────────────────────────────────────────────────
  {
    const s = await scene({ agentType: "claude" });
    // 回合还开着：会话行没收尾。
    await db.update(sessions).set({ endedAt: null, exitStatus: null }).where(eq(sessions.id, s.sessId));
    const cause = { reason: "后台工作跑完了，智能体没开始整理结果", detail: "后台都跑完了" };
    // 单飞的收尾形状：exit 0 却被判失败（看门狗那种），会话行那一笔跟回合收口同批（alongside）。
    const closeRow = () => db.update(sessions).set({ endedAt: end, exitStatus: 0 }).where(eq(sessions.id, s.sessId));
    const original = dbClient.batch.bind(dbClient);
    type Stmt = Parameters<typeof dbClient.batch>[0][number];
    const sqlOf = (stmt: Stmt) => (typeof stmt === "string" ? stmt : stmt.sql);
    const batches: string[][] = [];
    const snapshots: Awaited<ReturnType<typeof s.session>>[] = [];
    // 批外单独写会话行的次数（读不算：收口前后那两次读也会走单条查询）。
    let executes = 0;
    const originalExecute = dbClient.execute.bind(dbClient);
    (dbClient as { execute: typeof dbClient.execute }).execute = (async (...args: Parameters<typeof dbClient.execute>) => {
      if (/update "sessions"/i.test(sqlOf(args[0]))) executes += 1;
      return originalExecute(...args);
    }) as typeof dbClient.execute;
    (dbClient as { batch: typeof dbClient.batch }).batch = (async (stmts: Parameters<typeof dbClient.batch>[0], mode?: Parameters<typeof dbClient.batch>[1]) => {
      const sqls = stmts.map(sqlOf);
      batches.push(sqls);
      // 收口那一批落下的前一刻与后一刻各读一次：读也是一个批，插不进写批中间。
      const closing = sqls.some((q) => /UPDATE session_turns SET ended_at/.test(q));
      if (closing) snapshots.push(await s.session());
      const result = await original(stmts, mode);
      if (closing) snapshots.push(await s.session());
      return result;
    }) as typeof dbClient.batch;
    const executesBefore = executes;
    await recordTurnSpan({ sessionId: s.sessId, taskId: s.taskId, cwd: repo, startedAt: at, endedAt: end, outcome: "failed", interruption: cause, alongside: closeRow() });
    const closeExecutes = executes - executesBefore;
    (dbClient as { batch: typeof dbClient.batch }).batch = original;
    (dbClient as { execute: typeof dbClient.execute }).execute = originalExecute;
    const [before, after] = snapshots;
    assert.ok(before && after, "收口前后各读到一份");
    assert.deepEqual([before.endedAt, before.exitStatus, before.turnOutcome, before.turnInterruptions], [null, null, null, {}],
      "收口前：两边都还开着");
    assert.deepEqual([after.endedAt, after.exitStatus, after.turnOutcome, after.turnInterruptions?.[at]], [end, 0, "failed", cause],
      "收口后：会话行收尾、回合判失败、原因都在 —— exit 0 也一样，不靠退出码");
    // 写：会话行那一笔和回合收口在同一个批里，没有单独再写一次。
    const close = batches.find((sqls) => sqls.some((q) => /UPDATE session_turns SET ended_at/.test(q)))!;
    assert.ok(close.some((q) => /^update "sessions" set "ended_at"/i.test(q)), "会话行那一笔跟回合收口同一个批");
    assert.equal(closeExecutes, 0, "收口没有在批外单独写会话行");
    // 读：会话行与回合行出自同一个批（不是先后两条）。
    const read = batches.filter((sqls) => sqls.some((q) => /from "session_turns"/i.test(q)));
    assert.ok(read.length > 0 && read.every((sqls) => sqls.some((q) => /from "sessions"/i.test(q))), "读会话行和回合行是同一个批");

    // 批没写成（这一下库挂了）：回合照旧降级不抛，会话行那一笔单独补上；补也写不成就照旧抛给调用方。
    const flaky = await scene({ agentType: "claude" });
    await db.update(sessions).set({ endedAt: null, exitStatus: null }).where(eq(sessions.id, flaky.sessId));
    (dbClient as { batch: typeof dbClient.batch }).batch = (async () => { throw new Error("SQLITE_BUSY"); }) as typeof dbClient.batch;
    try {
      await recordTurnSpan({
        sessionId: flaky.sessId, taskId: flaky.taskId, cwd: repo, startedAt: at, endedAt: end, outcome: "failed", interruption: cause,
        alongside: db.update(sessions).set({ endedAt: end, exitStatus: 1 }).where(eq(sessions.id, flaky.sessId)),
      });
      (dbClient as { execute: typeof dbClient.execute }).execute = (async () => { throw new Error("disk I/O error"); }) as typeof dbClient.execute;
      await assert.rejects(recordTurnSpan({
        sessionId: flaky.sessId, taskId: flaky.taskId, cwd: repo, startedAt: at, endedAt: end, outcome: "failed",
        alongside: db.update(sessions).set({ exitStatus: 2 }).where(eq(sessions.id, flaky.sessId)),
      }), /disk I\/O error/, "会话行那一笔写不成：照旧抛给调用方（跟它从前单独写时一样）");
    } finally {
      (dbClient as { batch: typeof dbClient.batch }).batch = original;
      (dbClient as { execute: typeof dbClient.execute }).execute = originalExecute;
    }
    const degraded = await flaky.session();
    assert.deepEqual([degraded.endedAt, degraded.exitStatus, degraded.turnOutcome], [end, 1, null], "批没写成：会话行单独补上，回合留给下次");
  }

  // ── 5'. 同一条会话重试成功以后 ─────────────────────────────────────────────
  {
    const s = await scene({ agentType: "claude" });
    const cause = { reason: "执行器异常退出（exit 1）", detail: "执行器异常退出（exit 1）" };
    await s.close("failed", cause);
    const at2 = "2026-11-13T12:10:00.000Z";
    await db.update(sessions).set({ turnStartedAt: at2, endedAt: null }).where(eq(sessions.id, s.sessId));
    await openTurn({ sessionId: s.sessId, taskId: s.taskId, cwd: repo, startedAt: at2 });
    await recordTurnSpan({
      sessionId: s.sessId, taskId: s.taskId, cwd: repo, startedAt: at2, endedAt: "2026-11-13T12:12:00.000Z", outcome: "completed",
      alongside: db.update(sessions).set({ endedAt: "2026-11-13T12:12:00.000Z", exitStatus: 0 }).where(eq(sessions.id, s.sessId)),
    });
    const got = await s.session();
    assert.deepEqual(got.turnOutcomes, { [at]: "failed", [at2]: "completed" }, "每回合结局照旧（形状没动）");
    assert.deepEqual(got.turnInterruptions, { [at]: cause }, "前一回合的原因还在，成功的那一回合没有");
    assert.equal(got.turnOutcome, "completed");
  }

  // ── 6. 诊断文件字段类型坏了 ───────────────────────────────────────────────
  {
    const s = await scene({ diagnostics: { failureReason: 503, exitSignal: { bad: true } } });
    const got = turnInterruptionOf(s.taskId, s.sessId, at, { exitStatus: 3, verdict: null, error: null });
    assert.deepEqual(got, { reason: "执行器异常退出（exit 3）", detail: "执行器异常退出（exit 3）" }, "坏诊断当没有，照退出码说");
  }

  // ── 7. 接线 ───────────────────────────────────────────────────────────────
  {
    const run = readFileSync(new URL("../src/single-run.ts", import.meta.url), "utf8");
    assert.match(run, /const interruption = failure && turnOutcome === "failed" \? turnInterruptionOf\(taskId, sessId, a\.turnStart, failure\) : null;/,
      "只在这一回合自己的结局是 failed 时判（停止、引导都不判）");
    assert.match(run, /recordTurnSpan\(\{[^}]*outcome: turnOutcome,\s*interruption,\s*alongside: closeRow,\s*\}\)/,
      "跟结局一起落在回合上；会话行那一笔同批");
    assert.match(run, /const closeRow = db\s*\.update\(sessions\)/, "单飞收尾的会话行写入交给回合收口那一批");
    const duet = readFileSync(new URL("../src/duet/turn.ts", import.meta.url), "utf8");
    assert.match(duet, /const closeRow = db\s*\.update\(sessions\)/);
    assert.match(duet, /recordTurnSpan\(\{[^}]*alongside: closeRow,\s*\}\)/, "duet 收尾同批");
    const team = readFileSync(new URL("../src/team/session-consumer.ts", import.meta.url), "utf8");
    assert.equal(team.match(/closeOwnSessionWithTurn\(/g)?.length, 2, "团队调度台两条收尾路（回合说完、关台）同批");
    assert.equal(team.match(/updateOwnSession\(/g)?.length, 1, "只剩关台时一个回合都没攥着那一下单独写会话行");
    assert.match(run, /const done = \{ \.\.\.doneEvent, turnOutcome, \.\.\.\(interruption \? \{ interruption \} : \{\}\) \};/,
      "同一份跟着结尾事件播出去（直播那一路）");
  }

  // ── 8. 团队调度台被接管以后，旧台晚到的写 ─────────────────────────────────
  {
    const { closeOwnSessionWithTurn, updateOwnSession } = await import("../src/team/lead-session-writes.js");
    const s = await scene({ agentType: "codex" });
    const at2 = "2026-11-13T12:10:00.000Z";
    const row = async () => (await db.select().from(sessions).where(eq(sessions.id, s.sessId)))[0]!;
    // 旧台：开台时写下持有者代次，回合开着。
    await db.update(sessions).set({ leadHolder: "old", endedAt: null, exitStatus: null, cliSessionId: "old-cli" }).where(eq(sessions.id, s.sessId));
    const old = { taskId: s.taskId, sessId: s.sessId, holder: "old", retired: false } as never;
    /** 新台接管同一行（openLead 的 resuming 分支那一笔的形状）。 */
    const takeover = { leadHolder: "new", turnStartedAt: at2, endedAt: null, exitStatus: null, cliSessionId: "successor-cli" };
    const span = { sessionId: s.sessId, taskId: s.taskId, cwd: repo, startedAt: at, endedAt: end, outcome: "failed" as const };
    const patch = { endedAt: end, exitStatus: 1, cliSessionId: null };
    const original = dbClient.batch.bind(dbClient);
    try {
      // ① 收尾那一批没写成，旧调用回到 catch 补写之前新台接管了这一行。
      (dbClient as { batch: typeof dbClient.batch }).batch = (async () => {
        (dbClient as { batch: typeof dbClient.batch }).batch = original;
        await db.update(sessions).set(takeover).where(eq(sessions.id, s.sessId));
        throw new Error("SQLITE_BUSY");
      }) as typeof dbClient.batch;
      assert.equal(await closeOwnSessionWithTurn(old, "调度台收尾状态", patch, span, end), true, "补写落空不算故障");
    } finally {
      (dbClient as { batch: typeof dbClient.batch }).batch = original;
    }
    const kept = { leadHolder: "new", turnStartedAt: at2, endedAt: null, exitStatus: null, cliSessionId: "successor-cli" };
    const pick = (r: Awaited<ReturnType<typeof row>>) => ({
      leadHolder: r.leadHolder, turnStartedAt: r.turnStartedAt, endedAt: r.endedAt, exitStatus: r.exitStatus, cliSessionId: r.cliSessionId,
    });
    assert.deepEqual(pick(await row()), kept, "批失败后的补写不覆盖接管后的新会话");
    // ② 判过「还在台上」之后、语句真正执行之前就被接管了（等数据库空闲那一段）：原批里那一笔同样落空，回合照落。
    await closeOwnSessionWithTurn(old, "调度台收尾状态", patch, span, end);
    assert.deepEqual(pick(await row()), kept, "原批里的会话行那一笔不覆盖接管后的新会话");
    assert.equal((await s.session()).turnOutcomes?.[at], "failed", "旧台自己跑过的那一回合照样收口");
    // ③ 单独的会话行更新（回合说完、凭据补写走的那一个入口）同一道闸。
    await updateOwnSession(old, "回合收尾状态", { endedAt: end, exitStatus: 1 }, end);
    assert.deepEqual(pick(await row()), kept, "单独的会话行更新也挡得住");
    // 还在台上的那一台照常写得进去。
    const current = { taskId: s.taskId, sessId: s.sessId, holder: "new", retired: false } as never;
    await updateOwnSession(current, "回合收尾状态", { exitStatus: 7 }, end);
    assert.equal((await row()).exitStatus, 7, "持有这一行的那一台照常写");
    const writes = readFileSync(new URL("../src/team/lead-session-writes.ts", import.meta.url), "utf8");
    assert.equal(writes.match(/\.where\(ownRow\(lead\)\)/g)?.length, 2, "两个写入口都按持有者写");
    const team = readFileSync(new URL("../src/team/session-consumer.ts", import.meta.url), "utf8");
    assert.doesNotMatch(team, /\.where\(eq\(sessions\.id, lead\.sessId\)\)/, "调度台消费循环里不再有只按会话 id 的写");
    const open = readFileSync(new URL("../src/team/session.ts", import.meta.url), "utf8");
    assert.equal(open.match(/leadHolder: holder,/g)?.length, 2, "开台与接管都写下持有者代次");
  }

  console.log("✅ 普通回合怎么断的：上游带状态码与原话、只有退出码按退出码说、停止/正常/老记录不给、跟着回合与 done 走");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
