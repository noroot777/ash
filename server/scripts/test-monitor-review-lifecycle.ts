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

/** 一次正在进行的自由工作流审查 + 它那条活着的审查会话。 */
async function reviewInFlight(
  taskId: string,
  opts: { runId: string; agentType?: string; executorId?: string; model?: string; live?: boolean } = { runId: "run-x" },
): Promise<void> {
  await db.insert(schema.freeReviewRuns).values({
    id: opts.runId, taskId, reviewerName: "审查者", agentType: opts.agentType ?? "codex",
    executorId: opts.executorId ?? null, model: opts.model ?? null,
    checkMode: "logic", status: "reviewing", createdAt: now(), updatedAt: now(),
  });
  await db.insert(schema.freeReviewRounds).values({
    id: `round-${opts.runId}`, runId: opts.runId, round: 1, status: "reviewing", startedAt: now(),
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

  // 精确注入：只让「读 tasks.resumePrompt」那一问失败（形状与 monitorWakeCheckpoint 对上：
  // 它现在连「这段话是谁写的」一起读 —— `resume_prompt_auto` 要跟那段话一起转手，见
  // task-resume-prompt.ts 文件头），别的查询照常 —— 否则投递链路在更早的地方就炸了，测的
  // 就不是这条出路。下面那句 `armed === false` 是这段注入的自检，形状漂了它会当场出声。
  const original = db.select;
  let armed = true;
  db.select = ((fields?: Record<string, unknown>) => {
    if (armed && fields && "resumePrompt" in fields && "auto" in fields) {
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

await teardown();
console.log("✓ 审查哨兵的生命周期：审查回合退出不收它 / 审查收尾才收它 / 唤醒用那次审查的执行器 / 等待中补挂也认审查 / 读交代失败归还租约");
