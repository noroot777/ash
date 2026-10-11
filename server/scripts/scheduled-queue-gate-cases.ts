// 「执行入口过队列认领」那一组用例:定时到点(schedules.fire)与提问答复(/answer)
// 排在前项后面时必须等,轮到后恰好执行一次(第 8 轮审查两条拦验收)。
//
// 从 `test-scheduled-messages.ts` 拆出,理由同 `scheduled-handoff-cases.ts`:主文件与
// handoff 那份都顶到 700 行上限。这一组问的是**队列认领对自动/半自动入口的覆盖**,
// 跟「消息怎么排队投递」「让位交接谁当首轮输入」都是不同的边界。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { HandoffCaseContext } from "./scheduled-handoff-cases.js";

export async function runQueueGateCases(ctx: HandoffCaseContext): Promise<void> {
  const { at, root, leadLog, waitFor, countIn, taskRow } = ctx;
  const [{ db }, schema, pending, runs, schedulesModule, runRoutes, { Hono }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/pending-messages.js"),
    import("../src/runs.js"),
    import("../src/schedules.js"),
    import("../src/task-run-routes.js"),
    import("hono"),
  ]);
  const { queueItems, scheduledMessages, schedules, sessions, tasks } = schema;
  const api = new Hono();
  runRoutes.mountTaskRunRoutes(api);
  const taskStatusOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!.status;
  // status=running 在 spawn 之前就落库(占位→落状态→拉进程),立刻 stopTask 会扑空;
  // 等到进程真的被 track 了再停。
  const stopWhenLive = async (id: string) => {
    await waitFor(() => runs.isRunning(id), `${id} 的执行进程没有拉起`);
    assert.equal(runs.stopTask(id), true, `测试前提:${id} 的活进程应能被停掉`);
    await waitFor(async () => {
      const s = await taskStatusOf(id);
      return s !== "running" && s !== "queued";
    }, `${id} 停止后没有结算`);
  };

  // ── 定时到点不越过前项(第 8 轮审查拦验收 1)─────────────────────────────────
  // 队列 [gA(running), gB(failed)],gB 挂到期 once:到点 tick 时前项在跑 → 不启动、
  // **不消费班次**(enabled 保持、lastRunAt 不写);前项结束后的下一个 tick 才启动并消费。
  const gA = "scheduled-single-gate-a";
  const gB = "scheduled-single-gate-b";
  await db.insert(tasks).values([
    { ...taskRow(gA, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
    { ...taskRow(gB, "claude", "idle"), mode: "single", team: null, status: "failed", body: "保持运行等待引导" },
  ]);
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue", taskId: gA, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue", taskId: gB, position: 1, createdAt: at },
  ]);
  await db.insert(schedules).values({
    id: "scheduled-gate-once", taskId: gB, kind: "once",
    at: new Date(Date.now() - 1000).toISOString(), cron: null, enabled: true, lastRunAt: null, createdAt: at,
  });
  const onceRow = async () => (await db.select().from(schedules).where(eq(schedules.id, "scheduled-gate-once"))).at(0)!;
  assert.equal((await api.request(`/tasks/${gA}/run`, { method: "POST" })).status, 202, "前项 gA 应能启动");
  await waitFor(async () => (await taskStatusOf(gA)) === "running", "前项 gA 没有跑起来");
  await schedulesModule.tick();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await taskStatusOf(gB), "failed", "前项在跑,到点的 gB 不得启动(第 8 轮审查:到点越过队列)");
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, gB))).length, 0, "gB 不得开任何回合");
  assert.equal((await onceRow()).enabled, true, "被队列挡住的班次不得被禁用");
  assert.equal((await onceRow()).lastRunAt, null, "被队列挡住的班次不得计作已跑");
  // 前项结束(真实 stopTask 杀进程 → 结算)→ 下一个 tick 启动并消费班次。
  await stopWhenLive(gA);
  await schedulesModule.tick();
  await waitFor(async () => (await taskStatusOf(gB)) === "running", "前项结束后,到期班次没有把 gB 跑起来");
  assert.equal((await onceRow()).enabled, false, "真的开跑了,once 班次才消费");
  assert.ok((await onceRow()).lastRunAt, "真的开跑了才写 lastRunAt");
  await stopWhenLive(gB);
  console.log("✓ 定时到点过队列认领:前项在跑不启动不消费班次,前项结束后启动并消费");

  // ── 提问答复不越过前项(第 8 轮审查拦验收 2)─────────────────────────────────
  // 队列 [gC(running), gD(paused+question)]:发送答复 → 答复持久化、问题清掉,但续跑
  // 必须等前项;答复落成执行型待发送消息进托盘,前项结束后作为首轮输入送达恰好一次。
  const gC = "scheduled-single-gate-c";
  const gD = "scheduled-single-gate-d";
  const gDAnswer = "采用新方案(answer-gate),但保持运行等待引导";
  await db.insert(tasks).values([
    { ...taskRow(gC, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
    { ...taskRow(gD, "claude", "paused"), mode: "single", team: null, question: "接下来采用新方案还是旧方案？" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-d-prev", taskId: gD, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-d-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-2", taskId: gC, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-2", taskId: gD, position: 1, createdAt: at },
  ]);
  assert.equal((await api.request(`/tasks/${gC}/run`, { method: "POST" })).status, 202, "前项 gC 应能启动");
  await waitFor(async () => (await taskStatusOf(gC)) === "running", "前项 gC 没有跑起来");
  const answerRes = await api.request(`/tasks/${gD}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: gDAnswer }),
  });
  assert.equal(answerRes.status, 200, "排在后面的提问任务,答复应被接住而不是拒绝");
  const answerBody = await answerRes.json() as { answered: boolean; queued?: boolean; blockedBy?: string[] };
  assert.equal(answerBody.queued, true, "前项在跑,答复应报告排队等待而不是已续跑");
  assert.ok(answerBody.blockedBy?.includes(gC), "等待答复应指出挡路的前项");
  const gDRow = async () => (await db.select().from(tasks).where(eq(tasks.id, gD))).at(0)!;
  assert.equal((await gDRow()).question, null, "答复已持久化,问题应当清掉");
  assert.ok((await gDRow()).questionHistory?.includes("answer-gate"), "答复记录必须进历史,刷新后可见");
  const gDMsg = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.taskId, gD))).at(0);
  assert.equal((await gDMsg())?.execution, true, "等待中的答复必须落成执行型待发送消息");
  assert.equal((await gDMsg())?.status, "pending", "等待中的答复必须留在托盘里");
  // 前项在跑的整个窗口:显式扫描也不得穿透,gD 不得被拉起。
  await pending.deliverPendingMessages(gD);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await taskStatusOf(gD), "paused", "前项在跑,答复不得把 gD 续跑起来(第 8 轮审查:答复越过队列)");
  assert.equal(countIn(leadLog, gDAnswer), 0, "前项在跑期间答复原文不该进任何 stdin");
  // 前项结束 → 答复作为首轮输入送达恰好一次。
  await stopWhenLive(gC);
  await waitFor(async () => (await gDMsg())?.status === "sent", "前项结束后答复没有投递");
  await waitFor(() => countIn(leadLog, gDAnswer) > 0, "答复标了 sent,stdin 里却没有原文");
  await waitFor(async () => (await taskStatusOf(gD)) === "running", "答复送达后 gD 应在运行");
  await stopWhenLive(gD);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, gDAnswer), 1, "同一条答复被投递了不止一次");

  // 没被挡的提问任务(不在队列/前项已让位):答复仍然立即续跑,行为不回归。
  const gE = "scheduled-single-gate-e";
  const gEAnswer = "独立任务立即续跑(answer-gate-free),保持运行等待引导";
  await db.insert(tasks).values([
    { ...taskRow(gE, "claude", "paused"), mode: "single", team: null, question: "现在继续吗？" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-e-prev", taskId: gE, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-e-cli", startedAt: at,
  });
  const freeRes = await api.request(`/tasks/${gE}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: gEAnswer }),
  });
  assert.equal(freeRes.status, 200, "独立提问任务的答复应被接住");
  assert.equal((await freeRes.json() as { queued?: boolean }).queued, undefined, "没人挡路就不该报排队");
  await waitFor(() => countIn(leadLog, gEAnswer) > 0, "独立任务的答复没有立即续跑进会话");
  await waitFor(async () => (await taskStatusOf(gE)) === "running", "答复送达后 gE 应在运行");
  await stopWhenLive(gE);
  console.log("✓ 提问答复过队列认领:前项在跑时答复落托盘等待,结束后首轮送达一次;独立任务照旧立即续跑");

  // ── 旁路答复不占位:队列中已完成任务的审查提问(第 9 轮审查拦验收)──────────────
  // 队列 [gF(done), gG(done)],gF 的提问来自 reviewer 会话:答复续跑是旁路回合,不是
  // 任务的执行 —— 不得过队列认领落 queued,否则 orchestrator 读不到原终态,followUpFrom
  // 写成 null,停止这轮审查会把 done 结算成 canceled(审查实测:队列场景 stop 后变
  // 已取消,不在队列的对照保持 done)。
  const gF = "scheduled-single-gate-f";
  const gG = "scheduled-single-gate-g";
  const gFAnswer = "请覆盖取消与恢复(review-gate);只继续审查,保持运行等待引导";
  await db.insert(tasks).values([
    { ...taskRow(gF, "claude", "done"), mode: "single", team: null, question: "审查时希望覆盖哪些失败路径？" },
    { ...taskRow(gG, "claude", "done"), mode: "single", team: null },
  ]);
  // 提问者是审查旁路会话(role=reviewer):askingAgentFor 按最近回合选中它。
  await db.insert(sessions).values({
    id: "scheduled-gate-f-reviewer", taskId: gF, role: "reviewer", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-f-reviewer-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-3", taskId: gF, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-3", taskId: gG, position: 1, createdAt: at },
  ]);
  const reviewRes = await api.request(`/tasks/${gF}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: gFAnswer }),
  });
  assert.equal(reviewRes.status, 200, "审查提问的答复应被接住");
  assert.equal((await reviewRes.json() as { queued?: boolean }).queued, undefined, "旁路答复不走队列认领,不该报排队");
  await waitFor(() => countIn(leadLog, gFAnswer) > 0, "审查答复没有直送进审查会话");
  await waitFor(async () => (await taskStatusOf(gF)) === "running", "答复送达后审查续跑应在运行");
  const gFRow = (await db.select().from(tasks).where(eq(tasks.id, gF))).at(0)!;
  assert.equal(gFRow.followUpFrom, "done", "旁路答复必须保住原终态 —— 占位落 queued 会把 followUpFrom 吃成 null");
  await stopWhenLive(gF);
  assert.equal(await taskStatusOf(gF), "done", "停止这轮审查后任务必须回到原来的「已完成」,不是已取消");
  assert.equal(
    (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, gF))).length,
    0, "旁路答复不该在托盘留下执行型消息",
  );
  console.log("✓ 旁路答复不占位:队列中 done 任务答复审查提问,直送续跑、停止后仍是已完成");

  // ── 直接回复与手动运行并发(第 ln9Q6IJEgmWf 链第 1 轮拦验收 1)──────────────────
  // 队列 [hA(failed), hB(backlog)],hB 此刻没有挡路成员(hA 已让位):并发发出
  // POST /tasks/hB/reply(新的执行要求)与 POST /tasks/hA/run。修复前回复分支只在
  // 早期 queueBlockers 读到阻挡时暂存,否则直接 continueTask —— 两路各自读到「整队
  // 空闲」,10/10 同队双跑。修复后两路争同一个队列认领:谁先占到谁跑,另一方按自己
  // 的语义让行(回复 → 暂存执行型待发送;运行 → 409)。
  const hA = "scheduled-single-gate-ha";
  const hB = "scheduled-single-gate-hb";
  const hBText = "新的执行要求(reply-run-race):保持运行等待引导";
  await db.insert(tasks).values([
    { ...taskRow(hA, "claude", "idle"), mode: "single", team: null, status: "failed", body: "保持运行等待引导" },
    { ...taskRow(hB, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-4", taskId: hA, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-4", taskId: hB, position: 1, createdAt: at },
  ]);
  const [replyRes, runRes] = await Promise.all([
    api.request(`/tasks/${hB}/reply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: hBText }),
    }),
    api.request(`/tasks/${hA}/run`, { method: "POST" }),
  ]);
  assert.equal(replyRes.status, 202, "回复应被接住(直送或暂存都 202)");
  const replyBody = await replyRes.json() as { started?: boolean; scheduled?: boolean };
  const hMsgRows = async () => db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, hB));
  if (runRes.status === 202) {
    // /run 先占到:hA 起跑;hB 的回复必须已暂存为执行型待发送,hB 不得启动。
    assert.equal(replyBody.scheduled, true, "/run 占到位时,回复必须暂存而不是直送起跑");
    await waitFor(async () => (await taskStatusOf(hA)) === "running", "占到位的 hA 没有跑起来");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await taskStatusOf(hB), "backlog", "hA 在跑,hB 不得被回复拉起 —— 同队双跑");
    assert.equal((await hMsgRows()).at(0)?.execution, true, "暂存的回复必须是执行型");
    assert.equal(countIn(leadLog, hBText), 0, "hA 在跑期间回复原文不该进 stdin");
    await stopWhenLive(hA);
    // hA 让位 → 回复作为 hB 的首轮输入送达恰好一次。
    await waitFor(async () => (await hMsgRows()).at(0)?.status === "sent", "hA 让位后回复没有投递");
  } else {
    // 回复先占到:hB 直送起跑;/run 必须 409,hA 保持 failed、零回合。
    assert.equal(runRes.status, 409, `回复占到位时 /run 应 409,实际 ${runRes.status}`);
    assert.equal(replyBody.started, true, "没人挡路时回复应直送起跑");
    assert.equal(await taskStatusOf(hA), "failed", "被挡回的 hA 必须保持 failed");
    assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, hA))).length, 0, "被挡回的 hA 不得开回合");
  }
  await waitFor(() => countIn(leadLog, hBText) > 0, "回复标了送出,stdin 里却没有原文");
  await waitFor(async () => (await taskStatusOf(hB)) === "running", "回复送达后 hB 应在运行");
  {
    const [sA, sB] = [await taskStatusOf(hA), await taskStatusOf(hB)];
    assert.ok(!((sA === "running" || sA === "queued") && (sB === "running" || sB === "queued")),
      "同一队列两个成员同时在跑");
  }
  await stopWhenLive(hB);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, hBText), 1, "同一条回复被投递了不止一次");
  console.log("✓ 回复与运行并发:争同一个队列认领,至多一项执行,回复让位后恰好送达一次");
}
