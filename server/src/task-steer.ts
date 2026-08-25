// 单飞任务的「引导会话」：消息先按普通 queued 规则落库，只有用户在托盘里明确点击后，
// 才受控截断当前回合并把这一条升级为同 CLI 会话的下一回合。它不把单飞任务改造成团队
// 常驻会话，因此 Claude/Codex/其它可恢复 CLI 都保留 detached + 服务重启接管能力。
//
// 最重要的不变量仍与 pending-messages.ts 相同：原话真正落进会话之前，消息始终是
// pending；升级、杀进程、续会话任一步失败，都只归还 delivering_since，绝不把字吞掉。
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { continueTask } from "./orchestrator.js";
import {
  abortDelivery,
  beginDelivery,
  deliveryOptions,
  markSent,
} from "./pending-messages.js";
import { isRunning, steerTask, takeConfirmed } from "./runs.js";
import { now } from "./util.js";

type MessageRow = typeof scheduledMessages.$inferSelect;

export type SteerQueuedMessageResult =
  | { ok: true; taskId: string; messageId: string }
  | { ok: false; status: 404 | 409 | 500; error: string };

async function clearPreviousDirectionState(taskId: string): Promise<void> {
  // 内存快路与 DB 权威标记两边都清。旧方向若刚确认完成、刚 pause/ask，不能让这些事实
  // 穿过受控中断，污染接下来真正要执行的新方向。
  takeConfirmed(taskId);
  const updatedAt = now();
  const current = (await db.select({ question: tasks.question }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  await db
    .update(tasks)
    .set({
      completeConfirmedAt: null,
      resumePrompt: null,
      question: null,
      questionOptions: null,
      questionItems: null,
      updatedAt,
    })
    .where(eq(tasks.id, taskId));
  if (current?.question) {
    bus.publish({
      type: "task.question",
      taskId,
      updatedAt,
      question: null,
      questionOptions: null,
      questionItems: null,
    });
  }
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
        // 旧进程结束和新回合起跑之间再清一次，盖住旧 agent 在被 kill 前最后一拍写入
        // pause_task / ask_question / complete_task 的竞态。
        await clearPreviousDirectionState(message.taskId);
        const started = await continueTask(message.taskId, message.text, {
          ...deliveryOptions(message),
          onDelivered: async () => {
            delivered = true;
            await markSent(message);
            finish({ ok: true, taskId: message.taskId, messageId: message.id });
          },
        });
        if (started && delivered) return;
        await abortDelivery(message);
        finish({
          ok: false,
          status: 409,
          error: started
            ? "新方向未能落进会话，消息已保留在排队中"
            : "当前回合被其它执行抢占，消息已保留在排队中",
        });
      } catch (error) {
        if (!delivered) await abortDelivery(message).catch(() => undefined);
        finish({
          ok: false,
          status: 500,
          error: `引导会话失败，消息仍在排队：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
  });
}

/** 升级一条 queued 消息；导出给回归测试，HTTP 端点只是薄封装。 */
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
  if (!(await beginDelivery(message.id))) {
    return { ok: false, status: 409, error: "消息正在投递或已被处理，请稍后查看" };
  }
  // status=running/queued 覆盖「已占回合、进程还没登记」的启动缝隙；那一格没有 handle
  // 可控，先原样退回队列，不能为了一个注定失败的点击清掉旧回合的完成票/提问/检查点。
  if (!isRunning(task.id)) {
    await abortDelivery(message);
    return { ok: false, status: 409, error: "当前回合正在启动或已经结束，消息仍在排队" };
  }

  try {
    await clearPreviousDirectionState(task.id);
    let resolveDelivery!: (result: SteerQueuedMessageResult) => void;
    const delivery = new Promise<SteerQueuedMessageResult>((resolve) => { resolveDelivery = resolve; });
    const started = steerTask(task.id, () => {
      void deliverSteeredMessage(message).then(resolveDelivery);
    });
    if (!started) {
      await abortDelivery(message);
      return { ok: false, status: 409, error: "当前回合正在启动或已经结束，消息仍在排队" };
    }
    return await delivery;
  } catch (error) {
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
