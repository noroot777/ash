import type { AgentType, ScheduledMessage } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { continueTask } from "./orchestrator.js";
import { enqueueMessage } from "./pending-messages.js";
import { nativeCliCommand } from "./skills.js";
import { leadTypeOf } from "./team/session.js";

export type TaskReplyBody = {
  text?: string;
  attachments?: string[];
  agent?: AgentType;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  sendAt?: string;
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
  if (!b.text?.trim() && !b.attachments?.length) return c.json({ error: "empty" }, 400);
  if (b.agent && !AGENT_TYPES.includes(b.agent)) return c.json({ error: "未知的 agent", agent: b.agent }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再回复", archived: true }, 409);
  const blocked = handoffBlockReason(r.handoff);
  if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  const isTeam = r.mode === "team";
  if (!isTeam && r.mode !== "single") return c.json({ error: "仅单任务支持回复" }, 409);

  const queueWhileRunning = !isTeam && (r.status === "running" || r.status === "queued");
  if (b.sendAt || queueWhileRunning) {
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
  void continueTask(taskId, text, route).then(async (started) => {
    if (started) return;
    await enqueueMessage({ taskId, text, ...route, agent: b.agent ?? null, ownerUserId: route.actingUserId });
  });
  return c.json({ started: true }, 202);
}
