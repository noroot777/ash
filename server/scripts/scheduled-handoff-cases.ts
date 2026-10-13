// 「让位交接」那一组用例:前驱让位后自动起跑的首轮输入,以及起跑失败时的租约归还。
//
// 从 `test-scheduled-messages.ts` 里搬出来,原因与 `scheduled-steer-cases.ts` 相同:
// 那份又顶到 700 行上限了。切在这里是因为这一组问的是 **resumeOrRunTask →
// handDuePendingMessageToRun → continueTask 这条启动链路**(谁来当首轮输入、执行意图
// 与输入来源怎么分开、没送达时租约归谁),跟「消息怎么排队、什么时候投递」是两件事 ——
// 投递判定那几条仍留在原文件里,挨着 deliveryVerdict 各自的判据。
//
// 共享句柄走参数进来(计时基准 `at`、临时根目录、假执行器的 stdin 日志、三个构造/
// 等待助手),模块则在函数里**动态 import**:`ASH_DB` 要等主脚本设好才能碰 db 单例,
// 顶层 import 会在那之前就把库开在错的地方。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type {
  scheduledMessages as scheduledMessagesTable,
  tasks as tasksTable,
} from "../src/db/schema.js";

export type HandoffCaseContext = {
  /** 测试基准时刻(ISO),跟主脚本用同一个值。 */
  at: string;
  /** 临时项目根(同时是任务的工作目录);**不是 git 仓库**,起跑失败那条用例靠这一点复现。 */
  root: string;
  /** 假 claude 把每次 stdin 原样写成一行的日志,用来断言「原文到底进没进执行器」。 */
  leadLog: string;
  waitFor: (predicate: () => boolean | Promise<boolean>, message: string) => Promise<void>;
  countIn: (path: string, needle: string) => number;
  taskRow: (
    id: string,
    lead: "claude" | "gemini",
    status: "idle" | "running" | "done" | "paused",
  ) => typeof tasksTable.$inferInsert;
  messageRow: (
    id: string,
    taskId: string,
    text: string,
    mode?: "timed" | "queued",
  ) => typeof scheduledMessagesTable.$inferInsert;
};

export async function runHandoffCases(ctx: HandoffCaseContext): Promise<void> {
  const { at, root, leadLog, waitFor, countIn, taskRow, messageRow } = ctx;
  const [{ db }, schema, pending, status, transcript] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/pending-messages.js"),
    import("../src/status.js"),
    import("../src/transcript.js"),
  ]);
  const { queueItems, scheduledMessages, sessions, tasks } = schema;

  // ── 让位交接:前驱让位后,自动起跑那一轮的输入就是排队期间的修改要求 ─────────
  // 第 xNb655YqYzcA 链第 3 轮:P(paused,无 resumePrompt,有旧会话)排在 B 后面,
  // 排队期间收到普通回复;B 让位后队列推进若用空泛 RESUME_PROMPT 拉起 P,这条修改
  // 要求要等新回合跑完才补送 —— 任务先按旧方向干完一整轮。真实链路:run loop 结算 →
  // setTaskStatus → advanceQueueFromTask → resumeOrRunTask → handDuePendingMessageToRun。
  const handoffBId = "scheduled-single-handoff-b";
  const handoffPId = "scheduled-single-handoff-p";
  const handoffText = "修改要求：轮到我以后不要继续旧方案，只按这条最新说明工作。";
  await db.insert(tasks).values([
    { ...taskRow(handoffBId, "claude", "running"), mode: "single", team: null },
    { ...taskRow(handoffPId, "claude", "paused"), mode: "single", team: null },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-handoff-p-prev", taskId: handoffPId, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-handoff-p-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-handoff-queue", taskId: handoffBId, position: 0, createdAt: at },
    { queueId: "scheduled-handoff-queue", taskId: handoffPId, position: 1, createdAt: at },
  ]);
  await db.insert(scheduledMessages).values([messageRow("scheduled-handoff", handoffPId, handoffText, "queued")]);
  // 排队未轮到:扫描不得穿透(deliveryVerdict 的 queueBlocked 口径,真实库上钉一遍)
  await pending.deliverPendingMessages(handoffPId);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "scheduled-handoff"))).at(0)!.status,
    "pending", "B 还在跑,P 的回复必须原地等着",
  );
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.taskId, handoffPId))).length,
    1, "排队期间不得为 P 开新回合",
  );
  const resumePromptHits = countIn(leadLog, "你上一次的运行被中断了");
  await status.setTaskStatus(handoffBId, "done");
  // resume 复用同一条 session 行(不新增行),所以以消息记账与实际 stdin 为准。
  await waitFor(
    async () => (await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.id, "scheduled-handoff"))).at(0)!.status === "sent",
    "B 让位后队列推进没有把修改要求交接进 P 的续跑",
  );
  await waitFor(() => countIn(leadLog, handoffText) > 0, "消息标了 sent,P 的执行器 stdin 里却没有修改要求");
  assert.equal(
    countIn(leadLog, "你上一次的运行被中断了"), resumePromptHits,
    "让位那一轮先跑了一遍空泛「继续」—— 修改要求被挤到下一回合",
  );
  await waitFor(async () => {
    const t = (await db.select().from(tasks).where(eq(tasks.id, handoffPId))).at(0)!;
    return t.status !== "running" && t.status !== "queued";
  }, "让位交接那一轮没有结算");
  await pending.deliverPendingMessages(handoffPId); // 再扫一遍:租约/sent 必须保证只投递一次
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, handoffText), 1, "同一条修改要求被投递了不止一次");
  // 原文必须留在持久会话记录里(第 4 轮审查:带 system 标记会把这一轮只记成一句
  // 「〔系统〕继续」,用户的修改要求从页面历史与后续追问里消失)。
  const handoffTranscript = transcript.sessionTranscriptPath(handoffPId, "scheduled-handoff-p-prev");
  await waitFor(
    () => existsSync(handoffTranscript) && readFileSync(handoffTranscript, "utf8").includes(handoffText),
    "修改要求送进了 CLI,却没落进持久会话记录 —— 刷新后用户看不到自己说过什么",
  );
  assert.ok(
    !readFileSync(handoffTranscript, "utf8").includes("〔系统〕继续"),
    "让位交接的这一轮被记成了系统续跑",
  );
  console.log("✓ 让位交接:自动起跑首轮输入即修改要求本身,恰好一次,原文落进持久会话");

  // ── 起跑失败不吞租约:「已接管回合」≠「已送达」(第 4 轮审查拦验收 1)─────────
  // root 不是 git 仓库,useWorktree=true 的起跑在工作目录准备处就抛 —— continueTask
  // 吸收异常、结算 failed 后仍返回 true。送达的唯一可信信号是 onDelivered;没响就
  // 必须归还租约,否则恢复后的重试与扫描(都只看无租约的 pending 行)永远绕开它。
  const failId = "scheduled-single-handoff-fail";
  const failText = "恢复目录后的修改要求：先落实本条用户说明。";
  await db.insert(tasks).values([
    { ...taskRow(failId, "claude", "paused"), mode: "single", team: null, useWorktree: true },
  ]);
  // 旧会话的 cwd 已消失(项目目录被移走的现场),迫使 continueTask 重解析工作目录;
  // useWorktree=true 而 root 不是 git 仓库 → prepareWorktree 抛错,起跑失败被内部吸收。
  await db.insert(sessions).values({
    id: "scheduled-handoff-fail-prev", taskId: failId, role: "single", agentType: "claude",
    executor: "claude@test", cwd: join(root, "vanished"), cliSessionId: "scheduled-handoff-fail-cli", startedAt: at,
  });
  await db.insert(scheduledMessages).values([messageRow("scheduled-handoff-fail", failId, failText, "queued")]);
  assert.equal(await pending.handDuePendingMessageToRun(failId), true, "交接应报告已接管这次启动");
  const failRow = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-handoff-fail"))).at(0)!;
  await waitFor(async () => (await failRow()).deliveringSince === null,
    "起跑失败后租约没归还 —— 恢复后的重试与扫描会永远绕开这条消息");
  assert.equal((await failRow()).status, "pending", "没送达的消息必须留在待发送托盘里");
  assert.equal(countIn(leadLog, failText), 0, "起跑都失败了,原文不该出现在任何 stdin 里");
  // 「恢复目录」:关掉 worktree 需求,再扫一遍(自排的重投同样能送,这里显式扫是为了
  // 不依赖重投定时器的时序)。
  await db.update(tasks).set({ useWorktree: false }).where(eq(tasks.id, failId));
  await pending.deliverPendingMessages(failId);
  await waitFor(async () => (await failRow()).status === "sent", "起跑条件恢复后,消息没有被补送");
  await waitFor(() => countIn(leadLog, failText) > 0, "补送标了 sent,stdin 里却没有原文");
  await waitFor(async () => {
    const t = (await db.select().from(tasks).where(eq(tasks.id, failId))).at(0)!;
    return t.status !== "running" && t.status !== "queued";
  }, "补送那一轮没有结算");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, failText), 1, "同一条消息被送了不止一次");
  console.log("✓ 起跑失败归还租约,条件恢复后补送恰好一次");

  // ── 执行型重投守整队:起跑失败后恢复,不得与后继成员并跑(第 5 轮审查拦验收 1)──
  // 队列 [B2, P2, C2]:P2 排队期间收到修改要求(真实 /reply 入口,落成 execution=1),
  // 轮到它时起跑失败落 failed,C2 按队列规则顶上。失败重投若丢掉执行意图,P2 会按
  // 终态续聊豁免启动,与仍在跑的 C2 并行执行;必须等 C2 结束后按顺序投递恰好一次。
  const seqBId = "scheduled-single-seq-b";
  const seqPId = "scheduled-single-seq-p";
  const seqCId = "scheduled-single-seq-c";
  const seqText = "中间任务修改要求：等轮到我时继续实现最新方案，别按旧方案运行。";
  const [runRoutes, { Hono }] = await Promise.all([
    import("../src/task-run-routes.js"),
    import("hono"),
  ]);
  await db.insert(tasks).values([
    { ...taskRow(seqBId, "claude", "running"), mode: "single", team: null },
    { ...taskRow(seqPId, "claude", "paused"), mode: "single", team: null, useWorktree: true },
    // C2 的 body 让假 claude 保持运行,好留出「后继在跑」的窗口。
    { ...taskRow(seqCId, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-seq-p-prev", taskId: seqPId, role: "single", agentType: "claude",
    executor: "claude@test", cwd: join(root, "vanished"), cliSessionId: "scheduled-seq-p-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-seq-queue", taskId: seqBId, position: 0, createdAt: at },
    { queueId: "scheduled-seq-queue", taskId: seqPId, position: 1, createdAt: at },
    { queueId: "scheduled-seq-queue", taskId: seqCId, position: 2, createdAt: at },
  ]);
  // 从真实回复入口进:排队等轮次的暂存必须落 execution=1,重投才认得执行意图。
  const seqApi = new Hono();
  runRoutes.mountTaskRunRoutes(seqApi);
  const seqReply = await seqApi.request(`/tasks/${seqPId}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: seqText }),
  });
  assert.equal(seqReply.status, 202, "排队等待的 P2 发回复应被暂存");
  const seqRow = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.taskId, seqPId))).at(0)!;
  assert.equal((await seqRow()).execution, true, "排队等轮次暂存的回复必须带执行意图(execution=1)");
  // B2 让位 → P2 起跑失败落 failed → C2 顶上并保持运行。
  await status.setTaskStatus(seqBId, "done");
  await waitFor(async () => (await db.select().from(tasks).where(eq(tasks.id, seqPId))).at(0)!.status === "failed",
    "P2 的起跑失败没有结算成 failed");
  await waitFor(async () => (await db.select().from(tasks).where(eq(tasks.id, seqCId))).at(0)!.status === "running",
    "P2 失败让位后 C2 没有按队列规则顶上");
  // C2 在跑的整个窗口里:显式扫描 + 等待重投定时器,消息都必须原地等着,P2 不得启动。
  await pending.deliverPendingMessages(seqPId);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await seqRow()).status, "pending", "C2 还在跑,P2 的执行型回复不得投递");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, seqPId))).at(0)!.status, "failed",
    "C2 还在跑,P2 不得被自动重投拉起 —— 同一队列两个任务并跑");
  assert.equal(countIn(leadLog, seqText), 0, "原文不该在 C2 运行期间进任何 stdin");
  // 「恢复目录」后仍然要等:挡它的是整队在跑,不是目录。
  await db.update(tasks).set({ useWorktree: false }).where(eq(tasks.id, seqPId));
  await pending.deliverPendingMessages(seqPId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await seqRow()).status, "pending", "恢复目录不等于轮到它:C2 在跑就还得等");
  // C2 结束(真实 stopTask 杀活进程 → 结算 → 队列钩子)→ 轮到 P2,投递恰好一次。
  const runs = await import("../src/runs.js");
  assert.equal(runs.stopTask(seqCId), true, "测试前提:C2 的活进程应能被停掉");
  await waitFor(async () => (await seqRow()).status === "sent",
    "C2 结束后,P2 的执行型回复没有按顺序投递");
  await waitFor(() => countIn(leadLog, seqText) > 0, "补送标了 sent,stdin 里却没有原文");
  await waitFor(async () => {
    const t = (await db.select().from(tasks).where(eq(tasks.id, seqPId))).at(0)!;
    return t.status !== "running" && t.status !== "queued";
  }, "P2 补送那一轮没有结算");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, seqText), 1, "同一条修改要求被投递了不止一次");
  console.log("✓ 执行型重投守整队:C2 在跑时原文原地等,C2 结束后按顺序投递恰好一次");

  // ── 执行型重投守分组暂停:失败后暂停分组,恢复条件也不得自行重启(拦验收 2)────
  const pauseGId = "scheduled-handoff-pause-group";
  const pauseTId = "scheduled-single-pause-retry";
  const pauseText = "自动补投要求：恢复后继续实现最新方案，不要按旧方案工作。";
  await db.insert(schema.groups).values({
    id: pauseGId, projectId: "scheduled-project", name: "pause-retry", mode: "serial",
    paused: true, createdAt: at,
  });
  await db.insert(tasks).values([
    { ...taskRow(pauseTId, "claude", "idle"), mode: "single", team: null, status: "failed", groupId: pauseGId },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-pause-retry-prev", taskId: pauseTId, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-pause-retry-cli", startedAt: at,
  });
  await db.insert(scheduledMessages).values([
    { ...messageRow("scheduled-pause-retry", pauseTId, pauseText, "queued"), execution: true },
  ]);
  const pauseRow = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-pause-retry"))).at(0)!;
  // 分组暂停期间:扫描不得起跑,原文保持待发送(不取消)。
  await pending.deliverPendingMessages(pauseTId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await pauseRow()).status, "pending", "分组暂停期间执行型回复必须原地等着,不是取消");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, pauseTId))).at(0)!.status, "failed",
    "分组暂停期间任务不得被自动重投拉起");
  assert.equal(countIn(leadLog, pauseText), 0, "分组暂停期间原文不该进任何 stdin");
  // 用户恢复分组 → 投递恰好一次。
  await db.update(schema.groups).set({ paused: false }).where(eq(schema.groups.id, pauseGId));
  await pending.deliverPendingMessages(pauseTId);
  await waitFor(async () => (await pauseRow()).status === "sent", "恢复分组后执行型回复没有投递");
  await waitFor(() => countIn(leadLog, pauseText) > 0, "投递标了 sent,stdin 里却没有原文");
  await waitFor(async () => {
    const t = (await db.select().from(tasks).where(eq(tasks.id, pauseTId))).at(0)!;
    return t.status !== "running" && t.status !== "queued";
  }, "恢复分组后的投递回合没有结算");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, pauseText), 1, "同一条消息被投递了不止一次");
  console.log("✓ 执行型重投守分组暂停:暂停期间原文待发送,恢复分组后投递恰好一次");

  // ── 两个失败成员恢复后只按位置启动一个(第 6 轮审查拦验收 1)─────────────────
  // 队列 [B3, P3, Q3, C3]:P3/Q3 先后起跑失败,C3 顶上保持运行。C3 结束后,扫描在
  // 同一条串行链上先给 P3 落 queued 占位,Q3 的判定看见占位就等;P3 真正结束后
  // Q3 才投 —— 不占位的话两条消息各自读到「无人在跑」,两个失败任务一起复活。
  const sB = "scheduled-single-multi-b";
  const sP = "scheduled-single-multi-p";
  const sQ = "scheduled-single-multi-q";
  const sC = "scheduled-single-multi-c";
  // P3 的原文带「保持运行等待引导」:投递后假 claude 不退出,好断言 Q3 在 P3 运行期间原地等。
  const sPText = "P3 修改要求:保持运行等待引导";
  const sQText = "Q3 修改要求:轮到自己再跑,不许跟 P3 并行。";
  await db.insert(tasks).values([
    { ...taskRow(sB, "claude", "running"), mode: "single", team: null },
    { ...taskRow(sP, "claude", "paused"), mode: "single", team: null, useWorktree: true },
    { ...taskRow(sQ, "claude", "paused"), mode: "single", team: null, useWorktree: true },
    { ...taskRow(sC, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values([
    { id: "scheduled-multi-p-prev", taskId: sP, role: "single", agentType: "claude",
      executor: "claude@test", cwd: join(root, "vanished"), cliSessionId: "scheduled-multi-p-cli", startedAt: at },
    { id: "scheduled-multi-q-prev", taskId: sQ, role: "single", agentType: "claude",
      executor: "claude@test", cwd: join(root, "vanished"), cliSessionId: "scheduled-multi-q-cli", startedAt: at },
  ]);
  await db.insert(queueItems).values([
    { queueId: "scheduled-multi-queue", taskId: sB, position: 0, createdAt: at },
    { queueId: "scheduled-multi-queue", taskId: sP, position: 1, createdAt: at },
    { queueId: "scheduled-multi-queue", taskId: sQ, position: 2, createdAt: at },
    { queueId: "scheduled-multi-queue", taskId: sC, position: 3, createdAt: at },
  ]);
  await db.insert(scheduledMessages).values([
    { ...messageRow("scheduled-multi-p-msg", sP, sPText, "queued"), execution: true },
    { ...messageRow("scheduled-multi-q-msg", sQ, sQText, "queued"), execution: true },
  ]);
  const msgStatus = async (id: string) => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, id))).at(0)!.status;
  const taskStatus = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!.status;
  // B3 让位 → P3、Q3 依次起跑失败 → C3 顶上。
  await status.setTaskStatus(sB, "done");
  await waitFor(async () => (await taskStatus(sP)) === "failed", "P3 起跑失败没有结算成 failed");
  await waitFor(async () => (await taskStatus(sQ)) === "failed", "Q3 起跑失败没有结算成 failed");
  await waitFor(async () => (await taskStatus(sC)) === "running", "两个失败成员让位后 C3 没有顶上");
  // 恢复起跑条件;C3 仍在跑,两条消息都得原地等。
  await db.update(tasks).set({ useWorktree: false }).where(eq(tasks.id, sP));
  await db.update(tasks).set({ useWorktree: false }).where(eq(tasks.id, sQ));
  await new Promise((resolve) => setTimeout(resolve, 1200)); // 让重投定时器把退避走完
  await pending.deliverPendingMessages();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await msgStatus("scheduled-multi-p-msg"), "pending", "C3 在跑,P3 不得投递");
  assert.equal(await msgStatus("scheduled-multi-q-msg"), "pending", "C3 在跑,Q3 不得投递");
  // C3 结束 → 只有位置靠前的 P3 启动;Q3 必须等 P3 真正结束。
  const runsModule = await import("../src/runs.js");
  assert.equal(runsModule.stopTask(sC), true, "测试前提:C3 的活进程应能被停掉");
  await waitFor(async () => (await msgStatus("scheduled-multi-p-msg")) === "sent", "C3 结束后 P3 没有收到原文");
  await waitFor(async () => (await taskStatus(sP)) === "running", "P3 投递后应在运行(假 claude 保持运行)");
  await pending.deliverPendingMessages();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await msgStatus("scheduled-multi-q-msg"), "pending", "P3 还在跑,Q3 就启动 —— 两个失败任务一起复活了");
  assert.equal(countIn(leadLog, sQText), 0, "Q3 的原文不该在 P3 运行期间进 stdin");
  assert.equal(runsModule.stopTask(sP), true, "测试前提:P3 的活进程应能被停掉");
  await waitFor(async () => (await msgStatus("scheduled-multi-q-msg")) === "sent", "P3 结束后 Q3 没有按顺序投递");
  await waitFor(() => countIn(leadLog, sQText) > 0, "Q3 标了 sent,stdin 里却没有原文");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, sPText), 1, "P3 的原文被投了不止一次");
  assert.equal(countIn(leadLog, sQText), 1, "Q3 的原文被投了不止一次");
  console.log("✓ 两个失败成员恢复:C3 结束只启动 P3,P3 结束后 Q3 才按序投递");

  // ── 交接认领即持久化执行意图(第 6 轮审查拦验收 2)──────────────────────────
  // 运行中暂存的追问 execution=0;被 handDuePendingMessageToRun 认领为执行输入后,
  // 转换必须在启动前落库 —— 失败重投才不会按首次发送时的终态续聊分类放行。
  const cvT = "scheduled-single-convert";
  const cvS = "scheduled-single-convert-next";
  const cvText = "运行中暂存的修改要求：下次轮到我时继续实现新方案。";
  await db.insert(tasks).values([
    { ...taskRow(cvT, "claude", "paused"), mode: "single", team: null, useWorktree: true },
    { ...taskRow(cvS, "claude", "running"), mode: "single", team: null },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-convert-prev", taskId: cvT, role: "single", agentType: "claude",
    executor: "claude@test", cwd: join(root, "vanished"), cliSessionId: "scheduled-convert-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-convert-queue", taskId: cvT, position: 0, createdAt: at },
    { queueId: "scheduled-convert-queue", taskId: cvS, position: 1, createdAt: at },
  ]);
  await db.insert(scheduledMessages).values([messageRow("scheduled-convert-msg", cvT, cvText, "queued")]); // execution=0
  assert.equal(await pending.handDuePendingMessageToRun(cvT), true, "交接应接管这次启动");
  const cvRow = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-convert-msg"))).at(0)!;
  assert.equal((await cvRow()).execution, true, "被交接认领为执行输入后,转换必须已持久化");
  await waitFor(async () => (await taskStatus(cvT)) === "failed", "交接起跑失败没有结算成 failed");
  assert.equal((await cvRow()).status, "pending", "失败后原文必须留在待发送");
  // 后继 cvS 还在跑:恢复目录 + 走完退避,重投也必须按执行型等待,不得按续聊放行。
  await db.update(tasks).set({ useWorktree: false }).where(eq(tasks.id, cvT));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await pending.deliverPendingMessages(cvT);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await cvRow()).status, "pending", "同队 cvS 在跑,升级后的执行型消息必须等");
  assert.equal(countIn(leadLog, cvText), 0, "cvS 在跑期间原文不该进 stdin");
  await status.setTaskStatus(cvS, "done");
  await waitFor(async () => (await cvRow()).status === "sent", "cvS 让位后消息没有投递");
  await waitFor(() => countIn(leadLog, cvText) > 0, "标了 sent,stdin 里却没有原文");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, cvText), 1, "同一条消息被投了不止一次");
  console.log("✓ 交接认领即持久化执行意图:失败重投不再按旧分类放行");

  // ── 持续故障下的重试有界(第 6 轮审查拦验收 3)──────────────────────────────
  // 目录不修复时,失败结算钩子触发的扫描必须遵守 next-retry-at,不得形成
  // 「失败→结算唤醒→再失败」的自激循环(审查实测 2 秒 24 次)。真实尝试的唯一
  // 出声点是 scheduleRedelivery 的 warn,按它计数。
  const stT = "scheduled-single-storm";
  const stText = "持续故障下的修改要求:目录修好前别反复撞。";
  await db.insert(tasks).values([
    { ...taskRow(stT, "claude", "paused"), mode: "single", team: null, useWorktree: true },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-storm-prev", taskId: stT, role: "single", agentType: "claude",
    executor: "claude@test", cwd: join(root, "vanished"), cliSessionId: "scheduled-storm-cli", startedAt: at,
  });
  await db.insert(scheduledMessages).values([
    { ...messageRow("scheduled-storm-msg", stT, stText, "queued"), execution: true },
  ]);
  const stWarned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { stWarned.push(args.map(String).join(" ")); realWarn(...(args as [])); };
  try {
    assert.equal(await pending.handDuePendingMessageToRun(stT), true, "首次交接应接管");
    await waitFor(async () => (await taskStatus(stT)) === "failed", "首次起跑失败没有结算");
    const afterFirst = stWarned.filter((l) => l.includes("scheduled-storm-msg")).length;
    assert.ok(afterFirst >= 1, "首次失败应出声(scheduleRedelivery)");
    // 模拟失败结算钩子风暴:连续 20 次扫描,全部应被 next-retry-at 挡住,零新增尝试。
    for (let i = 0; i < 20; i++) await pending.deliverPendingMessages(stT);
    const afterStorm = stWarned.filter((l) => l.includes("scheduled-storm-msg")).length;
    // 容忍恰好撞上 200ms 重投定时器的那一次;风暴若未被堵住,这里会是 +20 的量级。
    assert.ok(afterStorm <= afterFirst + 1,
      `退避期内 20 次扫描最多放行 1 次定时器重投,实际新增 ${afterStorm - afterFirst}`);
    // 走完退避观察 1.6s:允许的真实尝试至多 200ms/1s 两次,远低于审查实测的 2 秒 24 次。
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const bounded = stWarned.filter((l) => l.includes("scheduled-storm-msg")).length;
    assert.ok(bounded <= afterFirst + 3, `1.6s 内失败尝试应 ≤ ${afterFirst + 3},实际 ${bounded}`);
  } finally {
    console.warn = realWarn;
  }
  // 恢复目录:消息仍能送达恰好一次。退避封顶后 next-retry-at 已推到 30s 兜底,
  // 自动扫描按规矩等;用户显式重试(交接路径)不吃退避,立刻放行。
  await db.update(tasks).set({ useWorktree: false }).where(eq(tasks.id, stT));
  assert.equal(await pending.handDuePendingMessageToRun(stT), true, "显式重试应接管这次启动");
  await waitFor(async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-storm-msg"))).at(0)!.status === "sent",
    "恢复目录后显式重试没有送达消息");
  await waitFor(() => countIn(leadLog, stText) > 0, "标了 sent,stdin 里却没有原文");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, stText), 1, "同一条消息被投了不止一次");
  console.log("✓ 持续故障下重试有界:退避约束所有触发源,恢复后仍送达恰好一次");

  // ── 队列执行认领是同一个原子对象(第 7 轮审查拦验收)────────────────────────
  // 先钉共享原语本身:同队两个失败成员并发认领,临界区串行,只许一个占到;占到的
  // 一方 release 回滚后,另一方才能占。
  const seatMod = await import("../src/queue-seat.js");
  const zH = "scheduled-single-seat-head";
  const zA = "scheduled-single-seat-a";
  const zB = "scheduled-single-seat-b";
  await db.insert(tasks).values([
    { ...taskRow(zH, "claude", "done"), mode: "single", team: null },
    { ...taskRow(zA, "claude", "idle"), mode: "single", team: null, status: "failed" },
    { ...taskRow(zB, "claude", "idle"), mode: "single", team: null, status: "failed" },
  ]);
  await db.insert(queueItems).values([
    { queueId: "scheduled-seat-queue", taskId: zH, position: 0, createdAt: at },
    { queueId: "scheduled-seat-queue", taskId: zA, position: 1, createdAt: at },
    { queueId: "scheduled-seat-queue", taskId: zB, position: 2, createdAt: at },
  ]);
  const taskStatusOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!.status;
  const [clA, clB] = await Promise.all([seatMod.claimQueueSeat(zA), seatMod.claimQueueSeat(zB)]);
  const winner = clA.ok && clA.seat ? clA.seat : clB.ok && clB.seat ? clB.seat : null;
  const blocked = clA.ok && clA.seat ? clB : clA;
  assert.ok(winner, "同队并发认领至少要有一个占到位");
  assert.equal(blocked.ok, false, "同队并发认领只许一个占到位");
  assert.ok(!blocked.ok && blocked.blockers.length > 0, "被挡回的一方要知道是谁挡的路");
  assert.equal(await taskStatusOf(winner.taskId), "queued", "占到位 = queued 已落库,任何入口立刻可见");
  await winner.release();
  assert.equal(await taskStatusOf(winner.taskId), "failed", "没人接手的占位必须回滚,不能卡在 queued");
  const loserId = winner.taskId === zA ? zB : zA;
  const retryClaim = await seatMod.claimQueueSeat(loserId);
  if (!retryClaim.ok || !retryClaim.seat) throw new Error("占位释放后,被挡的一方应能占到");
  await retryClaim.seat.release();
  assert.equal(await taskStatusOf(loserId), "failed", "清场:测试占位释放后应回到 failed");
  console.log("✓ 队列执行认领:并发只许一个占到,释放后按守卫回滚、让位给下一个");

  // ── 跨入口占位:重跑上一回合 vs 执行型补投并发(第 7 轮审查现场)──────────────
  // 队列 [rA(failed,挂着到期执行型回复), rB(done,上一回合 exit 1)]:并发发起
  // POST /tasks/rB/retry-turn(resume 档,真执行)与 rA 的补投扫描。修复前,重跑在
  // 异步读旧记录期间只占任务级回合锁、状态停在 done,扫描判定整队空闲放行 rA,两任务
  // 同时 running(审查普通 HTTP 并发 10/10)。修复后两路都要过同一条认领链:谁先占到
  // 谁跑,另一方 409 / 原地等 —— 任何交错下同队至多一个在跑。
  const rA = "scheduled-single-race-a";
  const rB = "scheduled-single-race-b";
  const rAText = "rA 执行型修改要求:保持运行等待引导(跨入口占位用例)";
  await db.insert(tasks).values([
    { ...taskRow(rA, "claude", "idle"), mode: "single", team: null, status: "failed" },
    // rB 的 body 带魔法串:retry-turn 的 resume 档对无 cliSessionId 的老任务走 fresh
    // 重跑,喂的是任务正文 —— 假 claude 读到后保持运行,留出「rB 在跑」的观察窗口。
    { ...taskRow(rB, "claude", "done"), mode: "single", team: null, body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values([
    // rA 的旧会话:补投走 resume,原文(含魔法串)进 stdin 后保持运行。
    { id: "scheduled-race-a-prev", taskId: rA, role: "single", agentType: "claude",
      executor: "claude@test", cwd: root, cliSessionId: "scheduled-race-a-cli", startedAt: at },
    // rB 的崩掉回合:exit 1、非手动停止、无 cliSessionId(transcript 也不存在)→
    // retry-turn 落在 resume 档的 resumeOrRunTask → fresh 重跑,正是审查复现的那条路。
    { id: "scheduled-race-b-prev", taskId: rB, role: "single", agentType: "claude",
      executor: "claude@test", cwd: root, cliSessionId: null, startedAt: at, exitStatus: 1 },
  ]);
  await db.insert(queueItems).values([
    { queueId: "scheduled-race-queue", taskId: rA, position: 0, createdAt: at },
    { queueId: "scheduled-race-queue", taskId: rB, position: 1, createdAt: at },
  ]);
  await db.insert(scheduledMessages).values([
    { ...messageRow("scheduled-race-a-msg", rA, rAText, "queued"), execution: true },
  ]);
  const raceMsg = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-race-a-msg"))).at(0)!;
  const [retryRes] = await Promise.all([
    seqApi.request(`/tasks/${rB}/retry-turn`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }),
    pending.deliverPendingMessages(rA),
  ]);
  const runningOf = async () => {
    const [sA, sB] = [await taskStatusOf(rA), await taskStatusOf(rB)];
    return [sA === "running" || sA === "queued", sB === "running" || sB === "queued"] as const;
  };
  if (retryRes.status === 202) {
    // 重跑先占到位:rB 真执行起跑;rA 的执行型回复必须原地等,一个字不进 stdin。
    assert.equal((await retryRes.json() as { mode: string }).mode, "resume", "夹具应落在 resume 档");
    await waitFor(async () => (await taskStatusOf(rB)) === "running", "占到位的 rB 没有跑起来");
    await pending.deliverPendingMessages(rA);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const [aLive, bLive] = await runningOf();
    assert.equal(bLive, true, "rB 应保持在跑(假 claude 读魔法串不退出)");
    assert.equal(aLive, false, "rB 在跑期间 rA 被拉起 —— 同队两个任务并跑(第 7 轮审查现场)");
    assert.equal((await raceMsg()).status, "pending", "rB 在跑期间 rA 的执行型回复必须原地等");
    assert.equal(countIn(leadLog, rAText), 0, "rA 的原文不该在 rB 运行期间进 stdin");
    // rB 结束让位 → rA 按序投递恰好一次。
    assert.equal(runsModule.stopTask(rB), true, "测试前提:rB 的活进程应能被停掉");
    await waitFor(async () => (await raceMsg()).status === "sent", "rB 让位后 rA 的执行型回复没有投递");
    await waitFor(() => countIn(leadLog, rAText) > 0, "标了 sent,stdin 里却没有原文");
  } else {
    // 扫描先占到位:rA 起跑,重跑必须被 409 挡回、rB 一个新回合都不开。
    assert.equal(retryRes.status, 409, `重跑没占到位时应 409,实际 ${retryRes.status}`);
    const body = await retryRes.json() as { blockedBy?: string[] };
    assert.ok(body.blockedBy?.includes(rA), "409 应指出挡路的同队成员");
    await waitFor(async () => (await raceMsg()).status === "sent", "占到位的 rA 没有收到原文");
    assert.equal(await taskStatusOf(rB), "done", "被挡回的 rB 必须保持 done,不开新回合");
    assert.equal(
      (await db.select().from(sessions).where(eq(sessions.taskId, rB))).length,
      1, "被挡回的 rB 不得新增会话",
    );
  }
  // 两种交错的共同收尾:此刻至多一个在跑;rA 的原文送达恰好一次。停进程前必须等原文
  // 真进了 stdin 日志:onDelivered 在 ash 写完 stdin 那一刻就响,假 claude 还要几百毫秒
  // 才处理到那一行,立刻 stopTask 会把日志杀没,断言只能读到 0。
  {
    const [aLive, bLive] = await runningOf();
    assert.ok(!(aLive && bLive), "同一队列两个成员同时在跑");
  }
  await waitFor(async () => (await taskStatusOf(rA)) === "running", "rA 的执行回合应已拉起");
  await waitFor(() => countIn(leadLog, rAText) > 0, "rA 的消息标了 sent,stdin 里却没有原文");
  assert.equal(runsModule.stopTask(rA), true, "测试前提:rA 的活进程应能被停掉");
  await waitFor(async () => {
    const [aLive, bLive] = await runningOf();
    return !aLive && !bLive;
  }, "收尾:两任务都该停下");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(countIn(leadLog, rAText), 1, "rA 的原文被投了不止一次");
  console.log("✓ 跨入口占位:重跑上一回合与执行型补投并发,同队至多一个在跑,另一方按序让行");
}
