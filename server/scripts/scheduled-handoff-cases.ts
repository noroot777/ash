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
}
