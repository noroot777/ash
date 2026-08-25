// 单飞任务的「引导会话」：消息默认 queued，只有用户点托盘末尾的唯一动作后，才受控
// 结束当前普通执行回合，并把队首原话送进同一 CLI 会话。它不是团队常驻，也不能截断
// 验证、审查或 CLI 原生命令旁路回合。
//
// 两条硬不变量：① 清旧状态前先预约 steering，数据库失败可撤销；② 原话真正落盘前消息
// 始终 pending，续送失败先把假 running 拉回真实状态，再归还投递租约。
import type { TaskStatus } from "@ash/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { continueTask } from "./orchestrator.js";
import { abortDelivery, beginDelivery, deliveryOptions, markSent } from "./pending-messages.js";
import {
  isRunning,
  isTurnClaimed,
  reserveSteerTask,
  takeConfirmed,
  turnRole,
} from "./runs.js";
import { setTaskStatus } from "./status.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { id, now } from "./util.js";

type MessageRow = typeof scheduledMessages.$inferSelect;

export type SteerQueuedMessageResult =
  | { ok: true; taskId: string; messageId: string }
  | { ok: false; status: 404 | 409 | 500; error: string };

async function clearPreviousDirectionState(taskId: string): Promise<void> {
  // 先换 token 再 kill：旧回合早到的确认会被本次 UPDATE 清掉，晚到的确认会因 token
  // 不匹配被 409；更新前后各清一次内存快路，盖住 HTTP 与 DB await 的交错。
  takeConfirmed(taskId);
  const updatedAt = now();
  const current = (await db.select({ question: tasks.question }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  await db
    .update(tasks)
    .set({
      activeTurnToken: id(),
      completeConfirmedAt: null,
      resumePrompt: null,
      question: null,
      questionOptions: null,
      questionItems: null,
      updatedAt,
    })
    .where(eq(tasks.id, taskId));
  takeConfirmed(taskId);
  if (current?.question) {
    try {
      bus.publish({
        type: "task.question",
        taskId,
        updatedAt,
        question: null,
        questionOptions: null,
        questionItems: null,
      });
    } catch (error) {
      console.warn(`[ash] 引导会话已清提问，但实时通知失败 ${taskId}:`, error);
    }
  }
}

async function recoverUndeliveredSteer(taskId: string): Promise<void> {
  // 新回合没抢到时，旧回合已经按 steering 跳过结算。只有确认此刻既无 handle、也无
  // turn owner，才把 DB 的 running 拉下来；若别的回合已接管，只归还消息租约，不能误伤。
  if (isRunning(taskId) || isTurnClaimed(taskId)) return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || (task.status !== "running" && task.status !== "queued")) return;
  await reconcileTurnBaseline(taskId, false).catch(() => undefined);
  const prior = task.followUpFrom as TaskStatus | null;
  const fallback: TaskStatus = prior && prior !== "running" && prior !== "queued" ? prior : "failed";
  await db
    .update(tasks)
    .set({ followUpFrom: null, nativeTurn: false, completeConfirmedAt: null, updatedAt: now() })
    .where(eq(tasks.id, taskId));
  await setTaskStatus(taskId, fallback);
}

function deliverSteeredMessage(message: MessageRow): Promise<SteerQueuedMessageResult> {
  return new Promise((resolve) => {
    let settled = false;
    let delivered = false;
    const finish = (result: SteerQueuedMessageResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    void (async () => {
      try {
        const started = await continueTask(message.taskId, message.text, {
          ...deliveryOptions(message),
          onDelivered: async () => {
            await markSent(message);
            delivered = true;
            finish({ ok: true, taskId: message.taskId, messageId: message.id });
          },
        });
        if (started && delivered) return;
        await recoverUndeliveredSteer(message.taskId);
        await abortDelivery(message);
        finish({
          ok: false,
          status: 409,
          error: started
            ? "新方向未能落进会话，消息已保留在排队中"
            : "当前回合被其它执行抢占，消息已保留在排队中",
        });
      } catch (error) {
        if (!delivered) {
          await recoverUndeliveredSteer(message.taskId).catch(() => undefined);
          await abortDelivery(message).catch(() => undefined);
        }
        finish({
          ok: false,
          status: 500,
          error: `引导会话失败，消息仍在排队：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
  });
}

function sideTurnReason(task: typeof tasks.$inferSelect): string | null {
  if (task.verifyRound != null) return "当前正在进行验证回合，消息继续排队";
  if (task.reviewOf) return "当前是审查任务回合，消息继续排队";
  if (task.nativeTurn) return "当前正在执行 CLI 命令，消息继续排队";
  const role = turnRole(task.id);
  if (role && role !== "single") return "当前是审查或系统旁路回合，消息继续排队";
  return null;
}

/** 升级队首 queued 消息；导出给回归测试，HTTP 端点只是薄封装。 */
export async function steerQueuedMessage(messageId: string): Promise<SteerQueuedMessageResult> {
  const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId))).at(0);
  if (!message) return { ok: false, status: 404, error: "待发送消息不存在" };
  if (message.status !== "pending" || message.mode !== "queued") {
    return { ok: false, status: 409, error: "只有仍在排队的消息可以引导会话" };
  }
  const task = (await db.select().from(tasks).where(eq(tasks.id, message.taskId))).at(0);
  if (!task) return { ok: false, status: 404, error: "任务不存在" };
  if (task.mode !== "single") return { ok: false, status: 409, error: "只有单飞任务支持引导会话" };
  if (task.archived) return { ok: false, status: 409, error: "任务已归档，消息继续保留在排队中" };
  if (task.status !== "running" && task.status !== "queued") {
    return { ok: false, status: 409, error: "当前回合已经结束，消息会按排队顺序自动发送" };
  }
  const blocked = sideTurnReason(task);
  if (blocked) return { ok: false, status: 409, error: blocked };

  const first = (await db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.taskId, task.id),
      eq(scheduledMessages.status, "pending"),
      eq(scheduledMessages.mode, "queued"),
    ))
    .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.createdAt), asc(scheduledMessages.id))
    .limit(1)).at(0);
  if (first?.id !== message.id) {
    return { ok: false, status: 409, error: "只能按排队顺序引导最早的一条消息" };
  }

  let resolveDelivery!: (result: SteerQueuedMessageResult) => void;
  const delivery = new Promise<SteerQueuedMessageResult>((resolve) => { resolveDelivery = resolve; });
  const reservation = reserveSteerTask(task.id, () => {
    void deliverSteeredMessage(message).then(resolveDelivery);
  });
  if (!reservation) {
    return { ok: false, status: 409, error: "当前回合正在启动、已经结束或正在引导，消息仍在排队" };
  }

  try {
    if (!(await beginDelivery(message.id))) {
      reservation.cancel();
      return { ok: false, status: 409, error: "消息正在投递或已被处理，请稍后查看" };
    }
    await clearPreviousDirectionState(task.id);
    reservation.commit();
    return await delivery;
  } catch (error) {
    reservation.cancel();
    await abortDelivery(message).catch(() => undefined);
    return {
      ok: false,
      status: 500,
      error: `引导会话失败，消息仍在排队：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function mountTaskSteerRoutes(api: Hono): void {
  api.post("/scheduled-messages/:mid/steer", async (c) => {
    const result = await steerQueuedMessage(c.req.param("mid"));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ steered: true, messageId: result.messageId }, 202);
  });
}
