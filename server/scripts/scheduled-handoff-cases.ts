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
}
