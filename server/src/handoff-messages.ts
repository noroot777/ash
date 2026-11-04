import type { scheduledMessages } from "./db/schema.js";
import { HandoffError, type HandoffMessagePayload } from "./handoff-types.js";
import { id } from "./util.js";

/**
 * 冻结交接载荷里的待发送消息。等前置任务的那几条**此刻**按完成计数求一次「等到了没」
 * (withAfterGates,顺手锁存):前置任务一般不跟着过来,目标机只能读这份事实,读不到源机的
 * 计数。快照读得早、打包又慢,所以放在载荷成形这一刻求,而不是沿用打包前读到的那几行。
 * 这一刻之后前置才完成的,目标机看不到 —— 那条在目标机落成「前置不在本机」,托盘给直接发送。
 */
export async function exportHandoffMessages(messages: (typeof scheduledMessages.$inferSelect)[]): Promise<HandoffMessagePayload[]> {
  const { withAfterGates } = await import("./pending-after.js");
  return (await withAfterGates(messages)).map(exportHandoffMessage);
}

/** 单条映射;交接载荷走上面的 `exportHandoffMessages`(先按完成计数求过)。 */
export function exportHandoffMessage(message: typeof scheduledMessages.$inferSelect): HandoffMessagePayload {
  return {
    text: message.text, attachments: message.attachments, agent: message.agent, model: message.model,
    reasoningEffort: message.reasoningEffort, sessionRole: message.sessionRole,
    origin: message.origin, reviewRun: message.reviewRun, reviewRound: message.reviewRound,
    mode: message.mode, sendAt: message.sendAt, createdAt: message.createdAt, afterTaskId: message.afterTaskId,
    afterDoneAt: message.afterDoneAt,
  };
}

export function validateMessageOrigin(message: HandoffMessagePayload): void {
  if ((message.origin != null && typeof message.origin !== "string")
    || (message.reviewRun != null && typeof message.reviewRun !== "string")
    || (message.reviewRound != null && (!Number.isSafeInteger(message.reviewRound) || message.reviewRound < 1))) {
    throw new HandoffError("message 审查来源非法");
  }
}

export function importMessageOrigin(message: HandoffMessagePayload, notes: string[]) {
  const guarded = message.origin === undefined || message.origin?.startsWith("review-")
    || message.sessionRole === "reviewer" || !!message.reviewRun;
  if (guarded) {
    notes.push("待发送消息的审查来源无法在本机授权，已隔离并将在投递时取消；请重新派审或重新提交消息。");
    return { origin: `review-${message.origin?.startsWith("review-settlement:") ? "settlement" : "answer"}:handoff-${id()}`,
      reviewRun: null, reviewRound: message.reviewRound ?? null };
  }
  return { origin: message.origin ?? null, reviewRun: null, reviewRound: message.reviewRound ?? null };
}
