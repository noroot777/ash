// 单飞任务的「引导会话」：消息默认 queued，只有用户点托盘末尾的唯一动作后，才受控
// 结束当前普通执行回合，并把队首原话送进同一 CLI 会话。它不是团队常驻，也不能截断
// 验证、审查或 CLI 原生命令旁路回合。
//
// 两条硬不变量：① 清旧状态前先预约 steering，数据库失败可撤销；② 原话真正落盘前消息
// 始终 pending，续送失败先把假 running 拉回真实状态，再归还投递租约。
import type { QuestionItem, TaskStatus } from "@ash/shared";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";
import { continueTask } from "./orchestrator.js";
import { abortDelivery, beginDelivery, deliveryOptions, flushPendingForTask, markSent } from "./pending-messages.js";
import {
  isRunning,
  isCanceling,
  isTurnClaimed,
  confirmDone,
  reserveNativeSteerTask,
  reserveSteerTask,
  type NativeSteerReservation,
  type StopSettle,
  takeConfirmed,
  turnRole,
  whenTurnIdle,
} from "./runs.js";
import { setTaskStatus } from "./status.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { id, now } from "./util.js";
import { nativeCliCommand } from "./skills.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { DIRECTION_PROTOCOL } from "./run-prompts.js";

type MessageRow = typeof scheduledMessages.$inferSelect;

interface PreviousDirectionState {
  activeTurnToken: string | null;
  activeDirectionToken: string | null;
  clearedTurnToken: string;
  clearedDirectionToken: string;
  completeConfirmedAt: string | null;
  resumePrompt: string | null;
  question: string | null;
  questionOptions: string | null;
  questionItems: string | null;
  memoryConfirmed: boolean;
}

export type SteerQueuedMessageResult =
  | { ok: true; taskId: string; messageId: string }
  | { ok: false; status: 404 | 409 | 500; error: string };

async function clearPreviousDirectionState(
  taskId: string,
  rotateTurnToken = true,
): Promise<PreviousDirectionState> {
  // 硬切降级先换 token 再 kill；原生 steer 仍是同一个活动 turn，必须保留 token，让同一
  // 进程里后续的 complete_task / ask_question 继续有效。两种路径都清两次内存快路。
  const confirmedBefore = takeConfirmed(taskId);
  const current = (await db
    .select({
      activeTurnToken: tasks.activeTurnToken,
      activeDirectionToken: tasks.activeDirectionToken,
      completeConfirmedAt: tasks.completeConfirmedAt,
      resumePrompt: tasks.resumePrompt,
      question: tasks.question,
      questionOptions: tasks.questionOptions,
      questionItems: tasks.questionItems,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  if (!current) {
    if (confirmedBefore) confirmDone(taskId);
    throw new Error("任务不存在");
  }
  const clearedTurnToken = rotateTurnToken ? id() : current.activeTurnToken;
  const clearedDirectionToken = id();
  if (!clearedTurnToken) {
    if (confirmedBefore) confirmDone(taskId);
    throw new Error("当前回合缺少身份 token，无法原生引导");
  }
  const updatedAt = now();
  let memoryConfirmed = confirmedBefore;
  try {
    const updated = await db
      .update(tasks)
      .set({
        activeTurnToken: clearedTurnToken,
        activeDirectionToken: clearedDirectionToken,
        completeConfirmedAt: null,
        resumePrompt: null,
        question: null,
        questionOptions: null,
        questionItems: null,
        updatedAt,
      })
      .where(and(
        eq(tasks.id, taskId),
        current.activeTurnToken === null
          ? isNull(tasks.activeTurnToken)
          : eq(tasks.activeTurnToken, current.activeTurnToken),
        current.activeDirectionToken === null
          ? isNull(tasks.activeDirectionToken)
          : eq(tasks.activeDirectionToken, current.activeDirectionToken),
        current.completeConfirmedAt === null
          ? isNull(tasks.completeConfirmedAt)
          : eq(tasks.completeConfirmedAt, current.completeConfirmedAt),
        current.resumePrompt === null
          ? isNull(tasks.resumePrompt)
          : eq(tasks.resumePrompt, current.resumePrompt),
        current.question === null ? isNull(tasks.question) : eq(tasks.question, current.question),
        current.questionOptions === null
          ? isNull(tasks.questionOptions)
          : eq(tasks.questionOptions, current.questionOptions),
        current.questionItems === null
          ? isNull(tasks.questionItems)
          : eq(tasks.questionItems, current.questionItems),
      ))
      .returning({ id: tasks.id });
    memoryConfirmed = takeConfirmed(taskId) || memoryConfirmed;
    if (!updated.length) throw new Error("当前回合状态已变化，请重试引导");
  } catch (error) {
    memoryConfirmed = takeConfirmed(taskId) || memoryConfirmed;
    if (memoryConfirmed) confirmDone(taskId);
    throw error;
  }
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
  return { ...current, clearedTurnToken, clearedDirectionToken, memoryConfirmed };
}

async function discardLateDirectionState(taskId: string, turnToken: string, directionToken: string): Promise<void> {
  // 原生请求确认接收前，旧方向已经发出的完成/提问/检查点仍可能刚好落库；成功 ACK 后
  // 再清一遍。此刻新消息还没开始执行，因此不会误删新方向自己产生的状态；turn token
  // 保持不变，方向 token 已在第一次清理时旋转。
  takeConfirmed(taskId);
  const late = (await db
    .select({ question: tasks.question })
    .from(tasks)
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.activeTurnToken, turnToken),
      eq(tasks.activeDirectionToken, directionToken),
    ))).at(0);
  const updatedAt = now();
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
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.activeTurnToken, turnToken),
      eq(tasks.activeDirectionToken, directionToken),
    ));
  takeConfirmed(taskId);
  if (late?.question) {
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
      console.warn(`[ash] 原生引导已清迟到提问，但实时通知失败 ${taskId}:`, error);
    }
  }
}

async function restorePreviousDirectionState(
  taskId: string,
  previous: PreviousDirectionState,
  preserveDirectionBarrier = false,
): Promise<boolean> {
  const updatedAt = now();
  let restored = await db
    .update(tasks)
    .set({
      activeTurnToken: previous.activeTurnToken,
      activeDirectionToken: preserveDirectionBarrier
        ? previous.clearedDirectionToken
        : previous.activeDirectionToken,
      completeConfirmedAt: previous.completeConfirmedAt,
      resumePrompt: previous.resumePrompt,
      question: previous.question,
      questionOptions: previous.questionOptions,
      questionItems: previous.questionItems,
      updatedAt,
    })
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.activeTurnToken, previous.clearedTurnToken),
      eq(tasks.activeDirectionToken, previous.clearedDirectionToken),
      isNull(tasks.completeConfirmedAt),
      isNull(tasks.resumePrompt),
      isNull(tasks.question),
      isNull(tasks.questionOptions),
      isNull(tasks.questionItems),
    ))
    .returning({ id: tasks.id });
  if (!restored.length) {
    // 旧回合可能已按停止/自然结束完成结算：setTaskStatus 会把 token 置 null，但清掉的
    // 方向字段仍全是 null。只在任务已离开运行态且这些字段仍未被新写入时恢复，避免
    // 覆盖停止窗口里新产生的提问、检查点或完成票。
    restored = await db
      .update(tasks)
      .set({
        completeConfirmedAt: previous.completeConfirmedAt,
        resumePrompt: previous.resumePrompt,
        question: previous.question,
        questionOptions: previous.questionOptions,
        questionItems: previous.questionItems,
        updatedAt,
      })
      .where(and(
        eq(tasks.id, taskId),
        isNull(tasks.activeTurnToken),
        ne(tasks.status, "running"),
        ne(tasks.status, "queued"),
        isNull(tasks.completeConfirmedAt),
        isNull(tasks.resumePrompt),
        isNull(tasks.question),
        isNull(tasks.questionOptions),
        isNull(tasks.questionItems),
      ))
      .returning({ id: tasks.id });
  }
  if (!restored.length) return false;
  if (previous.memoryConfirmed) confirmDone(taskId);
  if (previous.question) {
    try {
      bus.publish({
        type: "task.question",
        taskId,
        updatedAt,
        question: previous.question,
        questionOptions: previous.questionOptions
          ? JSON.parse(previous.questionOptions) as string[]
          : null,
        questionItems: previous.questionItems
          ? JSON.parse(previous.questionItems) as QuestionItem[]
          : null,
      });
    } catch (error) {
      console.warn(`[ash] 引导会话已恢复提问，但实时通知失败 ${taskId}:`, error);
    }
  }
  return true;
}

async function restorePreviousCompletionState(
  taskId: string,
  previous: PreviousDirectionState,
): Promise<void> {
  if (!previous.completeConfirmedAt && !previous.memoryConfirmed) return;
  const restored = await db
    .update(tasks)
    .set({ completeConfirmedAt: previous.completeConfirmedAt, updatedAt: now() })
    .where(and(
      eq(tasks.id, taskId),
      isNull(tasks.activeTurnToken),
      isNull(tasks.completeConfirmedAt),
      previous.resumePrompt === null
        ? isNull(tasks.resumePrompt)
        : eq(tasks.resumePrompt, previous.resumePrompt),
      previous.question === null ? isNull(tasks.question) : eq(tasks.question, previous.question),
      previous.questionOptions === null
        ? isNull(tasks.questionOptions)
        : eq(tasks.questionOptions, previous.questionOptions),
      previous.questionItems === null
        ? isNull(tasks.questionItems)
        : eq(tasks.questionItems, previous.questionItems),
    ))
    .returning({ id: tasks.id });
  if (restored.length && previous.memoryConfirmed) confirmDone(taskId);
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

type NativeReservation = Extract<NativeSteerReservation, { kind: "native" }>;

function nativeMessageCanSteer(message: MessageRow, agentType: Parameters<typeof nativeCliCommand>[0]): boolean {
  let attachments: unknown[] = [];
  try { attachments = JSON.parse(message.attachments) as unknown[]; } catch { return false; }
  return attachments.length === 0
    && !message.agent
    && !message.executorId
    && !message.model
    && !message.reasoningEffort
    && !message.sessionRole
    && !nativeCliCommand(agentType, message.text);
}

async function deliverNativeSteer(
  message: MessageRow,
  reservation: NativeReservation,
): Promise<SteerQueuedMessageResult> {
  let previous: PreviousDirectionState | null = null;
  let delivered = false;
  try {
    if (!(await beginDelivery(message.id))) {
      reservation.cancel();
      return { ok: false, status: 409, error: "消息正在投递或已被处理，请稍后查看" };
    }
    previous = await clearPreviousDirectionState(message.taskId, false);
    await reservation.deliver(message.text, now(), {
      promptText: message.text + DIRECTION_PROTOCOL(previous.clearedDirectionToken),
      beforeSend: reservation.agentType === "claude"
        ? () => discardLateDirectionState(
            message.taskId,
            previous!.activeTurnToken!,
            previous!.clearedDirectionToken,
          )
        : undefined,
    });
    delivered = true;
    await markSent(message);
    return { ok: true, taskId: message.taskId, messageId: message.id };
  } catch (error) {
    const restarted = (error as { nativeSteerRestart?: boolean })?.nativeSteerRestart === true;
    if (!delivered) {
      if (previous) await restorePreviousDirectionState(message.taskId, previous, restarted).catch(() => undefined);
      await abortDelivery(message).catch(() => undefined);
      if (restarted) {
        await appendTaskTimeline(
          message.taskId,
          "Claude 未确认原生引导，已结束当前回合；这条排队消息会由新回合重新投递。",
        );
        whenTurnIdle(message.taskId, () => flushPendingForTask(message.taskId));
      }
    } else {
      // provider 已经接收，不能把原话退回队列再投一次；尽力把 sent 记账补齐。
      await markSent(message).catch(() => undefined);
    }
    return {
      ok: false,
      status: isCanceling(message.taskId) ? 409 : 500,
      error: restarted
        ? `原生引导失败，已结束当前回合；消息将由新回合重新投递：${error instanceof Error ? error.message : String(error)}`
        : delivered
        ? `新方向已送达，但清理或记账失败：${error instanceof Error ? error.message : String(error)}`
        : `引导会话失败，消息仍在排队：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    reservation.cancel();
  }
}

async function finishStoppedSteer(
  message: MessageRow,
  stopped: StopSettle,
  needsSettlement: boolean,
  previous: PreviousDirectionState | null,
): Promise<SteerQueuedMessageResult> {
  try {
    if (previous) await restorePreviousDirectionState(message.taskId, previous);
    if (needsSettlement) {
      const { settleTaskStatus, afterSettlement } = await import("./single-run.js");
      const settled = await settleTaskStatus(message.taskId, 1, stopped);
      const { clearTurnStart } = await import("./turn-output.js");
      clearTurnStart(message.taskId);
      await reconcileTurnBaseline(message.taskId, settled.confirmedDone);
      if (!settled.nativeTurn) {
        await afterSettlement(message.taskId, settled.status, settled.confirmedDone, false);
      }
      await appendTaskTimeline(
        message.taskId,
        stopped === "paused"
          ? "分组暂停发生在引导收尾期间：引导已取消，任务已暂停，排队消息仍保留。"
          : "手动停止发生在引导收尾期间：引导已取消，停止已落账，排队消息仍保留。",
      );
    }
    if (previous) await restorePreviousCompletionState(message.taskId, previous);
    // 停止结算会触发一次“任务空闲，扫描排队消息”；租约必须一直持有到结算完成，
    // 否则扫描会在停止刚落库时把同一条消息重新抢走，看起来仍像停止被吞了。
    await abortDelivery(message);
    return {
      ok: false,
      status: 409,
      error: stopped === "paused"
        ? "所在分组正在暂停，引导已取消，消息继续排队"
        : "任务正在停止，引导已取消，消息继续排队",
    };
  } catch (error) {
    await abortDelivery(message).catch(() => undefined);
    return {
      ok: false,
      status: 500,
      error: `停止已优先于引导，但清理排队消息失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  if (isCanceling(task.id)) {
    const error = "任务正在停止或所在分组正在暂停，消息继续排队";
    await appendTaskTimeline(task.id, `引导会话未执行：${error}`);
    return { ok: false, status: 409, error };
  }
  if (isAcceptingTask(task.id)) {
    return { ok: false, status: 409, error: "任务正在验收，引导未执行，消息继续排队" };
  }

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

  const native = reserveNativeSteerTask(task.id);
  if (native.kind === "busy") {
    return { ok: false, status: 409, error: "当前原生引导正在启动、投递或停止，消息仍在排队" };
  }
  if (native.kind === "native") {
    if (nativeMessageCanSteer(message, native.agentType)) return deliverNativeSteer(message, native);
    native.cancel();
  }

  let resolveDelivery!: (result: SteerQueuedMessageResult) => void;
  const delivery = new Promise<SteerQueuedMessageResult>((resolve) => { resolveDelivery = resolve; });
  let previousDirectionState: PreviousDirectionState | null = null;
  const reservation = reserveSteerTask(task.id, (outcome) => {
    const result = outcome.stopped
      ? finishStoppedSteer(message, outcome.stopped, outcome.needsSettlement, previousDirectionState)
      : deliverSteeredMessage(message);
    void result.then(resolveDelivery);
  });
  if (!reservation) {
    return { ok: false, status: 409, error: "当前回合正在启动、已经结束或正在引导，消息仍在排队" };
  }

  try {
    if (!(await beginDelivery(message.id))) {
      reservation.cancel();
      return { ok: false, status: 409, error: "消息正在投递或已被处理，请稍后查看" };
    }
    previousDirectionState = await clearPreviousDirectionState(task.id);
    const committed = reservation.commit();
    if (committed !== "committed") {
      if (committed === "lost") await recoverUndeliveredSteer(task.id);
      await restorePreviousDirectionState(task.id, previousDirectionState);
      await abortDelivery(message);
      return {
        ok: false,
        status: 409,
        error: committed === "stopping"
          ? "任务正在停止或所在分组正在暂停，引导已取消，消息继续排队"
          : "当前回合已在引导提交前结束，消息继续排队",
      };
    }
    return await delivery;
  } catch (error) {
    if (previousDirectionState) {
      await restorePreviousDirectionState(task.id, previousDirectionState).catch(() => undefined);
    }
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
