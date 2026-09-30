// 「引导会话」那一组用例:硬切旧回合 + Claude 原生 interrupt/send + 验收挡回 +
// 旧方向迟到的工具调用。
//
// 从 `test-scheduled-messages.ts` 里搬出来,原因只有一个:那份已经顶到 700 行的上限,
// 再往里加用例就得先拆。切在这里是因为这一组问的是 **task-steer.ts 的行为**(截断当前
// 回合、旋转方向身份、失败时归还租约),跟「消息怎么排队、什么时候投递」是两件事 ——
// 投递链路那几条仍留在原文件里,挨着它们各自的判定逻辑。
//
// 共享句柄走参数进来(计时基准 `at`、`waitFor`、`messageRow`、两个 bus 事件收集数组
// 和任务 id),模块则在函数里**动态 import**:`ASH_DB` 要等主脚本设好才能碰 db 单例,
// 顶层 import 会在那之前就把库开在错的地方。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { parseSessionOutput } from "@ash/shared";
import type { scheduledMessages as scheduledMessagesTable } from "../src/db/schema.js";

export type SteerCaseContext = {
  /** 测试基准时刻(ISO),跟主脚本用同一个值。 */
  at: string;
  waitFor: (predicate: () => boolean | Promise<boolean>, message: string) => Promise<void>;
  messageRow: (
    id: string,
    taskId: string,
    text: string,
    mode?: "timed" | "queued",
  ) => typeof scheduledMessagesTable.$inferInsert;
  statusEvents: Array<{ taskId: string; status: string }>;
  agentEvents: Array<{ taskId: string; event: { kind: string; exitStatus?: number; text?: string } }>;
  steerTaskId: string;
  steerLockedTaskId: string;
  steerUnavailableTaskId: string;
  steerLateTaskId: string;
};

export async function runSteerCases(ctx: SteerCaseContext): Promise<void> {
  const { at, waitFor, messageRow, statusEvents, agentEvents } = ctx;
  const { steerTaskId, steerLockedTaskId, steerLateTaskId, steerUnavailableTaskId } = ctx;
  const [{ db }, schema, runs, steer, orchestrator, transcript, acceptance, runRoutes] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/runs.js"),
    import("../src/task-steer.js"),
    import("../src/orchestrator.js"),
    import("../src/transcript.js"),
    import("../src/acceptance-lock.js"),
    import("../src/task-run-routes.js"),
  ]);
  const { scheduledMessages, tasks } = schema;

  // ── 引导会话:默认排队,点按钮后在同一 Claude 进程里 interrupt + send ───────
  const oldRun = orchestrator.continueTask(steerTaskId, "保持运行等待引导");
  await waitFor(() => runs.isRunning(steerTaskId), "旧方向的一次性回合没有进入 running");
  await waitFor(() => agentEvents.some(({ taskId, event }) => taskId === steerTaskId && event.text?.includes("旧方向最后一段正文")), "旧方向正文尚未到达消费层");
  await db.update(tasks).set({
    completeConfirmedAt: at,
    resumePrompt: "旧方向留下的续跑指令",
    question: "旧方向留下的问题",
    questionOptions: JSON.stringify(["旧答案"]),
  }).where(eq(tasks.id, steerTaskId));
  runs.confirmDone(steerTaskId); // 旧方向刚拿到的完成票也不能穿进新方向
  await db.insert(scheduledMessages).values(
    messageRow("scheduled-steer", steerTaskId, "先停下旧方案，改做更稳妥的新方向", "queued"),
  );
  const statusEventStart = statusEvents.length;
  const agentEventStart = agentEvents.length;

  const steered = await steer.steerQueuedMessage("scheduled-steer");
  assert.equal(steered.ok, true, "活动单飞回合上的 queued 消息应能升级为引导");
  assert.equal(await oldRun, true, "旧回合应由原 run loop 完整接管并受控收口");
  const steeringAgentEvents = agentEvents.slice(agentEventStart).filter((event) => event.taskId === steerTaskId);
  assert.equal(
    steeringAgentEvents.some(({ event }) => event.kind === "done" && (event.exitStatus ?? 0) !== 0),
    false,
    "原生引导的中间 interrupt 不得向 SSE 发布红色 done 边界",
  );
  assert.equal(
    steeringAgentEvents.some(({ event }) => event.kind === "system" && event.text?.includes("当前回合已由")),
    false,
    "原生引导不应伪装成旧回合结束后重启",
  );
  const steeringStatuses = statusEvents.slice(statusEventStart).filter((event) => event.taskId === steerTaskId);
  assert.equal(steeringStatuses.filter((event) => event.status !== "running").length, 1,
    `同一活动回合只允许最终结算一次，实际事件：${JSON.stringify(steeringStatuses)}`);
  const steeredMessage = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-steer"))).at(0)!;
  assert.equal(steeredMessage.status, "sent", "新方向真正落进会话后才标 sent");
  assert.equal(steeredMessage.deliveringSince, null, "成功引导后应清掉投递租约");
  const steeredTask = (await db.select().from(tasks).where(eq(tasks.id, steerTaskId))).at(0)!;
  assert.equal(steeredTask.completeConfirmedAt, null, "旧方向的完成确认不得污染新方向");
  assert.equal(steeredTask.resumePrompt, null, "旧方向的 pause 指令不得污染新方向");
  assert.equal(steeredTask.question, null, "旧方向的提问不得污染新方向");
  assert.equal(runs.takeConfirmed(steerTaskId), false, "旧方向的内存完成票也应清掉");
  const steerTranscript = transcript.sessionTranscriptPath(steerTaskId, "scheduled-steer-session");
  await waitFor(
    () => existsSync(steerTranscript)
      && readFileSync(steerTranscript, "utf8").includes("先停下旧方案，改做更稳妥的新方向"),
    "引导消息没有落回旧 CLI 会话对应的同一条 session 时间线",
  );
  assert.match(readFileSync(steerTranscript, "utf8"), /先停下旧方案，改做更稳妥的新方向/,
    "引导消息应落回旧 CLI 会话对应的同一条 session 时间线");
  assert.doesNotMatch(readFileSync(steerTranscript, "utf8"), /当前回合已由“引导会话”结束/,
    "原生引导不应写入一次假的回合结束边界");
  const steeredOutput = parseSessionOutput(readFileSync(steerTranscript, "utf8"));
  const steeredUser = steeredOutput.find((segment) => segment.kind === "user" && segment.text.includes("先停下旧方案"));
  assert.ok(steeredUser?.at, "引导消息必须带精确用户边界时间");
  const steerTrace = transcript.parseSessionTrace(
    readFileSync(transcript.sessionTracePath(steerTaskId, "scheduled-steer-session"), "utf8"),
  );
  const oldTextTrace = steerTrace.find((entry) => entry.event.kind === "text" && entry.event.text.includes("旧方向最后一段正文"));
  assert.ok(oldTextTrace, "旧方向最后一段正文必须进入结构化 trace");
  assert.ok(Date.parse(oldTextTrace.at) < Date.parse(steeredUser!.at!), "旧方向正文必须在用户边界前 flush");
  await waitFor(
    async () => {
      const current = (await db.select().from(tasks).where(eq(tasks.id, steerTaskId))).at(0)!;
      return current.status !== "running" && current.status !== "queued";
    },
    "引导出去的新回合没有结算",
  );
  console.log("✓ 引导会话:Claude 同进程 interrupt + send,清旧状态并在落盘后标 sent");

  // 活动 handle 不存在(启动缝隙/刚好结束)时不谎报成功，更不能把消息从队列拿走。
  const unavailableSteer = await steer.steerQueuedMessage("scheduled-steer-unavailable");
  assert.equal(unavailableSteer.ok, false, "没有可控活动进程时应拒绝升级");
  if (!unavailableSteer.ok) {
    assert.match(unavailableSteer.error, /启动|结束|引导/, "无活动回合不得误报成审查或旁路");
    assert.doesNotMatch(unavailableSteer.error, /审查|旁路/);
  }
  const retained = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-steer-unavailable"))).at(0)!;
  assert.equal(retained.status, "pending", "升级失败的消息必须继续留在队列");
  assert.equal(retained.deliveringSince, null, "升级失败必须归还投递租约,允许稍后重试");
  const retainedTaskState = (await db.select().from(tasks).where(eq(tasks.id, steerUnavailableTaskId))).at(0)!;
  assert.equal(retainedTaskState.completeConfirmedAt, at, "没有活动 handle 时不得提前清掉旧回合完成票");
  assert.equal(retainedTaskState.resumePrompt, "仍属于当前回合的检查点", "失败点击不得清掉检查点");
  assert.equal(retainedTaskState.question, "仍属于当前回合的问题", "失败点击不得清掉提问");
  console.log("✓ 引导会话失败:消息保持 pending 并归还租约");

  // 旧回合已跳过结算、但新回合被验收锁挡回：任务必须离开假 running，消息仍 pending。
  const lockedOldRun = orchestrator.continueTask(steerLockedTaskId, "保持运行等待引导");
  await waitFor(() => runs.isRunning(steerLockedTaskId), "验收锁复现的旧回合没有进入 running");
  await db.insert(scheduledMessages).values(
    messageRow("scheduled-steer-locked", steerLockedTaskId, "验收结束后再执行这条新方向", "queued"),
  );
  assert.equal(acceptance.beginAccepting(steerLockedTaskId), true, "测试前提:验收锁应能占住");
  const lockedSteer = await steer.steerQueuedMessage("scheduled-steer-locked");
  acceptance.endAccepting(steerLockedTaskId);
  assert.equal(lockedSteer.ok, false, "续送被验收锁挡回应如实失败");
  assert.equal(runs.isRunning(steerLockedTaskId), true, "验收挡回不应强行切断当前原生回合");
  const lockedSteerMessage = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-steer-locked"))).at(0)!;
  assert.equal(lockedSteerMessage.status, "pending", "续送失败的原话必须继续排队");
  assert.equal(lockedSteerMessage.deliveringSince, null, "续送失败应在落位后归还租约");
  assert.equal(runs.stopTask(steerLockedTaskId), true);
  assert.equal(await lockedOldRun, true);
  console.log("✓ 引导被验收挡回:当前回合不断线，原话保留并归还租约");

  // 真引导成功后新方向仍在跑：旧回合迟到的 ask_question（旧 token 或无 token）都不能写入。
  const lateOldRun = orchestrator.continueTask(steerLateTaskId, "保持运行等待引导");
  await waitFor(() => runs.isRunning(steerLateTaskId), "迟到工具复现的旧回合没有进入 running");
  const oldIdentity = (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!;
  await db.insert(scheduledMessages).values(
    messageRow("scheduled-steer-late", steerLateTaskId, "保持新方向运行", "queued"),
  );
  assert.equal((await steer.steerQueuedMessage("scheduled-steer-late")).ok, true, "迟到工具复现应先成功引导");
  const newIdentity = (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!;
  assert.equal(newIdentity.activeTurnToken, oldIdentity.activeTurnToken, "原生引导必须保留 turn token");
  assert.notEqual(newIdentity.activeDirectionToken, oldIdentity.activeDirectionToken, "引导必须旋转方向 token");
  assert.equal(newIdentity.activeDirectionVersion, 2, "首次引导必须进入第二个方向世代");
  const api = new Hono(); runRoutes.mountTaskRunRoutes(api);
  const ask = (direction?: string) => api.request(`/tasks/${steerLateTaskId}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ash-turn-token": oldIdentity.activeTurnToken!,
      ...(direction ? { "x-ash-direction-token": direction } : {}) },
    body: JSON.stringify({ question: "current question after native steer" }),
  });
  assert.equal((await ask(oldIdentity.activeDirectionToken!)).status, 409, "旧方向迟到提问必须被拒绝");
  assert.equal((await ask()).status, 409, "缺少新方向身份的提问必须被拒绝");
  assert.equal((await ask(newIdentity.activeDirectionToken!)).status, 200, "新方向工具调用应继续有效");
  await db.update(tasks).set({ question: null, questionOptions: null, questionItems: null }).where(eq(tasks.id, steerLateTaskId));
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!.question,
    null,
    "测试收尾前应清掉问题卡",
  );
  assert.equal(runs.stopTask(steerLateTaskId), true, "测试收尾应停止挂起的新方向");
  assert.equal(await lateOldRun, true);
  await waitFor(async () => (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!.status !== "running",
    "挂起的新方向没有完成停止结算");
  console.log("✓ 原生引导保留 turn token、旋转方向 token，旧方向迟到调用被拒绝");
}
