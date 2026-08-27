import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-steer-hardening-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const [
  { db, ensureSchema },
  schema,
  runs,
  steer,
  { bus },
  { mountTaskRunRoutes },
  { mountTaskRoutes },
  { mountTaskStageRoutes },
  { setTaskStatus },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-steer.js"),
  import("../src/bus.js"),
  import("../src/task-run-routes.js"),
  import("../src/task-routes.js"),
  import("../src/task-stage.js"),
  import("../src/status.js"),
]);
const { projects, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();

const at = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "steer", repoPath: root, apiKeys: null, createdAt: at });
const task = (id: string, extra: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id,
  projectId: "p",
  title: id,
  body: "test",
  mode: "single",
  status: "running",
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const message = (
  id: string,
  taskId: string,
  order = at,
): typeof scheduledMessages.$inferInsert => ({
  id,
  taskId,
  text: id,
  attachments: "[]",
  mode: "queued",
  sendAt: order,
  status: "pending",
  createdAt: order,
  sentAt: null,
  deliveringSince: null,
});
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${label}`);
};
const previousQuestion = "要不要改成方案 B？";
const previousQuestionOptions = JSON.stringify(["改成 B", "保留 A"]);
const previousQuestionItems = JSON.stringify([
  { question: "先迁移哪一块？", options: ["API", "UI"] },
]);
const previousResumePrompt = "继续：把 B 方案的迁移脚本写完";

try {
  // 两阶段预约：旧流先结束时必须等 commit；cancel 则回到普通结算，不 kill、不续送。
  assert.equal(runs.claimTurn("reservation", "single"), true);
  let kills = 0;
  let continued = 0;
  const handle = { kill: () => { kills++; } };
  runs.trackRun("reservation", handle);
  const reservation = runs.reserveSteerTask("reservation", () => { continued++; });
  assert.ok(reservation, "活动 handle 应能预约引导");
  let decided = false;
  const decision = runs.takeSteered("reservation").then((value) => {
    decided = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(decided, false, "DB 清理尚未提交时，已结束的旧流必须等待决定");
  assert.equal(reservation.commit(), "committed");
  assert.equal(kills, 1, "提交后才 kill 当前 handle");
  assert.equal(await decision, true, "提交后旧回合跳过普通结算");
  runs.untrackRun("reservation", handle);
  runs.releaseTurn("reservation");
  assert.equal(continued, 1, "释放 turn 后只续送一次");

  assert.equal(runs.claimTurn("reservation-cancel", "single"), true);
  const cancelHandle = { kill: () => { kills++; } };
  runs.trackRun("reservation-cancel", cancelHandle);
  const canceled = runs.reserveSteerTask("reservation-cancel", () => { continued++; });
  assert.ok(canceled);
  const canceledDecision = runs.takeSteered("reservation-cancel");
  canceled.cancel();
  assert.equal(await canceledDecision, false, "撤销预约后旧回合应照常结算");
  runs.untrackRun("reservation-cancel", cancelHandle);
  runs.releaseTurn("reservation-cancel");
  assert.equal(kills, 1, "撤销不得 kill");
  assert.equal(continued, 1, "撤销不得续送");

  assert.equal(runs.claimTurn("reservation-stop", "single"), true);
  const stopHandle = { kill: () => { kills++; } };
  runs.trackRun("reservation-stop", stopHandle);
  let stoppedOutcome: { stopped: "canceled" | "paused" | null; needsSettlement: boolean } | null = null;
  const stoppedReservation = runs.reserveSteerTask("reservation-stop", (outcome) => { stoppedOutcome = outcome; });
  assert.ok(stoppedReservation);
  assert.equal(runs.stopTask("reservation-stop"), true);
  assert.equal(stoppedReservation.commit(), "stopping", "停止发生后预约不得再提交引导");
  assert.equal(await runs.takeSteered("reservation-stop"), false, "停止必须压过 pending 引导决定");
  assert.equal(runs.takeStopped("reservation-stop"), "canceled");
  runs.untrackRun("reservation-stop", stopHandle);
  runs.releaseTurn("reservation-stop");
  assert.deepEqual(stoppedOutcome, { stopped: "canceled", needsSettlement: false });

  assert.equal(runs.claimTurn("reservation-late-stop", "single"), true);
  const lateStopHandle = { kill: () => { kills++; } };
  runs.trackRun("reservation-late-stop", lateStopHandle);
  let lateStopOutcome: { stopped: "canceled" | "paused" | null; needsSettlement: boolean } | null = null;
  const lateStopReservation = runs.reserveSteerTask("reservation-late-stop", (outcome) => { lateStopOutcome = outcome; });
  assert.ok(lateStopReservation);
  assert.equal(lateStopReservation.commit(), "committed");
  assert.equal(await runs.takeSteered("reservation-late-stop"), true);
  assert.equal(runs.stopTask("reservation-late-stop", "paused"), true, "提交后晚到的分组暂停仍须优先");
  runs.untrackRun("reservation-late-stop", lateStopHandle);
  runs.releaseTurn("reservation-late-stop");
  assert.deepEqual(lateStopOutcome, { stopped: "paused", needsSettlement: true });
  assert.equal(runs.takeStopped("reservation-late-stop"), null, "释放回调应消费旧回合漏掉的停止落位");

  assert.equal(runs.claimTurn("reservation-lost", "single"), true);
  const lostHandle = { kill: () => { kills++; } };
  runs.trackRun("reservation-lost", lostHandle);
  let lostDelivered = false;
  const lostReservation = runs.reserveSteerTask("reservation-lost", () => { lostDelivered = true; });
  assert.ok(lostReservation);
  runs.releaseTurn("reservation-lost");
  assert.equal(lostReservation.commit(), "lost", "idle 回调已在 pending 阶段烧掉时必须拒绝假提交");
  assert.equal(await runs.takeSteered("reservation-lost"), false);
  assert.equal(lostDelivered, false, "丢失续送机会后不能无界等待或误报已投递");
  runs.untrackRun("reservation-lost", lostHandle);
  console.log("✓ steering reservation 覆盖自然结束竞态，并支持无副作用撤销");

  await db.insert(tasks).values([
    task("verify", { verifyRound: 1 }),
    task("native", { nativeTurn: true }),
    task("review-task", { reviewOf: "target" }),
    task("reviewer-role"),
    task("ordered"),
    task("claude-native-state", { activeTurnToken: "claude-native-token" }),
    task("codex-native-state", { activeTurnToken: "codex-native-token" }),
    task("stopping", { activeTurnToken: "stopping-token" }),
    task("late-stop-db", {
      activeTurnToken: "late-stop-token",
      completeConfirmedAt: at,
      resumePrompt: previousResumePrompt,
      question: previousQuestion,
      questionOptions: previousQuestionOptions,
      questionItems: previousQuestionItems,
    }),
    task("lost-db", {
      activeTurnToken: "lost-token",
      completeConfirmedAt: at,
      resumePrompt: previousResumePrompt,
      question: previousQuestion,
      questionOptions: previousQuestionOptions,
      questionItems: previousQuestionItems,
    }),
    task("token", { activeTurnToken: "new-token" }),
    task("patch-source", { activeTurnToken: "source-token" }),
    task("patch-target", { activeTurnToken: "target-token" }),
    task("team-patcher", { mode: "team", status: "idle", activeTurnToken: null }),
    task("team-ask", { mode: "team", status: "idle", activeTurnToken: null }),
  ]);
  await db.insert(scheduledMessages).values([
    message("m-verify", "verify"),
    message("m-native", "native"),
    message("m-review-task", "review-task"),
    message("m-reviewer-role", "reviewer-role"),
    message("ordered-a", "ordered"),
    message("ordered-b", "ordered"),
    message("m-claude-native-state", "claude-native-state"),
    message("m-codex-native-state", "codex-native-state"),
    message("m-stopping", "stopping"),
    message("m-late-stop-db", "late-stop-db"),
    message("m-lost-db", "lost-db"),
  ]);
  await db.insert(sessions).values({
    id: "s-stopping",
    taskId: "stopping",
    role: "single",
    agentType: "claude",
    executor: "claude",
    cwd: root,
    startedAt: at,
  });

  for (const [messageId, pattern] of [
    ["m-verify", /验证/],
    ["m-native", /CLI 命令/],
    ["m-review-task", /审查任务/],
  ] as const) {
    const result = await steer.steerQueuedMessage(messageId);
    assert.equal(result.ok, false, `${messageId} 不得被引导`);
    if (!result.ok) assert.match(result.error, pattern);
    const row = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId))).at(0)!;
    assert.equal(row.status, "pending");
    assert.equal(row.deliveringSince, null, "旁路拒绝不得抢消息租约");
  }
  assert.equal(runs.claimTurn("reviewer-role", "reviewer"), true);
  const reviewerResult = await steer.steerQueuedMessage("m-reviewer-role");
  runs.releaseTurn("reviewer-role");
  assert.equal(reviewerResult.ok, false, "自由 reviewer 回合不得被引导");
  if (!reviewerResult.ok) assert.match(reviewerResult.error, /旁路|审查/);
  console.log("✓ 验证、审查、reviewer 与原生命令回合全部留队，不消耗旁路轮次");

  assert.equal(runs.claimTurn("ordered", "single"), true);
  let orderedKills = 0;
  const orderedHandle = { kill: () => { orderedKills++; } };
  runs.trackRun("ordered", orderedHandle);
  const outOfOrder = await steer.steerQueuedMessage("ordered-b");
  assert.equal(outOfOrder.ok, false, "后端必须拒绝绕过 UI 引导较晚消息");
  if (!outOfOrder.ok) assert.match(outOfOrder.error, /排队顺序|最早/);
  assert.equal(orderedKills, 0, "顺序拒绝发生在预约/kill 之前");
  runs.untrackRun("ordered", orderedHandle);
  runs.releaseTurn("ordered");
  console.log("✓ 引导只能消费队首，API 无法把较晚消息反序提前");

  assert.equal(runs.claimTurn("claude-native-state", "single"), true);
  const claudeNativeHandle = {
    kill: () => {},
    steer: async (_text: string, beforeSend?: () => void | Promise<void>) => {
      runs.confirmDone("claude-native-state");
      await db.update(tasks).set({
        completeConfirmedAt: "2026-08-26T11:59:59.000Z",
        resumePrompt: "旧方向迟到的检查点",
        question: "旧方向迟到的问题",
      }).where(eq(tasks.id, "claude-native-state"));
      await beforeSend?.();
      await db.update(tasks).set({ question: "新方向发送后的问题" })
        .where(eq(tasks.id, "claude-native-state"));
    },
  };
  runs.trackRun("claude-native-state", claudeNativeHandle);
  runs.bindNativeSteer("claude-native-state", claudeNativeHandle, { agentType: "claude", record: () => {} });
  assert.equal((await steer.steerQueuedMessage("m-claude-native-state")).ok, true);
  const claudeNativeState = (await db.select().from(tasks)
    .where(eq(tasks.id, "claude-native-state"))).at(0)!;
  assert.equal(claudeNativeState.completeConfirmedAt, null, "interrupt ACK 前旧方向的完成票必须清掉");
  assert.equal(claudeNativeState.resumePrompt, null, "interrupt ACK 前旧方向的检查点必须清掉");
  assert.equal(claudeNativeState.question, "新方向发送后的问题", "ACK 后的新方向状态不得被二次清理");
  assert.equal(runs.takeConfirmed("claude-native-state"), false, "旧方向的内存完成票也必须清掉");
  runs.untrackRun("claude-native-state", claudeNativeHandle);
  runs.releaseTurn("claude-native-state");
  console.log("✓ Claude interrupt ACK 精确隔离旧方向与新方向状态");

  assert.equal(runs.claimTurn("codex-native-state", "single"), true);
  const codexNativeHandle = {
    kill: () => {},
    steer: async () => {
      // Codex 的 turn/steer ACK 后旧工作仍可能继续并合法写入这些字段；投递返回后再
      // 无条件清一次，会把真正发生在 ACK 之后的状态误删。
      await db.update(tasks).set({
        completeConfirmedAt: "2026-08-26T12:00:00.000Z",
        resumePrompt: "ACK 后写入的检查点",
        question: "ACK 后写入的问题",
      }).where(eq(tasks.id, "codex-native-state"));
    },
  };
  runs.trackRun("codex-native-state", codexNativeHandle);
  runs.bindNativeSteer("codex-native-state", codexNativeHandle, {
    agentType: "codex",
    record: () => {},
  });
  const codexNativeResult = await steer.steerQueuedMessage("m-codex-native-state");
  assert.equal(codexNativeResult.ok, true);
  const codexNativeState = (await db.select().from(tasks)
    .where(eq(tasks.id, "codex-native-state"))).at(0)!;
  assert.equal(codexNativeState.completeConfirmedAt, "2026-08-26T12:00:00.000Z");
  assert.equal(codexNativeState.resumePrompt, "ACK 后写入的检查点");
  assert.equal(codexNativeState.question, "ACK 后写入的问题");
  runs.untrackRun("codex-native-state", codexNativeHandle);
  runs.releaseTurn("codex-native-state");
  console.log("✓ Codex steer ACK 后产生的合法完成、检查点与提问不会被二次清理抹掉");

  assert.equal(runs.claimTurn("stopping", "single"), true);
  const stoppingHandle = { kill: () => { kills++; } };
  runs.trackRun("stopping", stoppingHandle);
  assert.equal(runs.stopTask("stopping"), true);
  const stoppingResult = await steer.steerQueuedMessage("m-stopping");
  assert.equal(stoppingResult.ok, false, "已经点停止后不得再接受引导");
  if (!stoppingResult.ok) assert.match(stoppingResult.error, /停止|暂停/);
  const stoppingMessage = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "m-stopping"))).at(0)!;
  assert.equal(stoppingMessage.deliveringSince, null, "停止优先的拒绝不得占消息租约");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "stopping"))).at(0)!.activeTurnToken, "stopping-token");
  assert.match(
    readFileSync(join(root, "runs", "stopping", "s-stopping.md"), "utf8"),
    /引导会话未执行：任务正在停止或所在分组正在暂停，消息继续排队/,
    "停止/暂停抢占引导的原因必须写进会话，刷新后仍可见",
  );
  assert.equal(runs.takeStopped("stopping"), "canceled");
  runs.untrackRun("stopping", stoppingHandle);
  runs.releaseTurn("stopping");

  assert.equal(runs.claimTurn("late-stop-db", "single"), true);
  let lateDbKills = 0;
  const lateDbHandle = { kill: () => { lateDbKills++; } };
  runs.trackRun("late-stop-db", lateDbHandle);
  runs.confirmDone("late-stop-db");
  const lateQuestionEvents: Array<{ question: string | null; questionOptions: unknown; questionItems: unknown }> = [];
  const unsubscribeLateQuestion = bus.subscribe((event) => {
    if (event.type === "task.question" && event.taskId === "late-stop-db") {
      lateQuestionEvents.push({
        question: event.question,
        questionOptions: event.questionOptions,
        questionItems: event.questionItems,
      });
    }
  });
  const lateDbSteer = steer.steerQueuedMessage("m-late-stop-db");
  await waitFor(() => lateDbKills === 1, "引导提交并 kill 旧回合");
  assert.equal(await runs.takeSteered("late-stop-db"), true, "模拟旧回合已读到 committed 引导");
  assert.equal(runs.stopTask("late-stop-db", "paused"), true, "旧回合收尾窗口里的分组暂停应被记录");
  runs.untrackRun("late-stop-db", lateDbHandle);
  runs.releaseTurn("late-stop-db");
  const lateDbResult = await lateDbSteer;
  unsubscribeLateQuestion();
  assert.equal(lateDbResult.ok, false, "晚到停止应让正在等待的引导请求明确失败");
  if (!lateDbResult.ok) assert.match(lateDbResult.error, /暂停|停止/);
  const lateDbTask = (await db.select().from(tasks).where(eq(tasks.id, "late-stop-db"))).at(0)!;
  assert.equal(lateDbTask.status, "paused");
  assert.equal(lateDbTask.question, previousQuestion, "晚到暂停不得吞掉旧提问");
  assert.equal(lateDbTask.questionOptions, previousQuestionOptions);
  assert.equal(lateDbTask.questionItems, previousQuestionItems);
  assert.equal(lateDbTask.resumePrompt, previousResumePrompt, "晚到暂停不得吞掉旧检查点");
  assert.equal(lateDbTask.completeConfirmedAt, at, "晚到暂停不得吞掉旧完成票");
  assert.equal(runs.takeConfirmed("late-stop-db"), true, "内存完成确认也应恢复");
  assert.deepEqual(
    lateQuestionEvents.map((event) => event.question),
    [null, previousQuestion],
    "清掉问题卡后必须广播恢复事件",
  );
  assert.deepEqual(lateQuestionEvents.at(-1)?.questionOptions, JSON.parse(previousQuestionOptions));
  assert.deepEqual(lateQuestionEvents.at(-1)?.questionItems, JSON.parse(previousQuestionItems));
  const lateDbMessage = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "m-late-stop-db"))).at(0)!;
  assert.equal(lateDbMessage.status, "pending");
  assert.equal(lateDbMessage.deliveringSince, null);
  assert.equal(runs.takeStopped("late-stop-db"), null, "补结算后停止标记不得泄漏给下一回合");
  console.log("✓ 晚到暂停优先于引导，并完整恢复旧提问、检查点和完成确认");

  assert.equal(runs.claimTurn("lost-db", "single"), true);
  const lostDbHandle = { kill: () => { throw new Error("lost 预约不得提交或 kill"); } };
  runs.trackRun("lost-db", lostDbHandle);
  runs.confirmDone("lost-db");
  let lostReleased = false;
  const lostQuestionEvents: Array<string | null> = [];
  const unsubscribeLostQuestion = bus.subscribe((event) => {
    if (event.type !== "task.question" || event.taskId !== "lost-db") return;
    lostQuestionEvents.push(event.question);
    if (event.question === null && !lostReleased) {
      lostReleased = true;
      runs.untrackRun("lost-db", lostDbHandle);
      runs.releaseTurn("lost-db");
    }
  });
  const lostDbResult = await steer.steerQueuedMessage("m-lost-db");
  unsubscribeLostQuestion();
  assert.equal(lostDbResult.ok, false, "turn 在清理后释放时不得假报引导成功");
  if (!lostDbResult.ok) assert.match(lostDbResult.error, /结束|排队/);
  const lostDbTask = (await db.select().from(tasks).where(eq(tasks.id, "lost-db"))).at(0)!;
  assert.equal(lostDbTask.question, previousQuestion, "lost 回滚不得吞掉旧提问");
  assert.equal(lostDbTask.questionOptions, previousQuestionOptions);
  assert.equal(lostDbTask.questionItems, previousQuestionItems);
  assert.equal(lostDbTask.resumePrompt, previousResumePrompt, "lost 回滚不得吞掉旧检查点");
  assert.equal(lostDbTask.completeConfirmedAt, at, "lost 回滚不得吞掉旧完成票");
  assert.equal(runs.takeConfirmed("lost-db"), true, "lost 回滚应恢复内存完成确认");
  assert.deepEqual(lostQuestionEvents, [null, previousQuestion], "lost 回滚也必须恢复问题卡广播");
  const lostDbMessage = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "m-lost-db"))).at(0)!;
  assert.equal(lostDbMessage.status, "pending");
  assert.equal(lostDbMessage.deliveringSince, null);
  console.log("✓ commit lost 后消息继续排队，旧方向状态通过 CAS 完整恢复");

  const api = new Hono();
  mountTaskRunRoutes(api);
  mountTaskRoutes(api);
  mountTaskStageRoutes(api);
  const complete = (token?: string) => api.request("/tasks/token/complete", {
    method: "POST",
    headers: token ? { "x-ash-turn-token": token } : undefined,
  });
  const missingComplete = await complete();
  assert.equal(missingComplete.status, 409);
  assert.match(
    ((await missingComplete.json()) as { error: string }).error,
    /MCP.*回合身份|ASH_TURN_TOKEN/,
    "没收到 token 时应提示执行器/MCP 传递问题，而不是误报旧回合",
  );
  const stale = await complete("old-token");
  assert.equal(stale.status, 409, "旧回合完成确认必须被拒绝");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.completeConfirmedAt,
    null,
    "旧 token 不得写入完成票",
  );
  const current = await complete("new-token");
  assert.equal(current.status, 200, "当前回合 token 应能确认完成");
  assert.ok((await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.completeConfirmedAt);
  runs.takeConfirmed("token");

  const postTurnAction = (path: string, body: unknown, token?: string) => api.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-ash-turn-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
  await db.update(tasks).set({ completeConfirmedAt: null, resumePrompt: null, question: null })
    .where(eq(tasks.id, "token"));
  for (const token of ["old-token", undefined]) {
    const paused = await postTurnAction("/tasks/token/pause", { resumePrompt: "stale checkpoint" }, token);
    assert.equal(paused.status, 409, "旧 token 或缺 token 的 pause_task 必须被拒绝");
  }
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.resumePrompt,
    null,
    "旧回合不得写入检查点",
  );
  assert.equal(
    (await postTurnAction("/tasks/token/pause", { resumePrompt: "current checkpoint" }, "new-token")).status,
    200,
    "当前回合 pause_task 应继续可用",
  );
  await db.update(tasks).set({ resumePrompt: null }).where(eq(tasks.id, "token"));

  for (const token of ["old-token", undefined]) {
    const asked = await postTurnAction("/tasks/token/ask", { question: "stale question" }, token);
    assert.equal(asked.status, 409, "旧 token 或缺 token 的 ask_question 必须被拒绝");
  }
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.question,
    null,
    "旧回合不得写入提问",
  );
  assert.equal(
    (await postTurnAction("/tasks/token/ask", { question: "current question" }, "new-token")).status,
    200,
    "当前回合 ask_question 应继续可用",
  );
  assert.equal(
    (await postTurnAction("/tasks/team-ask/ask", { question: "team question" })).status,
    200,
    "团队常驻提问没有一次性回合 token，必须保持兼容",
  );
  console.log("✓ pause_task / ask_question 与 complete_task 一样绑定当前回合 token");

  const reportStage = (token?: string) => api.request("/tasks/token/stage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-ash-turn-token": token } : {}),
    },
    body: JSON.stringify({ stage: "implemented" }),
  });
  for (const token of ["old-token", undefined]) {
    assert.equal((await reportStage(token)).status, 409, "旧 token 或缺 token 的 report_stage 必须被拒绝");
  }
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.stage, null);
  assert.equal((await reportStage("new-token")).status, 200, "当前回合 report_stage 应继续可用");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.stage, "implemented");
  await db.update(tasks).set({ stage: null }).where(eq(tasks.id, "token"));

  const patchTask = (taskId: string, title: string, headers: Record<string, string> = {}) => api.request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ title }),
  });
  const noIdentityPatch = await patchTask("token", "stale-no-token");
  assert.equal(noIdentityPatch.status, 409, "无来源的运行中 PATCH 必须拒绝");
  assert.match(
    ((await noIdentityPatch.json()) as { error: string }).error,
    /缺少.*回合身份|外部 MCP/,
    "没有身份的外部调用不能误报成旧回合",
  );
  assert.equal((await patchTask("token", "stale-old-token", {
    "x-ash-source-task-id": "token",
    "x-ash-turn-token": "old-token",
  })).status, 409, "旧回合 PATCH 必须拒绝");
  assert.equal((await patchTask("token", "current-turn", {
    "x-ash-source-task-id": "token",
    "x-ash-turn-token": "new-token",
  })).status, 200, "当前回合 PATCH 应继续可用");
  assert.equal((await patchTask("token", "human-edit", {
    "x-ash-user-action": "1",
  })).status, 200, "真人界面修改运行中任务必须保持兼容");
  assert.equal((await patchTask("patch-target", "cross-task", {
    "x-ash-source-task-id": "patch-source",
    "x-ash-turn-token": "source-token",
  })).status, 200, "当前回合应能跨任务 PATCH");
  await db.update(tasks).set({ activeTurnToken: "source-next-token" }).where(eq(tasks.id, "patch-source"));
  assert.equal((await patchTask("patch-target", "stale-cross-task", {
    "x-ash-source-task-id": "patch-source",
    "x-ash-turn-token": "source-token",
  })).status, 409, "跨任务 PATCH 也必须绑定发起者当前回合");
  assert.equal((await patchTask("patch-target", "team-cross-task", {
    "x-ash-source-task-id": "team-patcher",
  })).status, 200, "团队常驻调度者跨任务 PATCH 必须保持兼容");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "patch-target"))).at(0)!.title, "team-cross-task");
  console.log("✓ report_stage / patch_task 拒绝旧回合，并保留用户操作与团队跨任务修改");

  await setTaskStatus("token", "failed");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, "token"))).at(0)!.activeTurnToken,
    null,
    "离开 running 后应清掉活动回合 token",
  );
  console.log("✓ complete_task 严格绑定当前回合 token，旧回合迟到确认返回 409");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
