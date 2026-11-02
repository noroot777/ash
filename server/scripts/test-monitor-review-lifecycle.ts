// 审查者挂的哨兵，**活到那次审查结束**，而不是活到任务状态变回终态。
//
// 这一份测的是整链，不是单个判据 —— 第 1 轮审查的三条拦验收全部出在「每个判据各自都对、
// 串起来却漏」的缝里，而当时的套件全绿：
//
// ① 审查是**旁路回合**：跑的时候任务被写成 running，回合一退出又被恢复成原来的 done。
//    于是 `setTaskStatus` 的终态连坐紧接着就跑，把审查者刚按提示挂好的哨兵当场停掉、待发
//    事件一并作废。创建闸、事件出口、投递闸三处都做了「审查进行中」的豁免，**清理层没有**
//    （F1：pause 成功、monitorStatus=stopped、run 仍 reviewing、resumePrompt 还留着 ——
//    一个没人能叫醒的等待）。
// ② 事件只带了 `reviewer` 这个**角色**，没带「是哪一次审查、用谁的执行器」。角色不足以
//    定位会话：审查者可以是另一个执行器（codex 审 claude 写的代码），续跑于是回落到任务
//    自己的配置，新建一条 claude 的 reviewer 会话（F2）。
// ③ 新加的「续跑交代」读写一旦临时失败，通知会被永久取消、或者带着租约卡住不再投递（F4）。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  db, inTurnCaller, monitors, pending, root, runs, schema, scheduledMessages, sessions, tasks,
  makeTask, now, pendingOf, startMonitor, until, teardown,
} from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";
import { freeReviewEvidenceDir } from "../src/free-review-files.js";

const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { afterSettlement, settleTaskStatus } = await import("../src/settle-status.js");
const { deliveryOptions, monitorWakeGuard } = await import("../src/pending-verdict.js");
const { stopReviewRunMonitors } = await import("../src/free-review-round.js");
const { monitorSourceGate } = await import("../src/monitor-session.js");

/** 真实的 pause 路由：审查者按提示 `pause_task` 收尾走的就是它。 */
const api = new Hono();
api.use("*", async (c, next) => { setActor(c, SINGLE_ACTOR); await next(); });
mountTaskRunRoutes(api);
const app = new Hono().route("/api", api);

/**
 * 一次正在进行的自由工作流审查 + 它那条活着的审查会话 + **它那一轮的证据行**。
 *
 * 证据行不是可选的摆设:派一轮审查一定会建它(`launchReviewRound` → `restartRegressionEvidence`),
 * 而「这一轮此刻是第几次」「审查者的等待算不算数」两问的权威全在那一行 —— 少了它,
 * `reviewContinuationPending` 第一问就按「没人在等」返回,审查者刚 pause 的那一轮会被当场
 * 结算掉。`targetIdentity` 照生产取**此刻**这个任务的方向身份(`reviewTargetIdentity`),
 * 否则 `reviewWaitAuthorized` 认不出这份等待是这一轮的。
 */
async function reviewInFlight(
  taskId: string,
  opts: {
    runId: string; agentType?: string; executorId?: string; model?: string; live?: boolean;
    generation?: string;
  } = { runId: "run-x" },
): Promise<void> {
  await db.insert(schema.freeReviewRuns).values({
    id: opts.runId, taskId, reviewerName: "审查者", agentType: opts.agentType ?? "codex",
    executorId: opts.executorId ?? null, model: opts.model ?? null,
    checkMode: "logic", status: "reviewing", createdAt: now(), updatedAt: now(),
  });
  await db.insert(schema.freeReviewRounds).values({
    id: `round-${opts.runId}`, runId: opts.runId, round: 1, status: "reviewing", startedAt: now(),
  });
  const owner = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  await db.insert(schema.regressionEvidence).values({
    directory: freeReviewEvidenceDir(taskId, opts.runId, 1), taskId,
    generation: opts.generation ?? `gen-${opts.runId}`, excludedMonitors: [],
    targetIdentity: {
      turnToken: owner.activeTurnToken, directionToken: owner.activeDirectionToken,
      directionEpoch: owner.directionEpoch,
    },
    continuation: { phase: "running" },
  });
  if (opts.live !== false) {
    await db.insert(sessions).values({
      id: `s-${opts.runId}`, taskId, role: "reviewer", agentType: opts.agentType ?? "codex",
      executor: "审查者", cwd: root, startedAt: now(),
      agentPid: process.pid, agentStartedAt: inspectProcess(process.pid)?.startedAt ?? null,
    });
  }
}

// ── ① 审查回合退出、任务恢复终态：哨兵与它的待发事件都要留着 ───────────────────
{
  const taskId = await makeTask();
  runs.claimTurn(taskId, "reviewer", { run: "run-keep", round: 1 });
  await db.update(tasks).set({
    workflowMode: "free", followUpFrom: "done",
    activeTurnToken: "tok", activeDirectionToken: "dir",
  }).where(eq(tasks.id, taskId));
  await reviewInFlight(taskId, { runId: "run-keep" });

  const started = await startMonitor({
    // 审查回合里挂的:来源 = 本任务当前这一回合(上面 `claimTurn` 落的 reviewer)。
    taskId, command: "sleep 120", description: "审查等外部套件", timeoutMs: 180_000,
    caller: await inTurnCaller(taskId, "tok"),   // 这个任务的回合令牌是上面那个 "tok"
  });
  assert.ok(started.ok, `审查进行中就该挂得上：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";

  // 审查者按提示用 pause_task 收尾这一轮（走真实路由，连带写 resumePrompt）。
  const pause = await app.request(`/api/tasks/${taskId}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ash-turn-token": "tok", "x-ash-direction-token": "dir" },
    body: JSON.stringify({ resumePrompt: "套件完成后继续审查并交报告" }),
  });
  assert.equal(pause.status, 200, "pause 应该成功：旁路回合跑的时候任务是 running");

  // 回合退出 → 结算恢复原来的终态 → 终态连坐清理。这一整段是生产代码本身。
  const settled = await settleTaskStatus(taskId, 0, null, "s-run-keep");
  await afterSettlement(taskId, settled.status, settled.confirmedDone, true, "reviewer");
  runs.releaseTurn(taskId);

  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const run = (await db.select().from(schema.freeReviewRuns)
    .where(eq(schema.freeReviewRuns.id, "run-keep"))).at(0)!;
  assert.equal(settled.status, "done", "旁路回合结算本来就该把任务恢复成原来的终态");
  assert.equal(run.status, "reviewing", "审查还没收尾");
  assert.equal(row.status, "running",
    "任务恢复终态不等于审查结束：审查者刚挂好的哨兵不许在这一刻被停掉（F1）");
  assert.equal(task.resumePrompt, "套件完成后继续审查并交报告", "它留的续跑交代也要还在");

  // 唤醒前最后那道闸（租约已抢下、真正续跑之前的那个窗口）。只读 taskId / origin 两个字段，
  // 所以这里构造一个最小消息投影，不必为它真排一条待发送消息。
  const guard = monitorWakeGuard({ taskId, origin: `monitor:${monitorId}` } as never);
  assert.ok(guard, "哨兵推的消息要挂上唤醒前最后那道闸");
  assert.equal(await guard!(), null, "来源审查还在进行时，这条事件仍该唤醒任务（F1）");

  // ── ② 那次审查真的收尾了，哨兵才一并收回（跟 ① 是一对，否则它会空盯到自己到期）──
  await db.update(schema.freeReviewRuns).set({ status: "passed" })
    .where(eq(schema.freeReviewRuns.id, "run-keep"));
  assert.ok(await guard!() !== null, "来源审查结束后，这条事件不再唤醒任务");
  assert.equal(await stopReviewRunMonitors("run-keep", "这次审查已通过，它挂的哨兵一并收回"), 1,
    "收的就是它名下那一个");
  const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(after.status, "stopped", "审查收尾时要把它名下的哨兵停掉");
  assert.match(after.endedReason ?? "", /审查/, "停掉的原因要说清是审查收尾，不是任务结束");
  assert.equal((await pendingOf(taskId)).filter((m) => m.origin === `monitor:${monitorId}`).length, 0,
    "那条哨兵还没送出去的事件跟着作废");
}

// ── ③ 唤醒那一轮用的是**那次审查**的执行器，不是任务自己的 ─────────────────────
{
  const taskId = await makeTask();           // 任务 agentType=claude（fixture 默认）
  await reviewInFlight(taskId, {
    runId: "run-codex", agentType: "codex", executorId: "codex@cpa", model: "gpt-5.6-sol",
  });
  const started = await startMonitor({
    taskId, command: "printf 'READY\\n'", description: "审查者的事件", timeoutMs: 60_000,
    caller: { kind: "external", wake: "reviewer" },   // 审查者挂的(台子没占回合锁,显式说清)
  });
  assert.ok(started.ok, `起不来：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.sourceReviewRun, "run-codex", "哨兵要记住是哪一次审查挂的它");

  await until("事件入队", async () => (await pendingOf(taskId)).some((m) => m.origin === `monitor:${monitorId}`));
  const queued = (await pendingOf(taskId)).find((m) => m.origin === `monitor:${monitorId}`)!;
  assert.equal(queued.sessionRole, "reviewer", "角色照旧要带");
  assert.equal(queued.agent, "codex",
    "审查者是 codex：唤醒这一轮不能回落到任务自己的 claude，否则新建一条 claude reviewer 会话（F2）");
  assert.equal(queued.executorId, "codex@cpa", "执行器 profile 也要跟着那次审查走");
  assert.equal(queued.model, "gpt-5.6-sol", "模型同理");
  const opts = deliveryOptions(queued);
  assert.equal(opts.agent, "codex", "投递参数拼装那一层要把它传给 continueTask");
  assert.equal(opts.executorId, "codex@cpa");
}

// ── ④ 审查停在那儿等（一个 agent 进程都没有）时手动补挂的哨兵 ───────────────────
//
// 审查者按提示 pause 了一轮等外部结果，这会儿用户在面板上又补挂一个哨兵。那一刻**没有任何
// 回合在跑**，权威角色问不出来；但任务是终态、审查还在进行，它能挂上来本身就说明是那次审查
// 豁免放它进来的 —— 于是那次审查是唯一有出路的归属（第 1 轮审查 F2 第 3 条）。不认这一条，
// 它会以默认的 `single` 入队，把**实现者**叫起来跑一轮。
{
  const taskId = await makeTask({ status: "done" });
  await reviewInFlight(taskId, { runId: "run-waiting", live: false });
  const gate = await monitorSourceGate({ id: taskId, status: "done", archived: false }, { kind: "external" });
  assert.equal(gate.blocked, null, "审查还在进行，终态任务上照样挂得上");
  assert.equal(gate.role, "reviewer", "没有任何回合在跑也要认出这是审查在等（F2）");
  assert.equal(gate.reviewRun, "run-waiting", "并且记住是哪一次审查");

  // 执行者自己挂的不绑审查：它的命跟着任务走。来源是**执行回合**这件事由回合锁作证，
  // 不再靠「哪条会话的进程还活着」猜（第 7 轮审查 F2）。
  const plain = await makeTask();
  runs.claimTurn(plain, "single");
  const plainTurn = await inTurnCaller(plain);
  const plainGate = await monitorSourceGate(
    { id: plain, status: "running", archived: false, activeTurnToken: `turn-${plain}` }, plainTurn);
  assert.equal(plainGate.role, "single");
  assert.equal(plainGate.reviewRun, null, "执行者挂的哨兵不该绑在某次审查上");
}

// ── ⑤ 读续跑交代临时失败：归还租约等重投，不许取消也不许卡着 ───────────────────
//
// 取消是「这条事件永远送不出去了」的意思，一次读错就把本该重试的唤醒永久吞掉；而租约不还
// 更糟 —— 后续扫描显式跳过带租约的行，这条消息直到进程重启回收前再也不会被投递（F4）。
{
  const taskId = await makeTask({ mode: "team", status: "idle" });
  await db.update(tasks).set({ resumePrompt: "醒了接着看套件结果" }).where(eq(tasks.id, taskId));
  await db.insert(scheduledMessages).values({
    id: "msg-fail", taskId, text: "【哨兵】READY", attachments: "[]",
    origin: "monitor:m-nonexistent", mode: "queued", status: "pending",
    sendAt: now(), createdAt: now(),
  });

  // 精确注入：只让「读 tasks.resumePrompt」那一问失败（形状与 monitorWakeCheckpoint 对上），
  // 别的查询照常 —— 否则投递链路在更早的地方就炸了，测的就不是这条出路。下面那句
  // `armed === false` 是这段注入的自检，形状漂了它会当场出声。
  const original = db.select;
  let armed = true;
  db.select = ((fields?: Record<string, unknown>) => {
    if (armed && fields && "resumePrompt" in fields && !("question" in fields)) {
      armed = false;
      throw new Error("INJECTED_RESUME_PROMPT_READ_FAIL");
    }
    return (original as (f?: unknown) => unknown).call(db, fields);
  }) as typeof db.select;
  try {
    await pending.deliverPendingMessages(taskId);
  } finally {
    db.select = original;
  }
  assert.equal(armed, false, "注入没命中就说明这条出路没被走到，断言会变成空测");

  const msg = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "msg-fail"))).at(0)!;
  assert.equal(msg.status, "pending", "读交代失败不是「永远送不出去」，不许取消（F4）");
  assert.equal(msg.deliveringSince, null, "租约必须归还，否则后续扫描会一直跳过这一行（F4）");
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  assert.equal(task.resumePrompt, "醒了接着看套件结果", "一个字都没送出去，交代要原样留着");
}

// ── ⑥ 同一轮被重跑：资源身份带满三件套，旧收尾只动自己那一次的 ────────────────
//
// `run.id` 跨轮复用，重跑连轮次都不变（`reopenFailedFreeReview` 只换证据行的代次）。收尾
// 又全是**异步**的：落完终态之后才停哨兵、才作废它排着的结果，中间全是 await。于是上一次
// 的收尾能把新一次刚挂上的哨兵停掉、把它等的结果作废，而新一次的审查者还在跑 —— 它等的
// 东西再也不会来（第 4 轮审查 F2 实测：NEW_MONITOR_AFTER_OLD_CLEANUP stopped）。
//
// 根因是**资源身份少了一位**，不是少一把锁：所以哨兵行记满 run + 轮次 + 代次，每一处收尾
// 只动身份对得上的那些行，每一处唤醒也只认身份还对得上的那些事件。
{
  const taskId = await makeTask();
  await reviewInFlight(taskId, { runId: "run-gen", generation: "gen-1" });
  const directory = freeReviewEvidenceDir(taskId, "run-gen", 1);

  const hang = async (description: string): Promise<string> => {
    const started = await startMonitor({
      taskId, command: "sleep 120", description, timeoutMs: 180_000,
      caller: { kind: "external", wake: "reviewer" },   // 审查者/用户在面板上挂的
    });
    assert.ok(started.ok, `起不来：${started.ok ? "" : started.error}`);
    return started.ok ? started.monitor.id : "";
  };
  const rowOf = async (id: string) => (await db.select().from(monitors).where(eq(monitors.id, id))).at(0)!;
  // 命令还活着、结果却已经排在托盘里等投递，是审查者挂的哨兵最常见的形态；归属判错时这一
  // 份是另一半损失（新一次等的结果被上一次作废）。所以两条都各排一条，分开看谁被收走。
  const result = async (monitorId: string) => {
    await db.insert(scheduledMessages).values({
      id: `msg-${monitorId}`, taskId, text: "【哨兵事件】READY", attachments: "[]",
      origin: `monitor:${monitorId}`, mode: "queued", status: "pending", sendAt: now(), createdAt: now(),
    });
  };

  const old = await hang("上一次审查等外部套件");
  assert.equal((await rowOf(old)).sourceReviewRound, 1, "轮次照旧要记");
  assert.equal((await rowOf(old)).sourceReviewGeneration, "gen-1",
    "代次也要记在行上：没有它，「这是上一次挂的」谁都认不出来");
  await result(old);

  // 用户重跑这一轮：run 是同一个、轮次也是同一个，只有证据行换了代次。
  await db.update(schema.regressionEvidence).set({ generation: "gen-2" })
    .where(eq(schema.regressionEvidence.directory, directory));
  const fresh = await hang("重跑这一次审查等外部套件");
  assert.equal((await rowOf(fresh)).sourceReviewGeneration, "gen-2", "新挂的归新一次");
  await result(fresh);

  // 上一次的收尾这会儿才跑到（它那段 await 里用户已经重跑过了）。
  const stopped = await stopReviewRunMonitors(
    "run-gen", "上一次审查启动失败，收回它挂的哨兵", false, { round: 1, generation: "gen-1" });
  assert.equal(stopped, 1, "收的只能是它自己那一次挂的那一个");
  assert.equal((await rowOf(old)).status, "stopped", "上一次的哨兵该它自己收走");
  assert.equal((await rowOf(fresh)).status, "running",
    "新一次刚挂上的哨兵不许被上一次的收尾停掉（第 4 轮审查 F2）");
  const left = (await pendingOf(taskId)).map((m) => m.origin);
  assert.deepEqual(left, [`monitor:${fresh}`],
    "排着的结果同理：作废上一次的，新一次等的那一条必须留着（第 4 轮审查 F2）");

  // 唤醒侧用的是同一份身份：身份对不上的事件不再叫人，对得上的照旧叫。
  const guard = (id: string) => monitorWakeGuard({ taskId, origin: `monitor:${id}` } as never)!;
  assert.ok(await guard(old)() !== null, "上一次的遗留事件不许送进重跑起来的那一次的会话");
  assert.equal(await guard(fresh)(), null, "新一次自己的事件照旧要唤醒任务");

  // 新一次自己的收尾照旧收得走它（身份是「只收自己那一次」，不是「谁都收不走」）。
  assert.equal(await stopReviewRunMonitors("run-gen", "这一次审查收尾", false,
    { round: 1, generation: "gen-2" }), 1, "新一次收尾时收走自己那一个");
  assert.equal((await rowOf(fresh)).status, "stopped");
  assert.equal((await pendingOf(taskId)).length, 0, "它排着的结果跟着作废");
}

await teardown();
console.log("✓ 审查哨兵的生命周期：审查回合退出不收它 / 审查收尾才收它 / 唤醒用那次审查的执行器 / 等待中补挂也认审查 / 读交代失败归还租约 / 重跑换代次后旧收尾只动自己那一次");
