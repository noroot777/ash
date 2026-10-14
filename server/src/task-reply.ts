import type { AgentType, ScheduledMessage } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { isGoalExecution, isGoalRecovery, parseCliCommand } from "@ash/shared/cli-commands";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { continueTask } from "./orchestrator.js";
import { enqueueMessage } from "./pending-messages.js";
import { queueBlockers } from "./queues.js";
import { claimQueueSeat } from "./queue-seat.js";
import { nativeCliCommand } from "./skills.js";
import { leadTypeOf } from "./team/session.js";
import { replyWithAnnotationBatch } from "./page-annotation-routes.js";
import { taskCliCommand } from "./task-cli-command.js";
import { appendTaskTimeline } from "./task-timeline.js";

export type TaskReplyBody = {
  text?: string;
  attachments?: string[];
  agent?: AgentType;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  sendAt?: string;
  annotationBatchId?: string;
  annotationRevision?: number;
};

function toScheduledMessage(r: typeof scheduledMessages.$inferSelect): ScheduledMessage {
  return {
    ...r,
    attachments: JSON.parse(r.attachments),
    agent: (r.agent as AgentType) ?? null,
    // 界面要能看出这条归不归用户的对话框管（见 shared/src/schedule.ts）。
    sessionRole: (r.sessionRole as ScheduledMessage["sessionRole"]) ?? null,
    mode: r.mode as ScheduledMessage["mode"],
    status: r.status as ScheduledMessage["status"],
  };
}

/**
 * 单任务回复的权威实现。普通 HTTP 路由和接力代理都走这里，确保排队、定时、团队
 * 原生命令以及回合锁缝隙的语义完全一致。
 */
export async function replyToTask(c: Context, taskId: string, body?: TaskReplyBody): Promise<Response> {
  const b = body ?? await c.req.json<TaskReplyBody>();
  if (!b.annotationBatchId && !b.text?.trim() && !b.attachments?.length) return c.json({ error: "empty" }, 400);
  if (b.agent && !AGENT_TYPES.includes(b.agent)) return c.json({ error: "未知的 agent", agent: b.agent }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再回复", archived: true }, 409);
  const blocked = handoffBlockReason(r.handoff);
  if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  const isTeam = r.mode === "team";
  if (!isTeam && r.mode !== "single") return c.json({ error: "仅单任务支持回复" }, 409);
  if (b.annotationBatchId) return replyWithAnnotationBatch(c, taskId, b.annotationBatchId, b.annotationRevision ?? 0);
  try {
    const command = await taskCliCommand(c, r, b);
    if (command) return command;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), started: false }, 409);
  }

  const queueWhileRunning = !isTeam && (r.status === "running" || r.status === "queued");
  const goalCommand = parseCliCommand(b.agent ?? (r.agentType as AgentType) ?? "claude", b.text ?? "");
  const goalExecution = !isTeam && isGoalExecution(goalCommand);
  const goalRecovery = !isTeam && isGoalRecovery(goalCommand);
  const goalControl = !isTeam && goalCommand?.name === "goal" && !goalExecution;
  // checkpoint 追问:paused 且带 resumePrompt 的任务,非执行回合的用户回复一律是
  // 「怎么样了」式旁路续聊(orchestrator 的 checkpointFollowUp 同判据)——结算用
  // followUpFrom 护回 paused、不消费继续指令。它不是任务的执行,所以跟终态续聊
  // 一样直送:既不暂存成执行型、也不占队列认领。把它套进任何一个执行化分支都会
  // 翻掉 paused 状态,让 orchestrator 误判成执行回合——消费检查点、无确认结算
  // failed、队列按失败跳过放行后项(第 ln9Q6IJEgmWf 链第 2 轮真实页面复现)。
  const checkpointFollowUp = !isTeam && r.status === "paused" && !!r.resumePrompt && !isGoalExecution(goalCommand);
  // 排队没轮到的任务:直接 continueTask 会在同队 running 成员旁边再开一个
  // 回合(第 xNb655YqYzcA 链第 2 轮复现)。先把回复暂存成排队消息,让位后由投递链路
  // (deliveryVerdict 同口径)送达。普通终态续聊是 followUpFrom 旁路,不占队列。
  const executionReply =
    !isTeam && !checkpointFollowUp && !goalControl &&
    (goalRecovery || r.status === "paused" || r.status === "backlog");
  const queueWhileWaiting = executionReply && (await queueBlockers(taskId)).length > 0;
  if (b.sendAt || queueWhileRunning || queueWhileWaiting) {
    let when = new Date();
    if (b.sendAt) {
      when = new Date(b.sendAt);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
        return c.json({ error: "定时时间必须是将来的有效时间" }, 400);
      }
    }
    const row = await enqueueMessage({
      taskId,
      text: (b.text ?? "").trim(),
      attachments: b.attachments,
      agent: b.agent ?? null,
      executorId: b.executorId ?? null,
      model: b.model?.trim() || null,
      reasoningEffort: b.reasoningEffort?.trim() || null,
      ownerUserId: ownerIdOf(actorOf(c)),
      mode: b.sendAt ? "timed" : "queued",
      // 排队等轮次时暂存的回复 = 执行型:投递它就是任务的执行回合,整队守卫与分组
      // 暂停都要挡,失败重投也不丢意图(schema 的 execution 注释)。普通运行中追问
      // 与定时提醒不是——它们落地是续聊/到点提醒,照旧旁路。
      execution: goalRecovery || (queueWhileWaiting && !b.sendAt),
      sendAt: when,
    });
    return c.json({ scheduled: true, message: toScheduledMessage(row) }, 202);
  }

  const route = {
    attachments: b.attachments,
    agent: b.agent,
    executorId: b.executorId ?? null,
    model: b.model?.trim() || null,
    reasoningEffort: b.reasoningEffort?.trim() || null,
    // 共享项目里在别人的任务上回复:这一轮烧的是**我**的 key(§八)。
    actingUserId: ownerIdOf(actorOf(c)),
  };
  const text = (b.text ?? "").trim();
  const teamNative = isTeam ? nativeCliCommand(await leadTypeOf(taskId), text) : null;
  if (teamNative) {
    try {
      const started = await continueTask(taskId, text, { ...route, throwOnTeamUnavailable: true });
      if (!started) return c.json({ error: `/${teamNative} 没有送出:调度台此刻接不住这条原生命令。`, started: false }, 409);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), started: false }, 409);
    }
    return c.json({ started: true }, 202);
  }
  // 执行型的单任务回复:投递**就是任务的执行回合**,起跑前要过与 /run、/fire、
  // 定时到点、消息补投、重跑上一回合共用的队列认领(queue-seat.ts)。上面 queueWhileWaiting
  // 那次 queueBlockers 只是无互斥的快速判断 —— 读完到 continueTask 把状态落成 running
  // 之间隔着一串 await,同队另一个成员的手动运行在这个窗口里照样认领成功,两项一起跑
  // (第 ln9Q6IJEgmWf 链第 1 轮:/reply 与 /run 真实 HTTP 并发,10/10 同队双跑)。
  // 认领失败不丢原话:按 queueWhileWaiting 同款暂存成执行型待发送,让位后由投递链路
  // 作为首轮输入送达。普通终态续聊与 checkpoint 追问不在此列 —— 它们是 followUpFrom 旁路,
  // 不占队列,豁免保留(追问的判据见上面 checkpointFollowUp)。
  if (executionReply) {
    const stash = () => enqueueMessage({
      taskId, text, ...route, agent: b.agent ?? null,
      ownerUserId: route.actingUserId, execution: true,
    });
    const claim = await claimQueueSeat(taskId);
    if (!claim.ok) {
      const row = await stash();
      return c.json({ scheduled: true, message: toScheduledMessage(row) }, 202);
    }
    const seat = claim.seat;
    void continueTask(taskId, text, route)
      .then(async (started) => {
        // 回合被别的执行抢占:原话退回托盘,仍按执行型等队列位置,不按续聊放行。
        if (!started) await stash();
      })
      .catch((err) => console.error(`[ash] 回复续跑 ${taskId} 异常:`, err))
      .finally(() => { if (seat) void seat.release(); });
    return c.json({ started: true }, 202);
  }
  void continueTask(taskId, text, route).then(async (started) => {
    if (started) return;
    await enqueueMessage({ taskId, text, ...route, agent: b.agent ?? null, ownerUserId: route.actingUserId });
  }).catch((error) => {
    void appendTaskTimeline(taskId, `续聊未能启动：${error instanceof Error ? error.message : String(error)}`).catch((failure) => console.error("[ash] 续聊失败说明写入失败:", failure));
  });
  return c.json({ started: true }, 202);
}
