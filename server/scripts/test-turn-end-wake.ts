// 回合一结束,托盘里等着的消息就该送进会话 —— 两处曾经掉回 30 秒兜底 tick 的现场。
//
// 现场一(用户 2026-11-13 截图):时间线上已经写了「第 2 轮审查未通过,1 条意见」,托盘里那条
// 【自由工作流审查未通过】却挂着「等待当前一轮结束」迟迟不动。库里的时间戳说得很清楚:
// 修复指令的 sent_at 全部落在 30 秒兜底 tick 的相位上,入队到送达平均 15 秒、最长 30 秒。
// 根因:排队消息的「任务空下来」触发源挂在**落状态那一刻**(status.ts 的钩子),而修复指令是
// 结算钩子(afterSettlement → 审查收尾)在那之后才入队的 —— 那次扫描看不到它,回合锁放开时
// 又没有任何人登记过「放开了就送」。
//
// 现场二(同一天的第二张截图):回合中途到的哨兵结果,回合结束后有时 0.3 秒就送进去,有时要等
// 十几二十秒。库里 110 个样本按「这一回合是谁起的」一分就干净了:手动运行/回复起的回合 43 个
// 全部秒送;**排队消息送进去起的回合**(审查修复指令、上一条哨兵结果)45 个掉回 tick,剩下 7 个
// 快的里 6 个中途重启过服务(内存里的去重标记跟着没了)、1 个恰好撞上 tick。
// 根因:投递给任务挂的「在途」去重标记一直挂到**它送进去的那一回合跑完**(continueTask 等的是
// 整个回合),于是那一回合结束时的扫描被自己的标记挡掉,标记摘掉之后也没人再扫。同一本账上的
// 冷却窗口是同一个毛病的小号:挡下一扫,窗口过了要靠补扫定时器 —— 冷却护的那道缝早就不在了,
// 连同补扫一起删掉(src/pending-in-flight.ts 文件头)。
// 所以这里除了量延迟,还直接钉「回合起来了标记就得摘」。
//
// 两处现场的共同根因是:扫描与队列推进挂在**落状态那一刻**,而状态是持锁写的 —— 那一刻扫不到之后
// 才入队的消息,推进也认领不到锁,于是各处各自登记「放开了再来一次」,漏一处就掉回 tick。现在两件
// 事固定挂在放锁上(src/turn-release.ts),现场三钉的就是这条:持锁期间不推进,放锁那一刻推进。
//
// 走的都是真实收流(consumeSingleRun / continueTask)加上生产同款的「收流完再放锁」,而且**全程
// 不起 scheduler**:这里能送出去、推得动,只可能是回合结束那一刻的唤醒。
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
  const { agents, freeReviewRounds, freeReviewRuns, projects, queueItems, reviewerProfiles, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { freeWorkflowState, reportFreeReviewConclusion } = await import("../src/free-workflow.js");
  const { freeReviewEvidenceDir, freeReviewReportPath } = await import("../src/free-review-files.js");
  const { evidenceState } = await import("../src/regression-evidence-lifecycle.js");
  const { claimOwnTurn, isTurnClaimed, releaseTurn } = await import("../src/runs.js");
  const { enqueueMessage, flushPendingForTask } = await import("../src/pending-messages.js");
  const { deliveryInFlight } = await import("../src/pending-in-flight.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { ClaudeExecutor } = await import("../src/executors/claude.js");
  const { CodexExecutor } = await import("../src/executors/codex.js");
  await ensureSchema();

  // 回合由生产的投递链路(dispatchPendingMessage → continueTask)自己拉起,这里只换掉「真的起
  // 一个 CLI」那一步,并记下它拿到的输入。没排剧本的回合按退出码 1 收场 = 修复回合异常结束:
  // 自动复审随之取消,现场一那条链就停在这儿,不再往下开第 2 轮。
  const delivered: string[] = [];
  const scripted: Array<() => AsyncGenerator<AgentEvent>> = [];
  const run = (opts: RunOpts): RunHandle => {
    delivered.push(opts.prompt);
    const events = scripted.shift() ?? (async function* (): AsyncGenerator<AgentEvent> { yield { kind: "done", exitStatus: 1 }; });
    return { sessionId: "turn-end-wake-test", commandLine: "fixture turn", kill() {}, events: events() };
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

  // ── 现场二:这一回合本身就是「排队消息送进去」起的 ─────────────────────────────
  const statusOf = async (messageId: string) =>
    (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId)))[0]?.status;
  const got = (needle: string) => delivered.filter((prompt) => prompt.includes(needle)).length;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // 第一条排队消息把任务拉进一个回合(开多久由 openFor 定),回合中途再来一条(生产里是哨兵结果 /
  // 用户补的一句);返回「上一回合结束 → 后到那条送进去」隔了多久。
  const lateArrival = async (id: string, openFor: number): Promise<number> => {
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.insert(sessions).values({
      id: `${id}-single`, taskId: id, role: "single", agentType: "codex", executor: "test",
      cwd: root, startedAt: at, turnStartedAt: at, endedAt: at,
    });
    const taskStatus = async () => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!.status;
    let endFirstTurn = () => {};
    const firstTurnOpen = new Promise<void>((resolve) => { endFirstTurn = resolve; });
    scripted.push(async function* (): AsyncGenerator<AgentEvent> {
      yield { kind: "text", text: "收到。" };
      await firstTurnOpen;
      yield { kind: "done", exitStatus: 0 };
    });
    scripted.push(async function* (): AsyncGenerator<AgentEvent> { yield { kind: "done", exitStatus: 0 }; });

    const opener = await enqueueMessage({ taskId: id, text: `OPENER-${id}` });
    flushPendingForTask(id);
    await waitFor(async () => got(`OPENER-${id}`) === 1 && await statusOf(opener.id) === "sent" && await taskStatus() === "running",
      "测试自身前提:第一条排队消息应该把任务拉进一个回合");
    // 结束那一扫靠不靠得住,取决于这一条:标记挂到回合跑完的话,那一扫会被它自己挡掉,能不能
    // 送出去就只剩「别的补扫恰好排在摘标记之后」这种次序上的运气。
    await waitFor(() => !deliveryInFlight(id), "回合已经起来了(输入已被收下),这一次投递的在途标记就该摘掉", 2_000);
    const late = await enqueueMessage({ taskId: id, text: `LATE-${id}` });
    flushPendingForTask(id);
    await sleep(openFor);
    assert.equal(got(`LATE-${id}`), 0, "上一回合还在跑,后到的那条不许抢跑");
    assert.equal(await statusOf(late.id), "pending");

    endFirstTurn();
    const endedAt = Date.now();
    await waitFor(() => got(`LATE-${id}`) === 1,
      "排队消息起的回合结束之后,等着的那条没人送 —— 结束那一扫被去重账挡掉又没人补扫,只能干等 30 秒兜底 tick", 8_000);
    const waited = Date.now() - endedAt;
    await waitFor(async () => await statusOf(late.id) === "sent", "送进会话之后这一行应标 sent");
    await waitFor(async () => {
      const status = await taskStatus();
      return status !== "running" && status !== "queued" && !isTurnClaimed(id);
    }, "第二个回合没有结算");
    assert.equal(got(`LATE-${id}`), 1, "后到的那条只送一次");
    assert.equal(got(`OPENER-${id}`), 1, "起头的那条只送一次");
    return waited;
  };

  // 生产里的回合以分钟计:开过冷却窗口(5 秒)再结束,剩下能挡住结束那一扫的只有在途标记。
  const afterLongTurn = await lateArrival("dispatched-long", 5_300);
  assert.ok(afterLongTurn < 2_000, `回合一结束就该送进去,实际隔了 ${afterLongTurn}ms —— 在途标记不许跟着挂到回合跑完`);
  console.log(`✓ 排队消息起的回合:回合一结束,中途到的下一条立刻送达(${afterLongTurn}ms),不等兜底 tick`);

  // 短回合(起跑即失败、一两句话就答完):结束那一扫同样当场送出,不再被冷却挡下、等补扫定时器。
  const afterShortTurn = await lateArrival("dispatched-short", 100);
  assert.ok(afterShortTurn < 2_000, `短回合一结束也该当场送进去,实际隔了 ${afterShortTurn}ms`);
  console.log(`✓ 排队消息起的短回合:回合一结束,中途到的下一条立刻送达(${afterShortTurn}ms),不等补扫也不等兜底 tick`);

  // ── 现场三:串行队列的下一位,在前一位放锁那一刻起跑 ──────────────────────────────────
  // 前一位的状态是持锁写的。早先那一笔落库当场就推队列:下一位在前一位还没收完尾(注销句柄、
  // 放锁)时就被拉起来。现在持锁期间一步都不推,锁一放当场推 —— 不等兜底 tick,也不等推进自己
  // 的 1 秒退避重试(所以下面先空等 1.5 秒,再要求放锁后 1 秒内起跑)。
  const head = "queue-head";
  const next = "queue-next";
  await createTasks([head, next].map((qid) => ({
    id: qid, projectId: "p", title: qid, body: qid === next ? "NEXT-IN-QUEUE" : "test", mode: "single" as const,
    status: qid === head ? "running" as const : "backlog" as const,
    agentType: "codex" as const, executorId: "ex", autoTitle: false, workflowMode: "free" as const,
    useWorktree: false, createdAt: at, updatedAt: at,
  })));
  await db.insert(queueItems).values([
    { taskId: head, queueId: "q-release", position: 0, createdAt: at },
    { taskId: next, queueId: "q-release", position: 1, createdAt: at },
  ]);
  const headSess = `${head}-single`;
  await db.insert(sessions).values({
    id: headSess, taskId: head, role: "single", agentType: "codex", executor: "test", cwd: root, startedAt: at, turnStartedAt: at,
  });
  const headTurn = claimOwnTurn(head, "single");
  assert.ok(headTurn, "测试自身前提:队首这一轮应该占得到锁");
  const headPath = sessionTranscriptPath(head, headSess);
  mkdirSync(dirname(headPath), { recursive: true });
  const headOut = createWriteStream(headPath, { flags: "a" });
  const headClosed = once(headOut, "close");
  const headHandle: RunHandle = {
    sessionId: "", commandLine: "fixture", kill() {},
    events: (async function* (): AsyncGenerator<AgentEvent> { yield { kind: "done", exitStatus: 1 }; })(),
  };
  await consumeSingleRun({
    taskId: head, sessId: headSess, agentType: "codex", ex: { ...reviewer, run: () => headHandle }, cwd: root,
    handle: headHandle, out: headOut, turnStart: at, cliSessionId: "", autoTitle: false, role: "single",
  });
  await headClosed;
  const statusOfTask = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status;
  assert.equal(await statusOfTask(head), "failed", "测试自身前提:队首这一轮已经落位(失败透明让位)");
  await sleep(1_500);
  assert.equal(got("NEXT-IN-QUEUE"), 0, "队首的锁还占着(收尾没走完),下一位不许被拉起来");
  assert.equal(await statusOfTask(next), "backlog");

  releaseTurn(head, headTurn);
  const releasedAt = Date.now();
  await waitFor(() => got("NEXT-IN-QUEUE") === 1, "队首放锁之后下一位没起跑 —— 推进只剩兜底 tick", 3_000);
  const advancedIn = Date.now() - releasedAt;
  assert.ok(advancedIn < 1_000, `放锁那一刻就该推进,实际隔了 ${advancedIn}ms`);
  await waitFor(async () => {
    const status = await statusOfTask(next);
    return status !== "running" && status !== "queued" && !isTurnClaimed(next);
  }, "下一位那一轮没有结算");
  assert.equal(got("NEXT-IN-QUEUE"), 1, "下一位只起一次");
  console.log(`✓ 串行队列:持锁期间不推进,队首放锁那一刻下一位起跑(${advancedIn}ms),不等兜底 tick`);
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
