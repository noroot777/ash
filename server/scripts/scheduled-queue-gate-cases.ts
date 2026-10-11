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

  // ── 队列内 checkpoint 追问不占认领(第 ln9Q6IJEgmWf 链第 2 轮拦验收)──────────────
  // 队列 [iA(paused+resumePrompt, 队首无阻挡), iB(backlog)]:对 iA 发「怎么样了?」。
  // 追问是旁路续聊(orchestrator checkpointFollowUp:followUpFrom 护回 paused、不消费
  // 继续指令),不是执行 —— 修复前它被套进认领分支,paused 先翻成 queued,orchestrator
  // 读不到 paused 就把追问当执行回合:消费检查点、无确认结算 failed、队列按失败跳过
  // 放行 iB(审查真实页面复现)。
  const iA = "scheduled-single-gate-ia";
  const iB = "scheduled-single-gate-ib";
  const iAPrompt = "等上游完成后继续正式步骤(ckpt-head)";
  const iAQuery = "怎么样了？(ckpt-head-query)";
  await db.insert(tasks).values([
    { ...taskRow(iA, "claude", "paused"), mode: "single", team: null, resumePrompt: iAPrompt },
    { ...taskRow(iB, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-ia-prev", taskId: iA, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-ia-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-5", taskId: iA, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-5", taskId: iB, position: 1, createdAt: at },
  ]);
  const iARes = await api.request(`/tasks/${iA}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: iAQuery }),
  });
  assert.equal(iARes.status, 202, "checkpoint 追问应被接住");
  assert.equal((await iARes.json() as { started?: boolean }).started, true, "追问是旁路续聊,应直送而不是暂存");
  await waitFor(() => countIn(leadLog, iAQuery) > 0, "追问原文没有进会话");
  // 追问回合结算后:保持暂停、继续指令原封不动、后项没有被放行。
  await waitFor(async () => (await taskStatusOf(iA)) === "paused", "追问结束后 iA 必须恢复 paused,而不是 failed");
  const iARow = (await db.select().from(tasks).where(eq(tasks.id, iA))).at(0)!;
  assert.equal(iARow.resumePrompt, iAPrompt, "普通追问不得吞掉检查点的继续指令");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await taskStatusOf(iB), "backlog", "追问不得把后项放行(第 2 轮审查:错误放行后项)");
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, iB))).length, 0, "后项不得开任何回合");
  assert.equal(
    (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, iA))).length,
    0, "追问不该被暂存成托盘消息",
  );
  console.log("✓ 队列内 checkpoint 追问:保持暂停与继续指令,后项不被放行");

  // ── 有阻挡翼:前项在跑时的 checkpoint 追问照旧直送旁路 ───────────────────────────
  // 队列 [iC(running), iD(paused+resumePrompt)]:追问不被暂存成执行型(修复前
  // queueWhileWaiting 会把它收进托盘,等前项让位后按执行回合投递,同样消费检查点)。
  // 前项让位后,检查点由**队列推进**的续跑消费 —— 那才是任务的执行。
  const iC = "scheduled-single-gate-ic";
  const iD = "scheduled-single-gate-id";
  const iDPrompt = "继续正式步骤(ckpt-blocked);保持运行等待引导";
  const iDQuery = "进展如何？(ckpt-blocked-query)";
  await db.insert(tasks).values([
    { ...taskRow(iC, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
    { ...taskRow(iD, "claude", "paused"), mode: "single", team: null, resumePrompt: iDPrompt },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-id-prev", taskId: iD, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-id-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-6", taskId: iC, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-6", taskId: iD, position: 1, createdAt: at },
  ]);
  assert.equal((await api.request(`/tasks/${iC}/run`, { method: "POST" })).status, 202, "前项 iC 应能启动");
  await waitFor(async () => (await taskStatusOf(iC)) === "running", "前项 iC 没有跑起来");
  const iDRes = await api.request(`/tasks/${iD}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: iDQuery }),
  });
  assert.equal(iDRes.status, 202, "前项在跑时的 checkpoint 追问应被接住");
  assert.equal((await iDRes.json() as { started?: boolean }).started, true, "追问是旁路,前项在跑也直送,不暂存执行型");
  await waitFor(() => countIn(leadLog, iDQuery) > 0, "有阻挡的追问原文没有进会话");
  await waitFor(async () => (await taskStatusOf(iD)) === "paused", "追问结束后 iD 必须恢复 paused");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, iD))).at(0)!.resumePrompt, iDPrompt,
    "有阻挡的追问同样不得吞掉继续指令",
  );
  assert.equal(
    (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, iD))).length,
    0, "追问不得落成执行型待发送消息",
  );
  // 前项让位 → 队列推进用继续指令续跑 iD:检查点只被真正的执行消费。
  await stopWhenLive(iC);
  await waitFor(async () => (await taskStatusOf(iD)) === "running", "前项让位后队列推进没有续跑 iD");
  await waitFor(() => countIn(leadLog, "ckpt-blocked") > 0, "续跑没有用检查点的继续指令作输入");
  await waitFor(async () =>
    (await db.select().from(tasks).where(eq(tasks.id, iD))).at(0)!.resumePrompt === null,
  "队列推进的续跑应消费检查点");
  await stopWhenLive(iD);
  console.log("✓ 有阻挡的 checkpoint 追问:直送旁路不暂存,检查点只被队列推进的续跑消费");

  // ── 前项在追问期间让位:交接补办(第 ln9Q6IJEgmWf 链第 3 轮拦验收)──────────────
  // 队列 [jA(running), jB(paused+resumePrompt), jC(backlog)]:对 jB 追问并让追问回合
  // 悬住;期间 jA 让位 —— 那次推进被 jB 的旁路 running 冻结,jB 结算又是 quiet 恢复,
  // 修复前这次真实发生的让位就蒸发了:jB 永远停在 paused 等手点(审查真实页面复现)。
  // 修复后推进被旁路回合冻结时记欠账(queue-seat.ts),jB 的追问一结束就补办:jB 被
  // 队列推进自动续跑、消费检查点;jC 排在后面不被越过。
  const jA = "scheduled-single-gate-ja";
  const jB = "scheduled-single-gate-jb";
  const jC = "scheduled-single-gate-jc";
  const jBPrompt = "继续正式步骤(ckpt-handover);保持运行等待引导";
  const jBQuery = "怎么样了？(ckpt-handover-query)保持运行等待引导";
  await db.insert(tasks).values([
    { ...taskRow(jA, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
    { ...taskRow(jB, "claude", "paused"), mode: "single", team: null, resumePrompt: jBPrompt },
    { ...taskRow(jC, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-jb-prev", taskId: jB, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-jb-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-7", taskId: jA, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-7", taskId: jB, position: 1, createdAt: at },
    { queueId: "scheduled-gate-queue-7", taskId: jC, position: 2, createdAt: at },
  ]);
  assert.equal((await api.request(`/tasks/${jA}/run`, { method: "POST" })).status, 202, "前项 jA 应能启动");
  await waitFor(async () => (await taskStatusOf(jA)) === "running", "前项 jA 没有跑起来");
  // 追问文本带常驻关键词:旁路回合悬住,给「前项先结束」的交错留出确定性窗口。
  const jBRes = await api.request(`/tasks/${jB}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: jBQuery }),
  });
  assert.equal(jBRes.status, 202, "追问应被接住");
  await waitFor(() => countIn(leadLog, jBQuery) > 0, "追问原文没有进会话");
  await waitFor(async () => (await taskStatusOf(jB)) === "running", "追问旁路回合应在运行");
  // 前项在追问悬着的时候让位(真实 stopTask → 结算 → 推进被 jB 的 running 冻结)。
  await stopWhenLive(jA);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await taskStatusOf(jB), "running", "追问回合不该被前项让位打断");
  // 追问回合结束 → 恢复 paused → 补办欠下的推进:jB 必须被自动续跑,不等手点。
  assert.equal(runs.stopTask(jB), true, "测试前提:jB 的追问回合应能结束");
  await waitFor(async () => {
    const row = (await db.select().from(tasks).where(eq(tasks.id, jB))).at(0)!;
    return row.status === "running" && row.resumePrompt === null;
  }, "前项已让位,追问结束后 jB 没有被自动续跑(交接被吞)");
  await waitFor(() => countIn(leadLog, "ckpt-handover") > 1, "自动续跑没有用检查点的继续指令作输入");
  assert.equal(await taskStatusOf(jC), "backlog", "jB 在跑,jC 不得被越过启动");
  await stopWhenLive(jB);
  // jB 的 stop 是终态让位,会连锁启动 jC(这正是正常推进)——一并收尾。
  await stopWhenLive(jC);
  console.log("✓ 前项在追问期间让位:欠账补办,追问结束后检查点任务自动续跑,末项不被越过");

  // ── 挑中成员旧回合锁未释放:不落 queued,释放后补办(第 4 轮审查问题 1)────────────
  // 队列 [kA(done), kB(paused+resumePrompt), kC(backlog)],kB 的旧回合锁还被占着
  // (真实场景:追问刚恢复 paused、结算还在收尾)。此刻的推进若写 queued 再续跑,
  // 会被 turn-entry-guard 挡回且无人回滚 —— kB 永久显示「排队中」、继续按钮不可点
  // (审查真实页面复现)。修复后:挑中但锁没释放 → 不落位、记账;释放即补办续跑。
  const kA = "scheduled-single-gate-ka";
  const kB = "scheduled-single-gate-kb";
  const kC = "scheduled-single-gate-kc";
  const kBPrompt = "继续正式步骤(ckpt-turnheld);保持运行等待引导";
  await db.insert(tasks).values([
    { ...taskRow(kA, "claude", "done"), mode: "single", team: null },
    { ...taskRow(kB, "claude", "paused"), mode: "single", team: null, resumePrompt: kBPrompt },
    { ...taskRow(kC, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-kb-prev", taskId: kB, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-kb-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-8", taskId: kA, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-8", taskId: kB, position: 1, createdAt: at },
    { queueId: "scheduled-gate-queue-8", taskId: kC, position: 2, createdAt: at },
  ]);
  const scheduler = await import("../src/scheduler.js");
  assert.equal(runs.claimTurn(kB), true, "测试前提:应能占住 kB 的回合锁模拟结算收尾");
  await scheduler.advanceQueue("scheduled-gate-queue-8");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await taskStatusOf(kB), "paused", "旧回合锁未释放时推进不得把 kB 写成 queued(第 4 轮:卡排队中)");
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, kB))).length, 1, "锁未释放时不得开新回合");
  // 释放旧锁 = 结算收尾完成:挂着的补办回调立即重推,kB 被正常挑中续跑。
  runs.releaseTurn(kB);
  await waitFor(async () => {
    const row = (await db.select().from(tasks).where(eq(tasks.id, kB))).at(0)!;
    return row.status === "running" && row.resumePrompt === null;
  }, "回合锁释放后欠账没有补办,kB 没被自动续跑");
  await waitFor(() => countIn(leadLog, "ckpt-turnheld") > 0, "补办续跑没有用检查点指令作输入");
  assert.equal(await taskStatusOf(kC), "backlog", "kB 在跑,kC 不得被越过");
  await stopWhenLive(kB);
  await stopWhenLive(kC); // kB 终态让位连锁启动 kC,一并收尾
  console.log("✓ 旧回合锁未释放:推进不落 queued,锁释放后补办续跑,无排队中残留");

  // ── 让位与追问结束任意交错:交接不丢(第 4 轮审查问题 2 的并发覆盖)────────────────
  // [lA(running), lB(paused+ckpt 追问悬住)]:同时停掉两者,让 lA 的让位推进与 lB 的
  // 「清旁路身份 → 恢复 paused」结算以任意顺序交错。无论推进读到哪一侧,都必须最终
  // 把 lB 自动续跑 —— 清身份与恢复状态已包进认领临界区,中间不存在「running 且无旁路
  // 身份」的裸窗口(修复前该窗口让推进既冻结又不记账,交接蒸发)。
  const lA = "scheduled-single-gate-la";
  const lB = "scheduled-single-gate-lb";
  const lBPrompt = "继续正式步骤(ckpt-interleave);保持运行等待引导";
  await db.insert(tasks).values([
    { ...taskRow(lA, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
    { ...taskRow(lB, "claude", "paused"), mode: "single", team: null, resumePrompt: lBPrompt },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-lb-prev", taskId: lB, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-lb-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-9", taskId: lA, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-9", taskId: lB, position: 1, createdAt: at },
  ]);
  assert.equal((await api.request(`/tasks/${lA}/run`, { method: "POST" })).status, 202, "前项 lA 应能启动");
  await waitFor(async () => (await taskStatusOf(lA)) === "running", "前项 lA 没有跑起来");
  const lBQuery = "进展如何？(ckpt-interleave-query)保持运行等待引导";
  assert.equal((await api.request(`/tasks/${lB}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: lBQuery }),
  })).status, 202, "追问应被接住");
  await waitFor(() => countIn(leadLog, lBQuery) > 0, "追问原文没有进会话");
  await waitFor(() => runs.isRunning(lA) && runs.isRunning(lB), "两个回合没有同时在跑");
  // 同一瞬间:前项让位 + 追问结束,结算与推进任意交错。
  assert.equal(runs.stopTask(lA), true);
  assert.equal(runs.stopTask(lB), true);
  await waitFor(async () => {
    const row = (await db.select().from(tasks).where(eq(tasks.id, lB))).at(0)!;
    return row.status === "running" && row.resumePrompt === null;
  }, "让位与追问结束交错后,lB 没有被自动续跑(交接被吞)");
  await waitFor(() => countIn(leadLog, "ckpt-interleave") > 1, "交错后的续跑没有用检查点指令作输入");
  await stopWhenLive(lB);
  console.log("✓ 让位与追问结束任意交错:交接不丢,检查点任务自动续跑");

  // ── 推进与追问争回合所有权(第 5 轮审查拦验收)─────────────────────────────────────
  // [mA(done), mB(paused+resumePrompt), mC(backlog)]:队列推进(前项早已让位)与对 mB
  // 的普通追问并发。修复前推进只「观察」isTurnClaimed,检查到落 queued 之间追问能抢走
  // 回合:推进把追问覆盖成 queued、正式续跑被挡、追问结算恢复 paused,交接蒸发。修复
  // 后推进在临界区里 claimTurn 原子认领、带 turnHeld 续跑:谁先占到谁跑 —— 推进先占,
  // 追问被单飞锁挡回、按普通消息暂存稍后送达;追问先占,推进记欠账、追问结束即补办。
  // 两种交错的终局不变量相同:mB 自动续跑消费检查点,追问原文恰好送达一次。
  const mA = "scheduled-single-gate-ma";
  const mB = "scheduled-single-gate-mb";
  const mC = "scheduled-single-gate-mc";
  const mBPrompt = "继续正式步骤(ckpt-claimrace);保持运行等待引导";
  const mBQuery = "怎么样了？(ckpt-claimrace-query)";
  await db.insert(tasks).values([
    { ...taskRow(mA, "claude", "done"), mode: "single", team: null },
    { ...taskRow(mB, "claude", "paused"), mode: "single", team: null, resumePrompt: mBPrompt },
    { ...taskRow(mC, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-gate-mb-prev", taskId: mB, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-gate-mb-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-gate-queue-10", taskId: mA, position: 0, createdAt: at },
    { queueId: "scheduled-gate-queue-10", taskId: mB, position: 1, createdAt: at },
    { queueId: "scheduled-gate-queue-10", taskId: mC, position: 2, createdAt: at },
  ]);
  const [, mBRes] = await Promise.all([
    scheduler.advanceQueue("scheduled-gate-queue-10"),
    api.request(`/tasks/${mB}/reply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: mBQuery }),
    }),
  ]);
  assert.equal(mBRes.status, 202, "并发追问应被接住(直送或暂存都 202)");
  // 终局不变量:无论谁先占到回合,mB 都被自动续跑、检查点被消费,不卡 paused/queued。
  await waitFor(async () => {
    const row = (await db.select().from(tasks).where(eq(tasks.id, mB))).at(0)!;
    return row.status === "running" && row.resumePrompt === null;
  }, "推进与追问并发后 mB 没有被自动续跑(交接被吞或卡排队中)");
  await waitFor(() => countIn(leadLog, "(ckpt-claimrace)") > 0, "续跑没有用检查点指令作输入");
  assert.equal(await taskStatusOf(mC), "backlog", "mB 在跑,mC 不得被越过");
  await stopWhenLive(mB);
  // 追问若被暂存(推进先占),mB 结算后由待发送链路作为续聊送达;直送(追问先占)则早已送达。
  await waitFor(() => countIn(leadLog, mBQuery) > 0, "追问原文始终没有送达");
  await waitFor(async () => !["running", "queued"].includes(await taskStatusOf(mB)), "追问续聊回合没有结算");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(countIn(leadLog, mBQuery), 1, "追问原文被投递了不止一次");
  await stopWhenLive(mC); // mB 终态让位连锁启动 mC,一并收尾
  console.log("✓ 推进与追问争回合所有权:任意交错 mB 自动续跑,追问恰好送达一次");
}
